import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { JournalSpool } from '../src/services/tradeJournal/journalSpool';

describe('JournalSpool', () => {
  let directory: string;
  let filePath: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'journal-spool-unit-'));
    filePath = path.join(directory, 'deep', 'spool.jsonl');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('reads nothing from a spool that was never written', async () => {
    await expect(new JournalSpool(filePath).readEntryList()).resolves.toEqual([]);
  });

  it('appends entries as JSON lines in order, creating the folder', async () => {
    const spool = new JournalSpool(filePath);

    await expect(spool.appendEntryList([{ kind: 'summary', key: 'T', row: { id: 'T' } }])).resolves.toBe(true);
    await spool.appendEntryList([{ kind: 'event', tradeKey: 'T', row: { seq: 1 } }, { kind: 'event', tradeKey: 'T', row: { seq: 2 } }]);

    expect(readFileSync(filePath, 'utf8').trim().split('\n')).toHaveLength(3);
    expect((await spool.readEntryList()).map(entry => entry.kind)).toEqual(['summary', 'event', 'event']);
  });

  it('skips unreadable and foreign lines instead of failing the whole replay', async () => {
    const spool = new JournalSpool(filePath);

    await spool.appendEntryList([{ kind: 'summary', key: 'T', row: { id: 'T' } }]);
    writeFileSync(filePath, `${readFileSync(filePath, 'utf8')}{"kind":"other"}\n{"kind":"eve`);

    await expect(spool.readEntryList()).resolves.toEqual([{ kind: 'summary', key: 'T', row: { id: 'T' } }]);
  });

  it('replaces the file atomically and leaves no temp file behind', async () => {
    const spool = new JournalSpool(filePath);

    await spool.appendEntryList([{ kind: 'summary', key: 'T', row: { id: 'T' } }, { kind: 'event', tradeKey: 'T', row: { seq: 1 } }]);
    await spool.replaceEntryList([{ kind: 'event', tradeKey: 'T', row: { seq: 1 } }]);

    await expect(spool.readEntryList()).resolves.toEqual([{ kind: 'event', tradeKey: 'T', row: { seq: 1 } }]);
    expect(readdirSync(path.dirname(filePath))).toEqual(['spool.jsonl']);
  });

  it('removes the file when replaced with nothing', async () => {
    const spool = new JournalSpool(filePath);

    await spool.appendEntryList([{ kind: 'summary', key: 'T', row: { id: 'T' } }]);
    await spool.replaceEntryList([]);

    expect(existsSync(filePath)).toBe(false);
  });

  it('reports false instead of throwing when the disk refuses the write', async () => {
    const blockingFilePath = path.join(directory, 'not-a-folder');
    writeFileSync(blockingFilePath, '');

    await expect(new JournalSpool(path.join(blockingFilePath, 'spool.jsonl')).appendEntryList([{ kind: 'summary', key: 'T', row: {} }])).resolves.toBe(false);
  });
});
