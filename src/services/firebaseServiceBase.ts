import { EventEmitter } from 'events';

import admin from 'firebase-admin';

import { TelegramNotifier } from './telegramNotifier';

import { logger } from '../core/logger';
import { Notifiable } from '../types/common';
import {
  FirebaseStrategySettingsValues,
  FormatSettingMessageArgs,
  SettingChange,
} from '../types/firebase';
import { SettingConfigBase } from '../types/telegramCommandHandler';

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
): Record<string, unknown> {
  const missing: Record<string, unknown> = {};

  for (const [key, defaultValue] of Object.entries(defaults)) {
    const storedValue = stored[key];

    if (storedValue === undefined) {
      missing[key] = defaultValue;

      continue;
    }

    if (isPlainObject(defaultValue) && isPlainObject(storedValue)) {
      const nestedMissing = collectMissingDefaults(defaultValue, storedValue);

      if (Object.keys(nestedMissing).length > 0) {
        missing[key] = nestedMissing;
      }
    }
  }

  return missing;
}

export interface FirebaseServiceBaseArgs<T> {
  documentPath: string;
  defaultData: T;
  telegramNotifier: TelegramNotifier;
}

export class FirebaseServiceBase<T> extends EventEmitter implements Notifiable {
  private firestore: admin.firestore.Firestore;
  private documentReference: admin.firestore.DocumentReference;
  private settingsListener: (() => void) | null = null;
  private currentData: T;
  private defaultData: T;
  public onNotify: Notifiable['onNotify'];
  public onError: Notifiable['onError'];

  constructor(args: FirebaseServiceBaseArgs<T>) {
    super();

    const { documentPath, defaultData, telegramNotifier } = args;

    this.defaultData = defaultData;
    this.currentData = { ...defaultData };
    this.onNotify = telegramNotifier.sendFormattedMessage.bind(telegramNotifier);
    this.onError = telegramNotifier.sendError.bind(telegramNotifier);

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
      const document = await this.documentReference.get();

      if (document.exists) {
        const data = document.data() as T;

        // Backfill only the default keys missing from the stored document via a
        // dot-notation update — existing values are never overwritten.
        const missingDefaults = collectMissingDefaults(
          this.defaultData as Record<string, unknown>,
          data as Record<string, unknown>,
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

      this.subscribeToDataChanges();
    } catch (error) {
      await this.onError('Failed to initialize Firebase service', error);

      throw error;
    }
  }

  private subscribeToDataChanges(): void {
    this.settingsListener = this.documentReference.onSnapshot(document => {
      if (document.exists) {
        const data = document.data() as T;
        const previousData = { ...this.currentData };
        this.updateCurrentData(data);

        logger.info(
          {
            previous: previousData,
            current: this.currentData,
          },
          'Data updated from Firebase'
        );

        this.emit('dataChanged', {
          current: this.currentData,
          previous: previousData,
        });
      }
    });
  }

  private updateCurrentData(data: Partial<T>): void {
    this.currentData = { ...this.defaultData, ...data };
  }

  public getData(): T {
    return this.currentData;
  }

  public async updateData(data: Partial<T>): Promise<void> {
    try {
      const flatData = flattenForFirestoreUpdate(data);

      await this.documentReference.update(flatData);

      logger.info({ data: flatData }, 'Updated data in Firebase');
    } catch (error) {
      logger.error({ error, data }, 'Failed to update data in Firebase');

      throw error;
    }
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
