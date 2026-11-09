import type { TelegramNotifier } from './telegramNotifier';

import type { Notifiable } from '../types/common';

interface FirebaseDocumentWriteArgs {
  documentPath: string;
  data: Record<string, unknown>;
  kind: 'replace' | 'update';
}

export interface FirebaseServiceBaseArgs<T> {
  readDocument?: (documentPath: string) => Promise<Record<string, unknown> | null>;
  writeDocument?: (args: FirebaseDocumentWriteArgs) => Promise<void>;
  documentPath: string;
  defaultData: T;
  /** Where notices go. Optional since the `onNotify`/`onError` callbacks can stand in for it; with
   *  neither, notices only reach the log. */
  telegramNotifier?: TelegramNotifier;
  onNotify?: Notifiable['onNotify'];
  onError?: Notifiable['onError'];
  /** First pause before re-opening a live subscription that Firestore closed with an error; doubles
   *  up to `resubscribeMaxDelayMs`. Defaults: 1 s and 60 s. */
  resubscribeInitialDelayMs?: number;
  resubscribeMaxDelayMs?: number;
  /** Re-read the document this often and compare it with the in-memory copy: a live subscription can
   *  die WITHOUT an error, and the app then runs on stale settings until restart. On divergence the
   *  copy is repaired, `dataChanged` is emitted and the subscription is re-opened. Omitted/null: off. */
  snapshotWatchdogIntervalMs?: number | null;
  /** JSON file with the last good copy of the document. With it, a Firestore outage at startup is not
   *  fatal: the service starts from this copy, says so, and keeps trying to connect. Omitted/null: a
   *  failed start throws, as before. */
  snapshotCacheFilePath?: string | null;
  /** How often to retry the connection after starting from the disk copy. Default 30 s. */
  connectionRetryIntervalMs?: number;
  /** Deadline of each initialization step (the read, the default write) when a disk copy or this value is configured;
   *  the whole attempt, disk persistence included, is capped at their sum. Notices are sent without waiting.
   *  Default 30 s. With neither a disk copy nor this value initialization is not capped, as before. */
  initialReadTimeoutMs?: number;
  /** A value written by `updateData` shows in `getData()` at once instead of after Firestore echoes it
   *  back (a menu rebuilt right after saving showed the OLD number — rubber, 08.09.2026). Default true. */
  isWriteVisibleImmediately?: boolean;
  /** How long a written value outranks the stored one when its echo never arrives. Default 15 s. */
  pendingWriteMaxAgeMs?: number;
  /** Dot paths of fields holding a map of items (e.g. `traderById`). The startup backfill writes such a
   *  field whole only when it is absent and never adds its default items one by one: an item the user
   *  removed must stay removed across restarts. Omitted: every nested default key is backfilled, as before. */
  wholeMapFieldList?: readonly string[];
}

export interface FirebaseDataChangedEvent<T> {
  current: T;
  previous: T;
}

export type FirebaseConnectionLostReason = 'listenerError' | 'watchdogReadFailed' | 'initialReadFailed' | 'reconnectFailed';

export interface FirebaseConnectionLostEvent {
  reason: FirebaseConnectionLostReason;
  error: unknown;
}

export interface FirebaseSnapshotDivergedEvent<T> {
  /** Top-level keys whose stored value differed from the in-memory copy. */
  divergentKeyList: string[];
  current: T;
  previous: T;
}

export interface FirebaseStartedFromDiskCopyEvent {
  savedAtMs: number;
  error: unknown;
}

/** A map of items inside one document: a field of THIS document (dot path for a nested one), or a
 *  document next to it — its top-level fields, or a map field inside it. */
export type FirebaseMapLocation = string | { siblingDocumentName: string; mapField?: string };

export interface FirebaseSnapshotDiskCopy {
  documentPath: string;
  savedAtMs: number;
  data: unknown;
}

export interface FirebaseLoadAttempt {
  isActive: boolean;
}

export interface FirebaseDiskCopyWriteArgs<T> {
  data: T;
  attempt: FirebaseLoadAttempt;
}
