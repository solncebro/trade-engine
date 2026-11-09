/** Reads and writes one named document (for example a Firebase document next to an app's settings).
 *  read resolves null when the document does not exist yet; a rejection means "could not be read". */
interface ListDocumentIo {
  read: (name: string) => Promise<Record<string, unknown> | null>;
  write: (name: string, data: Record<string, unknown>) => Promise<void>;
}

interface ListDocumentLogger {
  warn(message: string): void;
  error(message: string): void;
}

interface ListDocumentFlushConfirmed {
  ok: true;
  revision: number;
}

interface ListDocumentFlushUnconfirmed {
  ok: false;
  revision: number;
  reason:
    | 'io-unavailable'
    | 'document-unread'
    | 'write-failed'
    | 'revision-superseded'
    | 'invalid-revision';
}

type ListDocumentFlushResult =
  ListDocumentFlushConfirmed | ListDocumentFlushUnconfirmed;

interface ListDocumentPendingConfirmation {
  revision: number;
  isConfirmed: boolean;
}

interface PersistedListDocumentArgs<TRecord> {
  /** null = memory only: nothing is read or written, nothing throws. */
  io: ListDocumentIo | null;
  documentName: string;
  logger: ListDocumentLogger;
  /** Prefix of every log line, e.g. "[EntrySetup]". */
  logLabel: string;
  keyOf: (record: TRecord) => string;
  /** null drops the raw entry (logged) and keeps the rest of the list. */
  parse: (raw: unknown) => TRecord | null;
  /** What one record looks like inside the document's recordList. */
  serialize: (record: TRecord) => unknown;
  /** Records to drop after every set() and after a read merged the document in — e.g. "everything but
   *  the newest twenty". A drop here is plain housekeeping, not a forget: it is not remembered. */
  selectDropped?: (recordList: TRecord[]) => TRecord[];
  /** Pause before a failed read or write is tried again. Default 30 000 ms. */
  retryMs?: number;
}

export type {
  ListDocumentFlushResult,
  ListDocumentIo,
  ListDocumentLogger,
  ListDocumentPendingConfirmation,
  PersistedListDocumentArgs,
};
