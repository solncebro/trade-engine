import type {
  ListDocumentIo,
  ListDocumentLogger,
  PersistedListDocumentArgs,
} from './persistedListDocument.types';

import { describeError } from '../utils/errorFormatter.utils';

const DEFAULT_RETRY_MS = 30_000;

/**
 * An in-memory keyed list mirrored, write-behind, into ONE document — the memory is the truth while
 * the process lives; the document is only there to survive a restart. Lifted from an app's
 * entry-setup memory (a store of live trading setups), where every rule below was paid for:
 *
 * - The document holds a LIST (`{ recordList, updatedAtMs }`): a document written by merge keeps
 *   every key a map ever had, so a removed key would rise again on the next restart.
 * - A failed read degrades to "nothing remembered" and never throws — but the content is then
 *   UNKNOWN, so every write is withheld until a re-read succeeds: a full write of this memory would
 *   erase the records of every key this process never heard of. An absent or listless document is
 *   known-empty, not unknown.
 * - The late re-read MERGES the document into memory and memory wins a collision (the document is
 *   by definition the older picture); a key removed while the document was unread does not come back.
 * - The caller never waits on a write: one write in flight, a burst of changes during it coalesces
 *   into exactly one more write carrying the latest state.
 * - A failed read or write is retried on an unref'd timer (a pending retry must never be what keeps
 *   the process alive); flush() is the last chance before a shutdown and forces the owed write.
 *
 * get()/list() hand out the stored objects themselves: a store whose records are mutable clones them
 * at its own boundary.
 */
export class PersistedListDocument<TRecord> {
  private readonly io: ListDocumentIo | null;
  private readonly documentName: string;
  private readonly logger: ListDocumentLogger;
  private readonly logLabel: string;
  private readonly keyOf: (record: TRecord) => string;
  private readonly parse: (raw: unknown) => TRecord | null;
  private readonly serialize: (record: TRecord) => unknown;
  private readonly selectDropped:
    | ((recordList: TRecord[]) => TRecord[])
    | null;
  private readonly retryMs: number;
  private readonly recordByKey = new Map<string, TRecord>();

  private writeInFlight: Promise<void> | null = null;
  private isDirty = false;
  private isDocumentUnread = false;
  /** Memory and the document are out of step — the last write failed or was withheld. */
  private isDocumentBehind = false;
  private retryTimer: NodeJS.Timeout | null = null;
  /** Keys removed WHILE the document could not be read: the re-read merges the document into memory,
   *  and without this a record already over would come back from it. Emptied once the document is
   *  written: from then on it says the same thing. */
  private readonly forgottenKeySet = new Set<string>();

  constructor(args: PersistedListDocumentArgs<TRecord>) {
    this.io = args.io;
    this.documentName = args.documentName;
    this.logger = args.logger;
    this.logLabel = args.logLabel;
    this.keyOf = args.keyOf;
    this.parse = args.parse;
    this.serialize = args.serialize;
    this.selectDropped = args.selectDropped ?? null;
    this.retryMs = args.retryMs ?? DEFAULT_RETRY_MS;
  }

  /** True when the document was read (absent or listless counts); false leaves writes withheld. */
  async load(): Promise<boolean> {
    return this.readDocument();
  }

  get(key: string): TRecord | undefined {
    return this.recordByKey.get(key);
  }

  has(key: string): boolean {
    return this.recordByKey.has(key);
  }

  list(): TRecord[] {
    return Array.from(this.recordByKey.values());
  }

  set(record: TRecord): void {
    this.recordByKey.set(this.keyOf(record), record);
    this.dropSelected();
    this.schedulePersist();
  }

  /** Removing a key that is not there writes nothing while the document is read — a store asked to
   *  forget on every routine event must not write on every one of them. While unread the key is still
   *  remembered as forgotten, so the late read does not bring it back. */
  remove(key: string): void {
    const wasPresent = this.recordByKey.delete(key);

    this.rememberForgotten([key]);

    if (!wasPresent && !this.isDocumentUnread) return;

    this.schedulePersist();
  }

  clear(): void {
    this.rememberForgotten(this.recordByKey.keys());
    this.recordByKey.clear();
    this.schedulePersist();
  }

  /** Waits out the write in flight AND forces the one still owed: a write left to the retry timer is
   *  a write a shutting-down process will not be alive for. */
  async flush(): Promise<void> {
    await this.settleWrites();

    if (!this.isDocumentBehind) return;

    this.clearRetry();

    if (this.isDocumentUnread && !(await this.readDocument())) {
      this.logger.error(
        `${this.logLabel} flush: the document still cannot be read — nothing is written over it, and this process's memory ends here`
      );

      return;
    }

    this.schedulePersist();
    await this.settleWrites();
  }

  /** Clears a pending retry (shutdown, after flush): an armed timer would otherwise fire a read or a
   *  write after its owner is done. A later change schedules writes as usual. */
  stop(): void {
    this.clearRetry();
  }

  /** True when the document was actually read (absent or listless counts: its content is then known
   *  to be nothing). */
  private async readDocument(): Promise<boolean> {
    if (this.io === null) return true;

    try {
      const raw = await this.io.read(this.documentName);
      const rawList = raw === null ? [] : raw.recordList;

      if (Array.isArray(rawList)) this.absorb(rawList);

      this.isDocumentUnread = false;

      return true;
    } catch (error: unknown) {
      this.isDocumentUnread = true;
      this.logger.error(
        `${this.logLabel} read failed (${describeError(error)}) — nothing remembered, and writing is withheld until the document can be read`
      );
      this.armRetry();

      return false;
    }
  }

  private absorb(rawList: ReadonlyArray<unknown>): void {
    for (const value of rawList) {
      const record = this.parse(value);

      if (record === null) {
        this.logger.error(
          `${this.logLabel} dropped a broken record while loading ${this.documentName}`
        );
        continue;
      }

      const key = this.keyOf(record);

      if (this.recordByKey.has(key) || this.forgottenKeySet.has(key)) continue;

      this.recordByKey.set(key, record);
    }

    this.dropSelected();
  }

  private dropSelected(): void {
    if (this.selectDropped === null) return;

    for (const record of this.selectDropped(this.list())) {
      this.recordByKey.delete(this.keyOf(record));
    }
  }

  /** Only while the document's content is unknown: with it read, the write that follows already says
   *  the key is gone. */
  private rememberForgotten(keyList: Iterable<string>): void {
    if (!this.isDocumentUnread) return;

    for (const key of keyList) this.forgottenKeySet.add(key);
  }

  private async settleWrites(): Promise<void> {
    while (this.writeInFlight !== null) {
      await this.writeInFlight;
    }
  }

  private schedulePersist(): void {
    if (this.io === null) return;

    if (this.writeInFlight !== null) {
      this.isDirty = true;
      return;
    }

    this.writeInFlight = this.persistLoop();
  }

  private async persistLoop(): Promise<void> {
    do {
      this.isDirty = false;
      await this.writeDocument();
    } while (this.isDirty);

    this.writeInFlight = null;
  }

  private async writeDocument(): Promise<void> {
    if (this.io === null) return;

    if (this.isDocumentUnread) {
      this.isDocumentBehind = true;
      this.logger.warn(
        `${this.logLabel} write withheld: the document was never read — the records it holds would be erased; retrying the read in ${this.retryMs / 1000}s`
      );
      this.armRetry();

      return;
    }

    try {
      const recordList = this.list().map(record => this.serialize(record));

      await this.io.write(this.documentName, {
        recordList,
        updatedAtMs: Date.now(),
      });
      this.isDocumentBehind = false;
      this.forgottenKeySet.clear();
    } catch (error: unknown) {
      this.isDocumentBehind = true;
      this.logger.error(
        `${this.logLabel} write failed (${describeError(error)}) — memory still holds it in this process, retrying in ${this.retryMs / 1000}s`
      );
      this.armRetry();
    }
  }

  private armRetry(): void {
    if (this.io === null || this.retryTimer !== null) return;

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.runRetry();
    }, this.retryMs);
    this.retryTimer.unref();
  }

  private clearRetry(): void {
    if (this.retryTimer === null) return;

    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private async runRetry(): Promise<void> {
    if (this.isDocumentUnread && !(await this.readDocument())) return;

    if (this.isDocumentBehind) this.schedulePersist();
  }
}
