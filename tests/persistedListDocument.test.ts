import { PersistedListDocument } from '../src/services/persistedListDocument';
import type {
  ListDocumentIo,
  PersistedListDocumentArgs,
} from '../src/services/persistedListDocument.types';

interface Item {
  key: string;
  value: number;
}

interface WrittenDocument {
  recordList: Item[];
  updatedAtMs: number;
}

const DOCUMENT_NAME = 'items';

function parseItem(raw: unknown): Item | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const value = raw as Record<string, unknown>;

  if (typeof value.key !== 'string' || typeof value.value !== 'number')
    return null;

  return { key: value.key, value: value.value };
}

function buildLogger() {
  return { warn: jest.fn(), error: jest.fn() };
}

function buildIo(readValue: Record<string, unknown> | null = null) {
  return {
    read: jest.fn().mockResolvedValue(readValue),
    write: jest.fn().mockResolvedValue(undefined),
  };
}

function buildDocument(
  io: ListDocumentIo | null,
  overrides: Partial<PersistedListDocumentArgs<Item>> = {}
) {
  const logger = buildLogger();
  const document = new PersistedListDocument<Item>({
    io,
    documentName: DOCUMENT_NAME,
    logger,
    logLabel: '[Items]',
    keyOf: item => item.key,
    parse: parseItem,
    serialize: item => ({ ...item }),
    ...overrides,
  });

  return { document, logger };
}

function writtenKeyList(write: jest.Mock, callIndex: number): string[] {
  const written = write.mock.calls[callIndex][1] as WrittenDocument;

  return written.recordList.map(item => item.key);
}

function buildDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });

  return { promise, resolve };
}

describe('PersistedListDocument — reading', () => {
  it('reads the recordList under its document name and keys every parsed record', async () => {
    const io = buildIo({ recordList: [{ key: 'a', value: 1 }] });
    const { document } = buildDocument(io);

    await document.load();

    expect(io.read).toHaveBeenCalledWith(DOCUMENT_NAME);
    expect(document.get('a')).toEqual({ key: 'a', value: 1 });
    expect(document.has('a')).toBe(true);
    expect(document.list()).toEqual([{ key: 'a', value: 1 }]);
  });

  it('drops a broken record and logs it, keeping the rest', async () => {
    const io = buildIo({
      recordList: [{ key: 'a', value: 1 }, { key: 'broken' }],
    });
    const { document, logger } = buildDocument(io);

    await document.load();

    expect(document.list()).toEqual([{ key: 'a', value: 1 }]);
    expect(logger.error).toHaveBeenCalled();
  });

  it('an absent document and a listless one both read as known-empty — writes go through', async () => {
    for (const readValue of [null, { other: 1 }]) {
      const io = buildIo(readValue);
      const { document } = buildDocument(io);

      await document.load();
      document.set({ key: 'a', value: 1 });
      await document.flush();

      expect(io.write).toHaveBeenCalledTimes(1);
    }
  });

  it('a failed read logs, leaves memory empty, and does not throw', async () => {
    const io = buildIo();

    io.read.mockRejectedValue(new Error('down'));

    const { document, logger } = buildDocument(io);

    await document.load();

    expect(document.list()).toEqual([]);
    expect(logger.error).toHaveBeenCalled();
  });

  it('works entirely in memory when io is null', async () => {
    const { document } = buildDocument(null);

    await document.load();
    document.set({ key: 'a', value: 1 });
    document.remove('a');
    document.clear();
    await document.flush();

    expect(document.list()).toEqual([]);
  });
});

describe('PersistedListDocument — writing', () => {
  it('writes the whole list as { recordList, updatedAtMs } built by serialize', async () => {
    const io = buildIo();
    const { document } = buildDocument(io, {
      serialize: item => ({ ...item, written: true }),
    });

    document.set({ key: 'a', value: 1 });
    await document.flush();

    expect(io.write).toHaveBeenCalledWith(DOCUMENT_NAME, {
      recordList: [{ key: 'a', value: 1, written: true }],
      updatedAtMs: expect.any(Number),
    });
  });

  it('does not await the write — set returns before the write settles', () => {
    const io = buildIo();

    io.write.mockReturnValue(new Promise(() => undefined));

    const { document } = buildDocument(io);

    document.set({ key: 'a', value: 1 });

    expect(document.get('a')).toEqual({ key: 'a', value: 1 });
    expect(io.write).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst into one more write carrying the final state', async () => {
    const first = buildDeferred<void>();
    const io = buildIo();

    io.write
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(undefined);

    const { document } = buildDocument(io);

    document.set({ key: 'a', value: 1 });
    document.set({ key: 'a', value: 2 });
    document.set({ key: 'a', value: 3 });
    first.resolve();
    await document.flush();

    expect(io.write).toHaveBeenCalledTimes(2);

    const last = io.write.mock.calls[1][1] as WrittenDocument;

    expect(last.recordList).toEqual([{ key: 'a', value: 3 }]);
  });

  it('remove and clear persist', async () => {
    const io = buildIo();
    const { document } = buildDocument(io);

    document.set({ key: 'a', value: 1 });
    document.set({ key: 'b', value: 2 });
    await document.flush();
    document.remove('a');
    await document.flush();

    expect(writtenKeyList(io.write, io.write.mock.calls.length - 1)).toEqual([
      'b',
    ]);

    document.clear();
    await document.flush();

    expect(writtenKeyList(io.write, io.write.mock.calls.length - 1)).toEqual(
      []
    );
  });

  it('a failed write is logged, not thrown, and later writes still happen', async () => {
    const io = buildIo();

    io.write
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue(undefined);

    const { document, logger } = buildDocument(io);

    document.set({ key: 'a', value: 1 });
    await document.flush();

    expect(logger.error).toHaveBeenCalled();
    expect(io.write).toHaveBeenCalledTimes(2);
  });

  it('selectDropped runs after set: the dropped record never reaches the document', async () => {
    const io = buildIo();
    const { document } = buildDocument(io, {
      selectDropped: recordList =>
        [...recordList].sort((l, r) => r.value - l.value).slice(2),
    });

    document.set({ key: 'a', value: 1 });
    document.set({ key: 'b', value: 2 });
    document.set({ key: 'c', value: 3 });
    await document.flush();

    expect(document.has('a')).toBe(false);
    expect(
      writtenKeyList(io.write, io.write.mock.calls.length - 1).sort()
    ).toEqual(['b', 'c']);
  });
});

describe('PersistedListDocument — retry and the unread document', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('retries a failed write after retryMs with the same state, and keeps retrying', async () => {
    const io = buildIo();

    io.write.mockRejectedValue(new Error('down'));

    const { document } = buildDocument(io);

    document.set({ key: 'a', value: 1 });
    await jest.advanceTimersByTimeAsync(1);

    expect(io.write).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(30_000);
    await jest.advanceTimersByTimeAsync(30_000);

    expect(io.write).toHaveBeenCalledTimes(3);
    expect(writtenKeyList(io.write, 2)).toEqual(['a']);
  });

  it('honours a custom retryMs', async () => {
    const io = buildIo();

    io.write
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue(undefined);

    const { document } = buildDocument(io, { retryMs: 5_000 });

    document.set({ key: 'a', value: 1 });
    await jest.advanceTimersByTimeAsync(5_000);

    expect(io.write).toHaveBeenCalledTimes(2);
  });

  it('the retry timer is unref’d — it never keeps the process alive', async () => {
    const io = buildIo();

    io.write.mockRejectedValue(new Error('down'));

    const unrefSpy = jest.fn();
    const realSetTimeout = global.setTimeout;
    const setTimeoutSpy = jest
      .spyOn(global, 'setTimeout')
      .mockImplementation(((handler: () => void, ms: number) => {
        const timer = realSetTimeout(handler, ms);

        timer.unref = unrefSpy.mockReturnValue(timer);

        return timer;
      }) as typeof setTimeout);

    try {
      const { document } = buildDocument(io);

      document.set({ key: 'a', value: 1 });
      await jest.advanceTimersByTimeAsync(1);

      expect(unrefSpy).toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('withholds writes after a failed read, then merges the document in on the retry and writes', async () => {
    const io = buildIo();

    io.read
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue({ recordList: [{ key: 'other', value: 9 }] });

    const { document, logger } = buildDocument(io);

    await document.load();
    document.set({ key: 'a', value: 1 });
    await jest.advanceTimersByTimeAsync(1);

    expect(io.write).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(30_000);

    expect(io.write).toHaveBeenCalledTimes(1);
    expect(writtenKeyList(io.write, 0).sort()).toEqual(['a', 'other']);
  });

  it('memory wins a collision with the late-read document', async () => {
    const io = buildIo();

    io.read
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue({ recordList: [{ key: 'a', value: 100 }] });

    const { document } = buildDocument(io);

    await document.load();
    document.set({ key: 'a', value: 1 });
    await jest.advanceTimersByTimeAsync(30_001);

    expect(document.get('a')).toEqual({ key: 'a', value: 1 });
  });

  it('selectDropped also runs after the late read merged the document in', async () => {
    const io = buildIo();

    io.read
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue({
        recordList: [
          { key: 'old', value: 1 },
          { key: 'newer', value: 5 },
        ],
      });

    const { document } = buildDocument(io, {
      selectDropped: recordList =>
        [...recordList].sort((l, r) => r.value - l.value).slice(2),
    });

    await document.load();
    document.set({ key: 'mine', value: 3 });
    await jest.advanceTimersByTimeAsync(30_001);

    expect(
      document
        .list()
        .map(item => item.key)
        .sort()
    ).toEqual(['mine', 'newer']);
  });

  it('a key removed while the document was unread is not resurrected by the late read', async () => {
    const io = buildIo();

    io.read.mockRejectedValueOnce(new Error('down')).mockResolvedValue({
      recordList: [
        { key: 'a', value: 1 },
        { key: 'b', value: 2 },
      ],
    });

    const { document } = buildDocument(io);

    await document.load();
    document.set({ key: 'a', value: 1 });
    document.remove('b');
    await jest.advanceTimersByTimeAsync(30_001);

    expect(document.has('b')).toBe(false);
    expect(writtenKeyList(io.write, 0)).toEqual(['a']);
  });

  it('keys cleared while unread are not resurrected either', async () => {
    const io = buildIo();

    io.read
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue({ recordList: [{ key: 'a', value: 1 }] });

    const { document } = buildDocument(io);

    await document.load();
    document.set({ key: 'a', value: 2 });
    document.clear();
    await jest.advanceTimersByTimeAsync(30_001);

    expect(document.list()).toEqual([]);
  });

  it('forgets the removals once the document is written — a later outage starts clean', async () => {
    const io = buildIo();

    io.read
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce({ recordList: [{ key: 'b', value: 2 }] })
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue({ recordList: [{ key: 'b', value: 2 }] });

    const { document } = buildDocument(io);

    await document.load();
    document.remove('b');
    await jest.advanceTimersByTimeAsync(30_001);

    expect(io.write).toHaveBeenCalledTimes(1);
    expect(document.has('b')).toBe(false);

    await document.load();
    await jest.advanceTimersByTimeAsync(30_001);

    expect(document.has('b')).toBe(true);
  });

  it('a removal while the document IS read is not remembered — the write itself says so', async () => {
    const io = buildIo({ recordList: [{ key: 'b', value: 2 }] });
    const { document } = buildDocument(io);

    await document.load();
    document.remove('b');
    await document.flush();
    await document.load();

    expect(document.has('b')).toBe(true);
  });
});

describe('PersistedListDocument.flush', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('waits for the write in flight to settle', async () => {
    const pending = buildDeferred<void>();
    const io = buildIo();

    io.write.mockReturnValueOnce(pending.promise);

    const { document } = buildDocument(io);
    let isFlushed = false;

    document.set({ key: 'a', value: 1 });

    const flushPromise = document.flush().then(() => {
      isFlushed = true;
    });

    await jest.advanceTimersByTimeAsync(1);

    expect(isFlushed).toBe(false);

    pending.resolve();
    await flushPromise;

    expect(isFlushed).toBe(true);
  });

  it('forces the owed write without waiting for the retry, and cancels the retry', async () => {
    const io = buildIo();

    io.write
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue(undefined);

    const { document } = buildDocument(io);

    document.set({ key: 'a', value: 1 });
    await jest.advanceTimersByTimeAsync(1);
    await document.flush();

    expect(io.write).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(30_000);

    expect(io.write).toHaveBeenCalledTimes(2);
  });

  it('re-reads an unread document, merges it, then writes', async () => {
    const io = buildIo();

    io.read
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue({ recordList: [{ key: 'other', value: 9 }] });

    const { document } = buildDocument(io);

    await document.load();
    document.set({ key: 'a', value: 1 });
    await document.flush();

    expect(io.read).toHaveBeenCalledTimes(2);
    expect(writtenKeyList(io.write, 0).sort()).toEqual(['a', 'other']);
  });

  it('says so and writes nothing when the document still cannot be read', async () => {
    const io = buildIo();

    io.read.mockRejectedValue(new Error('down'));

    const { document, logger } = buildDocument(io);

    await document.load();
    document.set({ key: 'a', value: 1 });
    await document.flush();

    expect(io.read).toHaveBeenCalledTimes(2);
    expect(io.write).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it('does nothing when the document is already up to date', async () => {
    const io = buildIo();
    const { document } = buildDocument(io);

    await document.flush();

    expect(io.write).not.toHaveBeenCalled();
  });
});

describe('PersistedListDocument — load result, absent removals, stop', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('load resolves true when the document was read (absent counts) and false when it was not', async () => {
    const readable = buildDocument(buildIo(null)).document;
    const failingIo = buildIo();

    failingIo.read.mockRejectedValue(new Error('down'));

    const unreadable = buildDocument(failingIo).document;

    expect(await readable.load()).toBe(true);
    expect(await unreadable.load()).toBe(false);
    expect(await buildDocument(null).document.load()).toBe(true);
  });

  it('removing a key that is not there writes nothing while the document is read', async () => {
    const io = buildIo();
    const { document } = buildDocument(io);

    await document.load();
    document.remove('a');
    await document.flush();

    expect(io.write).not.toHaveBeenCalled();
  });

  it('stop clears the pending retry; a later change still writes', async () => {
    const io = buildIo();

    io.write
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue(undefined);

    const { document } = buildDocument(io);

    document.set({ key: 'a', value: 1 });
    await jest.advanceTimersByTimeAsync(1);
    document.stop();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(io.write).toHaveBeenCalledTimes(1);

    document.set({ key: 'b', value: 2 });
    await jest.advanceTimersByTimeAsync(1);

    expect(io.write).toHaveBeenCalledTimes(2);
  });
});
