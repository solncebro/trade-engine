import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { JournalSpoolEntry } from './journalSpool.types';

import { logger } from '../../core/logger';

function isSpoolEntry(value: unknown): value is JournalSpoolEntry {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const entry = value as Record<string, unknown>;
  const hasRow = entry.row !== null && typeof entry.row === 'object';

  if (entry.kind === 'summary') {
    return typeof entry.key === 'string' && hasRow;
  }

  return entry.kind === 'event' && typeof entry.tradeKey === 'string' && hasRow;
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/**
 * On-disk backlog of journal rows the database did not take. One JSON object per line (JSONL). Idea
 * from coin-listing's capture writer, which also dumps an unsaved batch to NDJSON — but only writes it;
 * this spool is read back and replayed, so the rows reach the database once it answers again.
 *
 * Crash safety: new rows are only ever APPENDED (and synced to disk), so a crash mid-write can at worst
 * leave one torn last line, which the reader skips. The file is replaced only through a temp file and
 * an atomic rename, and removed only after its rows are confirmed in the database.
 */
export class JournalSpool {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  getFilePath(): string {
    return this.filePath;
  }

  /** False when the disk refused the write (full, no permission) — the caller keeps its rows in RAM. */
  async appendEntryList(entryList: JournalSpoolEntry[]): Promise<boolean> {
    if (entryList.length === 0) {
      return true;
    }

    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });

      const handle = await fs.open(this.filePath, 'a');

      try {
        await handle.appendFile(entryList.map(entry => `${JSON.stringify(entry)}\n`).join(''), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }

      return true;
    } catch (error: unknown) {
      logger.error({ error, filePath: this.filePath, entryCount: entryList.length }, '[JournalSpool] Failed to append to the on-disk spool');

      return false;
    }
  }

  async readEntryList(): Promise<JournalSpoolEntry[]> {
    let content: string;

    try {
      content = await fs.readFile(this.filePath, 'utf8');
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return [];
      }

      throw error;
    }

    const entryList: JournalSpoolEntry[] = [];
    let skippedLineCount = 0;

    for (const line of content.split('\n')) {
      if (line.trim() === '') {
        continue;
      }

      try {
        const parsed: unknown = JSON.parse(line);

        if (isSpoolEntry(parsed)) {
          entryList.push(parsed);
        } else {
          skippedLineCount += 1;
        }
      } catch {
        skippedLineCount += 1;
      }
    }

    if (skippedLineCount > 0) {
      logger.warn({ filePath: this.filePath, skippedLineCount }, `[JournalSpool] Skipped ${skippedLineCount} unreadable line(s) (torn write after a crash?)`);
    }

    return entryList;
  }

  /** Atomically replace the whole spool; an empty list removes the file. */
  async replaceEntryList(entryList: JournalSpoolEntry[]): Promise<void> {
    if (entryList.length === 0) {
      await fs.rm(this.filePath, { force: true });

      return;
    }

    const tempFilePath = `${this.filePath}.tmp`;

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(tempFilePath, entryList.map(entry => `${JSON.stringify(entry)}\n`).join(''), 'utf8');
    await fs.rename(tempFilePath, this.filePath);
  }
}
