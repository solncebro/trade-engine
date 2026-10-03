import { EventEmitter } from 'events';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import admin from 'firebase-admin';

import type {
  FirebaseConnectionLostReason,
  FirebaseMapLocation,
  FirebaseServiceBaseArgs,
  FirebaseSnapshotDiskCopy,
} from './firebaseServiceBase.types';

import { logger } from '../core/logger';
import { Notifiable } from '../types/common';
import {
  FirebaseStrategySettingsValues,
  FormatSettingMessageArgs,
  SettingChange,
} from '../types/firebase';
import { SettingConfigBase } from '../types/telegramCommandHandler';
import { createDate } from '../utils/date.utils';
import { startIntervalScheduler } from '../utils/intervalScheduler';
import type { IntervalSchedulerHandle } from '../utils/intervalScheduler';
import { buildNestedPartial, setNestedField } from '../utils/nestedField';
import { withTimeout } from '../utils/timeout';

function flattenForFirestoreUpdate(value: unknown, prefix = ''): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    if (prefix) {
      result[prefix] = value;
    }

    return result;
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
      Object.assign(result, flattenForFirestoreUpdate(nested, path));
    } else {
      result[path] = nested;
    }
  }

  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Returns a partial of `defaults` holding only the keys (recursively) that are
 * absent from `stored`. Keys already present in `stored` are never included, so
 * an update built from this result backfills missing defaults without ever
 * overwriting values the user already has.
 */
function collectMissingDefaults(
  defaults: Record<string, unknown>,
  stored: Record<string, unknown>,
  wholeMapFieldList: readonly string[] = [],
  pathPrefix = '',
): Record<string, unknown> {
  const missing: Record<string, unknown> = {};

  for (const [key, defaultValue] of Object.entries(defaults)) {
    const storedValue = stored[key];
    const path = `${pathPrefix}${key}`;

    if (storedValue === undefined) {
      missing[key] = defaultValue;

      continue;
    }

    if (isPlainObject(defaultValue) && isPlainObject(storedValue) && !wholeMapFieldList.includes(path)) {
      const nestedMissing = collectMissingDefaults(defaultValue, storedValue, wholeMapFieldList, `${path}.`);

      if (Object.keys(nestedMissing).length > 0) {
        missing[key] = nestedMissing;
      }
    }
  }

  return missing;
}

export type { FirebaseServiceBaseArgs } from './firebaseServiceBase.types';

export const FIREBASE_SERVICE_EVENT = {
  DataChanged: 'dataChanged',
  ConnectionLost: 'connectionLost',
  ConnectionRestored: 'connectionRestored',
  SnapshotDiverged: 'snapshotDiverged',
  StartedFromDiskCopy: 'startedFromDiskCopy',
} as const;

const DEFAULT_RESUBSCRIBE_INITIAL_DELAY_MS = 1_000;
const DEFAULT_RESUBSCRIBE_MAX_DELAY_MS = 60_000;
const DEFAULT_CONNECTION_RETRY_INTERVAL_MS = 30_000;
const DEFAULT_INITIAL_READ_TIMEOUT_MS = 30_000;
const DEFAULT_PENDING_WRITE_MAX_AGE_MS = 15_000;

interface PendingWrite {
  segmentList: string[];
  value: unknown;
  writtenAtMs: number;
}

interface ResolvedMapLocation {
  documentReference: admin.firestore.DocumentReference;
  fieldSegmentList: string[];
}

/** JSON with object keys sorted at every level — two copies of one document compare equal whatever
 *  order Firestore or the app happened to put the keys in (port of ma-chaser `sortKeysDeep`). */
function toStableJson(value: unknown): string {
  const sortKeysDeep = (item: unknown): unknown => {
    if (Array.isArray(item)) {
      return item.map(sortKeysDeep);
    }

    if (isPlainObject(item)) {
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, sortKeysDeep(item[key])]));
    }

    return item;
  };

  return JSON.stringify(sortKeysDeep(value)) ?? 'undefined';
}

function readNestedValue(source: unknown, segmentList: string[]): unknown {
  let current: unknown = source;

  for (const segment of segmentList) {
    if (!isPlainObject(current)) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
}

export class FirebaseServiceBase<T> extends EventEmitter implements Notifiable {
  private firestore: admin.firestore.Firestore;
  private documentReference: admin.firestore.DocumentReference;
  private settingsListener: (() => void) | null = null;
  private currentData: T;
  private defaultData: T;
  private readonly wholeMapFieldList: readonly string[];
  private readonly documentPath: string;
  private readonly resubscribeInitialDelayMs: number;
  private readonly resubscribeMaxDelayMs: number;
  private readonly snapshotWatchdogIntervalMs: number | null;
  private readonly snapshotCacheFilePath: string | null;
  private readonly connectionRetryIntervalMs: number;
  private readonly initialReadTimeoutMs: number;
  private readonly isWriteVisibleImmediately: boolean;
  private readonly pendingWriteMaxAgeMs: number;
  private readonly pendingWriteByPath: Map<string, PendingWrite> = new Map();
  private resubscribeAttemptCount = 0;
  private resubscribeTimer: NodeJS.Timeout | null = null;
  private connectionRetryTimer: NodeJS.Timeout | null = null;
  private snapshotWatchdogHandle: IntervalSchedulerHandle | null = null;
  private isConnectedFlag = true;
  private isSnapshotDivergenceNotified = false;
  private isDisconnected = false;
  private lastDiskCopyJson: string | null = null;
  public onNotify: Notifiable['onNotify'];
  public onError: Notifiable['onError'];

  constructor(args: FirebaseServiceBaseArgs<T>) {
    super();

    const { documentPath, defaultData, telegramNotifier } = args;

    this.documentPath = documentPath;
    this.defaultData = defaultData;
    this.wholeMapFieldList = args.wholeMapFieldList ?? [];
    this.currentData = { ...defaultData };
    this.onNotify = args.onNotify
      ?? (telegramNotifier === undefined
        ? (message: string): void => {
            logger.info(`[Firebase] ${message}`);
          }
        : telegramNotifier.sendFormattedMessage.bind(telegramNotifier));
    this.onError = args.onError
      ?? (telegramNotifier === undefined
        ? (customMessage: string, error: unknown): void => {
            logger.error({ error }, `[Firebase] ${customMessage}`);
          }
        : telegramNotifier.sendError.bind(telegramNotifier));
    this.resubscribeInitialDelayMs = args.resubscribeInitialDelayMs ?? DEFAULT_RESUBSCRIBE_INITIAL_DELAY_MS;
    this.resubscribeMaxDelayMs = args.resubscribeMaxDelayMs ?? DEFAULT_RESUBSCRIBE_MAX_DELAY_MS;
    this.snapshotWatchdogIntervalMs = args.snapshotWatchdogIntervalMs ?? null;
    this.snapshotCacheFilePath = args.snapshotCacheFilePath ?? null;
    this.connectionRetryIntervalMs = args.connectionRetryIntervalMs ?? DEFAULT_CONNECTION_RETRY_INTERVAL_MS;
    this.initialReadTimeoutMs = args.initialReadTimeoutMs ?? DEFAULT_INITIAL_READ_TIMEOUT_MS;
    this.isWriteVisibleImmediately = args.isWriteVisibleImmediately ?? true;
    this.pendingWriteMaxAgeMs = args.pendingWriteMaxAgeMs ?? DEFAULT_PENDING_WRITE_MAX_AGE_MS;

    if (!admin.apps.length) {
      const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;

      // Prefer a service-account JSON file when FIREBASE_SERVICE_ACCOUNT_PATH is set;
      // otherwise fall back to the discrete FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY vars.
      const credential = serviceAccountPath
        ? admin.credential.cert(serviceAccountPath)
        : admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
          });

      admin.initializeApp({ credential });
    }

    this.firestore = admin.firestore();
    this.documentReference = this.firestore.doc(documentPath);
  }

  public async initialize(): Promise<void> {
    try {
      await this.loadAndSubscribe();
    } catch (error) {
      const diskCopy = await this.readDiskCopy();

      if (diskCopy === null) {
        await this.onError('Failed to initialize Firebase service', error);

        throw error;
      }

      // Firestore is unreachable but the last good copy is on disk: start on it instead of refusing
      // to start, say so loudly, and keep knocking until Firestore answers.
      this.updateCurrentData(diskCopy.data as Partial<T>);
      this.isConnectedFlag = false;
      this.emit(FIREBASE_SERVICE_EVENT.StartedFromDiskCopy, { savedAtMs: diskCopy.savedAtMs, error });
      this.emit(FIREBASE_SERVICE_EVENT.ConnectionLost, { reason: 'initialReadFailed', error });
      this.safeNotifyError(`Firestore unreachable at startup — running on the local copy saved at ${createDate(diskCopy.savedAtMs).toISOString()}, retrying every ${Math.round(this.connectionRetryIntervalMs / 1000)}s`, error);
      this.scheduleConnectionRetry();

      return;
    }

    this.startSnapshotWatchdog();
  }

  /** False while the live subscription is broken or the service runs on its disk copy. */
  public isConnected(): boolean {
    return this.isConnectedFlag;
  }

  private async loadAndSubscribe(): Promise<void> {
    const document = this.snapshotCacheFilePath === null
      ? await this.documentReference.get()
      : await withTimeout(this.documentReference.get(), this.initialReadTimeoutMs, `Firestore read of ${this.documentPath} exceeded ${this.initialReadTimeoutMs}ms`);

    if (document.exists) {
      const data = document.data() as T;

      // Backfill only the default keys missing from the stored document via a
      // dot-notation update — existing values are never overwritten.
      const missingDefaults = collectMissingDefaults(
        this.defaultData as Record<string, unknown>,
        data as Record<string, unknown>,
        this.wholeMapFieldList,
      );
      const flatMissingDefaults = flattenForFirestoreUpdate(missingDefaults);

      if (Object.keys(flatMissingDefaults).length > 0) {
        await this.documentReference.update(flatMissingDefaults);
        await this.onNotify('Backfilled missing default keys in Firebase');
      }

      this.updateCurrentData(data);
    } else {
      // Persist the defaults so the document exists from now on — subsequent
      // runs load real data instead of silently falling back to defaults again.
      await this.documentReference.set(this.defaultData as admin.firestore.DocumentData);
      await this.onNotify('No data found in Firebase — created document with defaults');
    }

    await this.writeDiskCopy();
    this.subscribeToDataChanges();
  }

  private scheduleConnectionRetry(): void {
    if (this.isDisconnected) {
      return;
    }

    this.connectionRetryTimer = setTimeout(() => {
      this.connectionRetryTimer = null;
      void this.retryConnection();
    }, this.connectionRetryIntervalMs);
    this.connectionRetryTimer.unref();
  }

  private async retryConnection(): Promise<void> {
    const previousData = this.currentData;

    try {
      await this.loadAndSubscribe();
    } catch (error: unknown) {
      logger.warn({ error, documentPath: this.documentPath }, '[Firebase] Still unreachable — staying on the disk copy');
      this.scheduleConnectionRetry();

      return;
    }

    this.markConnectionRestored();

    if (toStableJson(previousData) !== toStableJson(this.currentData)) {
      this.emit(FIREBASE_SERVICE_EVENT.DataChanged, { current: this.currentData, previous: previousData });
    }

    this.startSnapshotWatchdog();
  }

  private subscribeToDataChanges(): void {
    if (this.settingsListener) {
      this.settingsListener();
      this.settingsListener = null;
    }

    this.settingsListener = this.documentReference.onSnapshot(
      document => {
        this.handleSnapshot(document);
      },
      error => {
        this.handleListenerError(error);
      },
    );
  }

  private handleSnapshot(document: admin.firestore.DocumentSnapshot): void {
    this.resubscribeAttemptCount = 0;
    this.markConnectionRestored();

    if (document.exists) {
      const data = document.data() as T;
      const previousData = { ...this.currentData };
      this.updateCurrentData(data);
      // Before the event: its handlers must already see a pending patch cleared of what this
      // snapshot confirmed.
      this.dropConfirmedPendingWrites();
      void this.writeDiskCopy();

      logger.info(
        {
          previous: previousData,
          current: this.currentData,
        },
        'Data updated from Firebase'
      );

      this.emit(FIREBASE_SERVICE_EVENT.DataChanged, {
        current: this.currentData,
        previous: previousData,
      });
    }
  }

  // Firestore calls the error callback once and never again: the subscription is dead from here on.
  // Before 3.25 nothing re-opened it and the app ran on frozen settings until a restart.
  private handleListenerError(error: Error): void {
    this.settingsListener = null;
    this.markConnectionLost('listenerError', error);

    if (this.isDisconnected || this.resubscribeTimer !== null) {
      return;
    }

    const delayMs = Math.min(this.resubscribeInitialDelayMs * 2 ** this.resubscribeAttemptCount, this.resubscribeMaxDelayMs);
    this.resubscribeAttemptCount += 1;

    logger.warn({ error, delayMs, attempt: this.resubscribeAttemptCount }, `[Firebase] Live subscription to ${this.documentPath} failed — resubscribing in ${delayMs}ms`);

    this.resubscribeTimer = setTimeout(() => {
      this.resubscribeTimer = null;

      try {
        this.subscribeToDataChanges();
      } catch (subscribeError: unknown) {
        this.handleListenerError(subscribeError instanceof Error ? subscribeError : new Error(String(subscribeError)));
      }
    }, delayMs);
    this.resubscribeTimer.unref();
  }

  private markConnectionLost(reason: FirebaseConnectionLostReason, error: unknown): void {
    if (!this.isConnectedFlag) {
      return;
    }

    this.isConnectedFlag = false;
    this.emit(FIREBASE_SERVICE_EVENT.ConnectionLost, { reason, error });
    this.safeNotifyError(`Firebase connection lost (${reason}) — retrying`, error);
  }

  private markConnectionRestored(): void {
    if (this.isConnectedFlag) {
      return;
    }

    this.isConnectedFlag = true;
    this.emit(FIREBASE_SERVICE_EVENT.ConnectionRestored);
    this.safeNotify('Firebase connection restored');
  }

  private startSnapshotWatchdog(): void {
    if (this.snapshotWatchdogIntervalMs === null || this.snapshotWatchdogHandle !== null || this.isDisconnected) {
      return;
    }

    this.snapshotWatchdogHandle = startIntervalScheduler({
      tickHandler: () => this.checkSnapshotFreshness(),
      intervalMs: this.snapshotWatchdogIntervalMs,
      contextLabel: '[Firebase] Snapshot watchdog iteration failed',
    });
  }

  /**
   * Re-read the document and compare it with the in-memory copy (ported from ma-chaser's snapshot
   * watchdog). ma-chaser only alerted and asked for a restart; like kliner's listener watchdog, this
   * one repairs the copy on the spot — and re-opens the subscription, since a silent divergence means
   * the live one is most likely dead. A change landing between the read and its own snapshot can look
   * like a divergence once; the repair is then a harmless early copy of the same data.
   */
  public async checkSnapshotFreshness(): Promise<void> {
    let document: admin.firestore.DocumentSnapshot;

    try {
      document = await this.documentReference.get();
    } catch (error: unknown) {
      this.markConnectionLost('watchdogReadFailed', error);

      return;
    }

    this.markConnectionRestored();

    if (!document.exists) {
      logger.warn({ documentPath: this.documentPath }, '[Firebase] Snapshot watchdog — document missing');

      return;
    }

    const freshData = document.data() as Partial<T>;
    const freshMerged = { ...this.defaultData, ...freshData } as T;
    const cachedData = this.currentData;

    if (toStableJson(freshMerged) === toStableJson(cachedData)) {
      if (this.isSnapshotDivergenceNotified) {
        this.isSnapshotDivergenceNotified = false;
        logger.info('[Firebase] Snapshot watchdog — cache recovered, divergence alert re-armed');
      }

      return;
    }

    const divergentKeyList = [...new Set([...Object.keys(freshMerged as object), ...Object.keys(cachedData as object)])]
      .filter(key => toStableJson((freshMerged as Record<string, unknown>)[key]) !== toStableJson((cachedData as Record<string, unknown>)[key]))
      .sort();

    logger.warn({ divergentKeyList, documentPath: this.documentPath }, '[Firebase] Snapshot watchdog — CACHE DIVERGED from Firestore; repairing the cache and resubscribing');

    this.updateCurrentData(freshData);
    this.dropConfirmedPendingWrites();
    await this.writeDiskCopy();
    this.emit(FIREBASE_SERVICE_EVENT.DataChanged, { current: this.currentData, previous: cachedData });
    this.emit(FIREBASE_SERVICE_EVENT.SnapshotDiverged, { divergentKeyList, current: this.currentData, previous: cachedData });

    try {
      this.subscribeToDataChanges();
    } catch (error: unknown) {
      this.handleListenerError(error instanceof Error ? error : new Error(String(error)));
    }

    // One notice per divergence episode: a persistent divergence must not spam the chat every tick.
    if (!this.isSnapshotDivergenceNotified) {
      this.isSnapshotDivergenceNotified = true;
      this.safeNotify(`⚠️ Firebase settings cache diverged from Firestore on: ${divergentKeyList.join(', ')}. Cache repaired and live subscription re-opened.`);
    }
  }

  private updateCurrentData(data: Partial<T>): void {
    this.currentData = { ...this.defaultData, ...data };
  }

  public getData(): T {
    if (this.pendingWriteByPath.size === 0) {
      return this.currentData;
    }

    this.dropExpiredPendingWrites(Date.now());

    let result = this.currentData;

    for (const pendingWrite of this.pendingWriteByPath.values()) {
      result = setNestedField(result, pendingWrite.segmentList, pendingWrite.value);
    }

    return result;
  }

  public async updateData(data: Partial<T>): Promise<void> {
    try {
      const flatData = flattenForFirestoreUpdate(data);

      await this.documentReference.update(flatData);

      logger.info({ data: flatData }, 'Updated data in Firebase');

      // Only a CONFIRMED write joins the pending patch: a rejected one must leave the old value showing.
      this.rememberPendingWrites(flatData);
    } catch (error) {
      logger.error({ error, data }, 'Failed to update data in Firebase');

      throw error;
    }
  }

  // Keyed by the same dot path Firestore's update used, so nested settings merge exactly like the
  // stored document will once the echo lands. Sentinels (FieldValue.delete() etc.) are not values.
  private rememberPendingWrites(flatData: Record<string, unknown>): void {
    if (!this.isWriteVisibleImmediately) {
      return;
    }

    const writtenAtMs = Date.now();

    for (const [path, value] of Object.entries(flatData)) {
      if (value instanceof admin.firestore.FieldValue) {
        this.pendingWriteByPath.delete(path);

        continue;
      }

      const segmentList = path.split('.');

      // The echo can land BEFORE the write resolves; then the stored copy already holds the value.
      if (toStableJson(readNestedValue(this.currentData, segmentList)) === toStableJson(value)) {
        this.pendingWriteByPath.delete(path);

        continue;
      }

      this.pendingWriteByPath.set(path, { segmentList, value, writtenAtMs });
    }
  }

  // A key leaves the patch as soon as a snapshot carries the same value — or, failing that, after
  // `pendingWriteMaxAgeMs`: the echo can land BEFORE the write resolves, and a key that never meets
  // its own echo must not hide a later change made elsewhere until the next restart.
  private dropConfirmedPendingWrites(): void {
    for (const [path, pendingWrite] of this.pendingWriteByPath) {
      if (toStableJson(readNestedValue(this.currentData, pendingWrite.segmentList)) === toStableJson(pendingWrite.value)) {
        this.pendingWriteByPath.delete(path);
      }
    }
  }

  private dropExpiredPendingWrites(nowMs: number): void {
    for (const [path, pendingWrite] of this.pendingWriteByPath) {
      if (nowMs - pendingWrite.writtenAtMs > this.pendingWriteMaxAgeMs) {
        this.pendingWriteByPath.delete(path);
      }
    }
  }

  /**
   * A document NEXT TO this one (same collection), for state the app keeps between restarts that has
   * no business on the settings screen — ported from rubber's FirebaseService. Null when absent.
   */
  public async readSiblingDocument(name: string): Promise<Record<string, unknown> | null> {
    const snapshot = await this.documentReference.parent.doc(name).get();

    return snapshot.exists ? (snapshot.data() ?? null) : null;
  }

  /** Merge-write into a sibling document (created when missing). */
  public async writeSiblingDocument(name: string, data: Record<string, unknown>): Promise<void> {
    await this.documentReference.parent.doc(name).set(data, { merge: true });
  }

  /**
   * Put (or wholly replace) one item of a map of items — ported from ma-chaser's saveChaser. Only that
   * item's field is written, the other items stay untouched; a missing sibling document is created.
   */
  public async setMapItem<V>(location: FirebaseMapLocation, itemId: string, value: V): Promise<void> {
    const { documentReference, fieldSegmentList } = this.resolveMapLocation(location);
    const itemSegmentList = [...fieldSegmentList, itemId];

    try {
      await documentReference.set(buildNestedPartial(itemSegmentList, value), {
        mergeFields: [new admin.firestore.FieldPath(...itemSegmentList)],
      });
    } catch (error) {
      logger.error({ error, itemId, documentPath: documentReference.path }, '[Firebase] Failed to set map item');

      throw error;
    }
  }

  /** Change some fields of one item by field path (ma-chaser's updateChaser); the item must exist. */
  public async updateMapItem(location: FirebaseMapLocation, itemId: string, partial: Record<string, unknown>): Promise<void> {
    const entryList = Object.entries(partial);

    if (entryList.length === 0) {
      return;
    }

    const { documentReference, fieldSegmentList } = this.resolveMapLocation(location);
    // A FieldPath per field, never a dotted string: an item id with a dot in it would otherwise be
    // split into a nested path.
    const pathValueList = entryList.flatMap(([key, value]) => [new admin.firestore.FieldPath(...fieldSegmentList, itemId, key), value]);
    const [firstPath, firstValue, ...restPathValueList] = pathValueList;

    try {
      await documentReference.update(firstPath as admin.firestore.FieldPath, firstValue, ...restPathValueList);
    } catch (error) {
      logger.error({ error, itemId, documentPath: documentReference.path }, '[Firebase] Failed to update map item');

      throw error;
    }
  }

  /** Delete one item from the map (ma-chaser's removeChaser). */
  public async removeMapItem(location: FirebaseMapLocation, itemId: string): Promise<void> {
    const { documentReference, fieldSegmentList } = this.resolveMapLocation(location);

    try {
      await documentReference.update(new admin.firestore.FieldPath(...fieldSegmentList, itemId), admin.firestore.FieldValue.delete());
    } catch (error) {
      logger.error({ error, itemId, documentPath: documentReference.path }, '[Firebase] Failed to remove map item');

      throw error;
    }
  }

  private resolveMapLocation(location: FirebaseMapLocation): ResolvedMapLocation {
    if (typeof location === 'string') {
      return { documentReference: this.documentReference, fieldSegmentList: location.split('.') };
    }

    return {
      documentReference: this.documentReference.parent.doc(location.siblingDocumentName),
      fieldSegmentList: location.mapField === undefined ? [] : location.mapField.split('.'),
    };
  }

  private async readDiskCopy(): Promise<FirebaseSnapshotDiskCopy | null> {
    if (this.snapshotCacheFilePath === null) {
      return null;
    }

    try {
      const parsed = JSON.parse(await fs.readFile(this.snapshotCacheFilePath, 'utf8')) as Partial<FirebaseSnapshotDiskCopy>;

      // A copy of ANOTHER document (a reused path, a renamed exchange) must never pose as this one.
      if (parsed.documentPath !== this.documentPath || typeof parsed.savedAtMs !== 'number' || !isPlainObject(parsed.data)) {
        logger.warn({ filePath: this.snapshotCacheFilePath, documentPath: parsed.documentPath }, '[Firebase] Disk copy is not a copy of this document — ignoring it');

        return null;
      }

      return { documentPath: parsed.documentPath, savedAtMs: parsed.savedAtMs, data: parsed.data };
    } catch (error: unknown) {
      logger.warn({ error, filePath: this.snapshotCacheFilePath }, '[Firebase] No usable disk copy of the settings');

      return null;
    }
  }

  // Temp file + rename: a crash mid-write leaves the previous good copy, never a torn one.
  private async writeDiskCopy(): Promise<void> {
    if (this.snapshotCacheFilePath === null) {
      return;
    }

    const dataJson = toStableJson(this.currentData);

    if (dataJson === this.lastDiskCopyJson) {
      return;
    }

    const diskCopy: FirebaseSnapshotDiskCopy = { documentPath: this.documentPath, savedAtMs: Date.now(), data: this.currentData };
    const tempFilePath = `${this.snapshotCacheFilePath}.tmp`;

    try {
      await fs.mkdir(path.dirname(this.snapshotCacheFilePath), { recursive: true });
      await fs.writeFile(tempFilePath, JSON.stringify(diskCopy), 'utf8');
      await fs.rename(tempFilePath, this.snapshotCacheFilePath);
      this.lastDiskCopyJson = dataJson;
    } catch (error: unknown) {
      logger.error({ error, filePath: this.snapshotCacheFilePath }, '[Firebase] Failed to save the disk copy of the settings');
    }
  }

  // A failed notice (Telegram down) must never break the connection handling that sent it.
  private safeNotify(message: string): void {
    Promise.resolve()
      .then(() => this.onNotify(message))
      .catch((error: unknown) => {
        logger.error({ error }, `[Firebase] Failed to deliver notice: ${message}`);
      });
  }

  private safeNotifyError(message: string, error: unknown): void {
    Promise.resolve()
      .then(() => this.onError(message, error))
      .catch((notifyError: unknown) => {
        logger.error({ error: notifyError }, `[Firebase] Failed to deliver error notice: ${message}`);
      });
  }

  public getDocumentReference(): admin.firestore.DocumentReference {
    return this.documentReference;
  }

  public getFirestore(): admin.firestore.Firestore {
    return this.firestore;
  }

  public getChangedSettings(
    current: T,
    previous: T
  ): SettingChange<T[keyof T]>[] {
    const resultList: SettingChange<T[keyof T]>[] = [];

    for (const key in current) {
      if (!Object.prototype.hasOwnProperty.call(current, key)) {
        continue;
      }

      const currentValue = current[key];
      const previousValue = previous[key];

      const isChanged =
        Array.isArray(currentValue) && Array.isArray(previousValue)
          ? JSON.stringify(currentValue) !== JSON.stringify(previousValue)
          : currentValue !== previousValue;

      resultList.push({
        key,
        current: currentValue,
        previous: previousValue,
        isChanged,
      });
    }

    return resultList;
  }

  protected getAddedAndRemovedItemsMessage<Item>(
    current: Item[],
    previous: Item[]
  ): string {
    const setCurrent = new Set(current);
    const setPrevious = new Set(previous);

    const currentDifferenceList = current.filter(item => !setPrevious.has(item));
    const previousDifferenceList = previous.filter(item => !setCurrent.has(item));

    const addedItems =
      currentDifferenceList.length > 0
        ? `Added: ${currentDifferenceList.join(', ')}`
        : '';
    const removedItems =
      previousDifferenceList.length > 0
        ? `Removed: ${previousDifferenceList.join(', ')}`
        : '';

    return `${addedItems}${addedItems && removedItems ? '; ' : ''}${removedItems}`;
  }

  private getConfigByKey<T extends SettingConfigBase>(
    key: string,
    configList: T[]
  ): T | null {
    const foundConfig = configList.find(configItem => configItem.key === key);

    return foundConfig ?? null;
  }

  protected formatSettingMessage<V extends FirebaseStrategySettingsValues>(
    args: FormatSettingMessageArgs<V>
  ): string {
    const { setting, booleanConfigList, numericConfigList, arrayConfigList } =
      args;
    const { key, current, previous, isChanged } = setting;

    if (typeof current === 'boolean' && typeof previous === 'boolean') {
      const config = this.getConfigByKey(key, booleanConfigList);

      let emoji: string;

      if (config) {
        emoji = current ? config.enabledEmoji : config.disabledEmoji;
      } else {
        emoji = current ? '✅' : '❌';
      }

      const label = config?.label ?? (key as string);
      const currentText = current ? 'YES' : 'NO';

      let previousText: string | null = null;

      if (isChanged) {
        previousText = previous ? 'YES' : 'NO';
      }

      const changeText = previousText ? ` (was: ${previousText})` : '';

      return `${label}: ${emoji} *${currentText}*${changeText}`;
    }

    if (typeof current === 'number' && typeof previous === 'number') {
      const config = this.getConfigByKey(key, numericConfigList);
      const suffix = config?.suffix ?? '';
      const label = config?.label ?? (key as string);
      const changeText = isChanged ? ` (was: ${previous}${suffix})` : '';

      return `${label}: *${current}${suffix}*${changeText}`;
    }

    if (Array.isArray(current) && Array.isArray(previous)) {
      const config = this.getConfigByKey(key, arrayConfigList);
      const label = config?.label ?? (key as string);
      const changeInfo = isChanged
        ? ` (${this.getAddedAndRemovedItemsMessage(current, previous)})`
        : '';

      return `${label}: ${current.length > 0 ? current.join(', ') : 'EMPTY'}${changeInfo}`;
    }

    return `\n${key}: ${current}${isChanged ? ` (was: ${previous})` : ''}`;
  }

  public async disconnect(): Promise<void> {
    this.isDisconnected = true;
    this.snapshotWatchdogHandle?.stop();
    this.snapshotWatchdogHandle = null;

    if (this.resubscribeTimer !== null) {
      clearTimeout(this.resubscribeTimer);
      this.resubscribeTimer = null;
    }

    if (this.connectionRetryTimer !== null) {
      clearTimeout(this.connectionRetryTimer);
      this.connectionRetryTimer = null;
    }

    try {
      if (this.settingsListener) {
        this.settingsListener();
        this.settingsListener = null;
      }

      await admin.app().delete();

      logger.info('Firebase service disconnected');
    } catch (error) {
      logger.error({ error }, 'Error disconnecting Firebase service');
    }
  }
}
