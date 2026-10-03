import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { FIREBASE_SERVICE_EVENT, FirebaseServiceBase } from '../src/services/firebaseServiceBase';

// In-memory Firestore double. Shapes follow the installed @google-cloud/firestore typings:
// onSnapshot(onNext, onError) → unsubscribe; update(data) / update(fieldPath, value, ...more);
// set(data, { merge } | { mergeFields }); FieldValue.delete(); FieldPath(...segments). No live calls.
interface MockListener {
  path: string;
  onNext: (snapshot: MockSnapshot) => void;
  onError: (error: Error) => void;
  isActive: boolean;
}

interface MockSnapshot {
  exists: boolean;
  data: () => Record<string, unknown> | undefined;
}

const mockFirestoreState = {
  documentByPath: new Map<string, Record<string, unknown>>(),
  listenerList: [] as MockListener[],
  failGetCount: 0,
  isGetHanging: false,
  isEchoMuted: false,
};

function mockClone<V>(value: V): V {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as V;
}

jest.mock('firebase-admin', () => {
  class MockFieldValue {
    readonly kind: string;

    constructor(kind: string) {
      this.kind = kind;
    }

    static delete(): MockFieldValue {
      return new MockFieldValue('delete');
    }
  }

  class MockFieldPath {
    readonly segmentList: string[];

    constructor(...segmentList: string[]) {
      this.segmentList = segmentList;
    }
  }

  const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof MockFieldValue);

  const writeAtPath = (target: Record<string, unknown>, segmentList: string[], value: unknown): void => {
    let current = target;

    for (const segment of segmentList.slice(0, -1)) {
      if (!isObject(current[segment])) {
        current[segment] = {};
      }

      current = current[segment] as Record<string, unknown>;
    }

    const lastSegment = segmentList[segmentList.length - 1];

    if (value instanceof MockFieldValue) {
      delete current[lastSegment];
    } else {
      current[lastSegment] = value;
    }
  };

  const readAtPath = (source: Record<string, unknown>, segmentList: string[]): unknown => segmentList.reduce<unknown>((current, segment) => (isObject(current) ? current[segment] : undefined), source);

  const deepMerge = (target: Record<string, unknown>, source: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(source)) {
      if (isObject(value) && isObject(target[key])) {
        deepMerge(target[key] as Record<string, unknown>, value);
      } else {
        writeAtPath(target, [key], value);
      }
    }
  };

  const echo = (path: string): void => {
    if (mockFirestoreState.isEchoMuted) {
      return;
    }

    for (const listener of mockFirestoreState.listenerList) {
      if (listener.isActive && listener.path === path) {
        const data = mockFirestoreState.documentByPath.get(path);
        listener.onNext({ exists: data !== undefined, data: () => mockClone(data) });
      }
    }
  };

  const makeDocumentReference = (path: string): unknown => {
    const collectionPath = path.split('/').slice(0, -1).join('/');

    return {
      path,
      parent: { doc: (name: string) => makeDocumentReference(`${collectionPath}/${name}`) },
      get: async (): Promise<MockSnapshot> => {
        if (mockFirestoreState.isGetHanging) {
          return new Promise<MockSnapshot>(() => {});
        }

        if (mockFirestoreState.failGetCount > 0) {
          mockFirestoreState.failGetCount -= 1;

          throw new Error('14 UNAVAILABLE: No connection established');
        }

        const data = mockFirestoreState.documentByPath.get(path);

        return { exists: data !== undefined, data: () => mockClone(data) };
      },
      set: async (data: Record<string, unknown>, options?: { merge?: boolean; mergeFields?: MockFieldPath[] }): Promise<void> => {
        const existing = mockFirestoreState.documentByPath.get(path);

        if (options?.mergeFields !== undefined) {
          const next = existing ?? {};

          for (const fieldPath of options.mergeFields) {
            writeAtPath(next, fieldPath.segmentList, mockClone(readAtPath(data, fieldPath.segmentList)));
          }

          mockFirestoreState.documentByPath.set(path, next);
        } else if (options?.merge === true) {
          const next = existing ?? {};
          deepMerge(next, mockClone(data));
          mockFirestoreState.documentByPath.set(path, next);
        } else {
          mockFirestoreState.documentByPath.set(path, mockClone(data));
        }

        echo(path);
      },
      update: async (...argumentList: unknown[]): Promise<void> => {
        const existing = mockFirestoreState.documentByPath.get(path);

        if (existing === undefined) {
          throw new Error('5 NOT_FOUND: No document to update');
        }

        if (argumentList[0] instanceof MockFieldPath) {
          for (let index = 0; index < argumentList.length; index += 2) {
            writeAtPath(existing, (argumentList[index] as MockFieldPath).segmentList, argumentList[index + 1]);
          }
        } else {
          for (const [key, value] of Object.entries(argumentList[0] as Record<string, unknown>)) {
            writeAtPath(existing, key.split('.'), value);
          }
        }

        echo(path);
      },
      onSnapshot: (onNext: MockListener['onNext'], onError: MockListener['onError']): (() => void) => {
        const listener: MockListener = { path, onNext, onError, isActive: true };
        mockFirestoreState.listenerList.push(listener);

        const data = mockFirestoreState.documentByPath.get(path);
        onNext({ exists: data !== undefined, data: () => mockClone(data) });

        return () => {
          listener.isActive = false;
        };
      },
    };
  };

  const firestore = Object.assign(() => ({ doc: (path: string) => makeDocumentReference(path) }), { FieldPath: MockFieldPath, FieldValue: MockFieldValue });

  return {
    apps: [{}],
    initializeApp: jest.fn(),
    credential: { cert: jest.fn() },
    firestore,
    app: () => ({ delete: async () => {} }),
  };
});

interface TestSettings {
  isActive: boolean;
  volumeUsdt: number;
  general: { trigger: { periodMinutes: number; ratioPercent: number } };
}

const DOCUMENT_PATH = 'bot-binance/settings';
const DEFAULT_SETTINGS: TestSettings = { isActive: false, volumeUsdt: 100, general: { trigger: { periodMinutes: 30, ratioPercent: 5 } } };

function storedSettings(): Record<string, unknown> | undefined {
  return mockFirestoreState.documentByPath.get(DOCUMENT_PATH);
}

function activeListenerList(): MockListener[] {
  return mockFirestoreState.listenerList.filter(listener => listener.isActive && listener.path === DOCUMENT_PATH);
}

function createService(extra: Partial<ConstructorParameters<typeof FirebaseServiceBase<TestSettings>>[0]> = {}): { service: FirebaseServiceBase<TestSettings>; noticeList: string[]; errorNoticeList: string[] } {
  const noticeList: string[] = [];
  const errorNoticeList: string[] = [];
  const service = new FirebaseServiceBase<TestSettings>({
    documentPath: DOCUMENT_PATH,
    defaultData: DEFAULT_SETTINGS,
    onNotify: message => {
      noticeList.push(message);
    },
    onError: message => {
      errorNoticeList.push(message);
    },
    ...extra,
  });

  return { service, noticeList, errorNoticeList };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

let serviceList: FirebaseServiceBase<TestSettings>[] = [];

function track(service: FirebaseServiceBase<TestSettings>): FirebaseServiceBase<TestSettings> {
  serviceList.push(service);

  return service;
}

beforeEach(() => {
  mockFirestoreState.documentByPath.clear();
  mockFirestoreState.listenerList = [];
  mockFirestoreState.failGetCount = 0;
  mockFirestoreState.isGetHanging = false;
  mockFirestoreState.isEchoMuted = false;
});

afterEach(async () => {
  for (const service of serviceList) {
    await service.disconnect();
  }

  serviceList = [];
  jest.useRealTimers();
});

describe('FirebaseServiceBase — existing behaviour', () => {
  it('creates the document from defaults when absent and backfills missing keys when present', async () => {
    const { service } = createService();
    track(service);
    await service.initialize();

    expect(storedSettings()).toEqual(DEFAULT_SETTINGS);

    mockFirestoreState.documentByPath.set(DOCUMENT_PATH, { isActive: true });
    const second = track(createService().service);
    await second.initialize();

    expect(storedSettings()).toEqual({ ...DEFAULT_SETTINGS, isActive: true });
    expect(second.getData().isActive).toBe(true);
  });

  it('a whole-map field is backfilled only when absent: an item the user removed stays removed', async () => {
    mockFirestoreState.documentByPath.set(DOCUMENT_PATH, { isActive: true, volumeUsdt: 100, general: { trigger: { periodMinutes: 30 } } });
    await track(createService({ wholeMapFieldList: ['general.trigger'] }).service).initialize();

    expect(storedSettings()).toEqual({ isActive: true, volumeUsdt: 100, general: { trigger: { periodMinutes: 30 } } });

    mockFirestoreState.documentByPath.set(DOCUMENT_PATH, { isActive: true, volumeUsdt: 100, general: {} });
    await track(createService({ wholeMapFieldList: ['general.trigger'] }).service).initialize();

    expect(storedSettings()).toEqual({ isActive: true, volumeUsdt: 100, general: { trigger: { periodMinutes: 30, ratioPercent: 5 } } });
  });

  it('throws on a failed start when no disk copy is configured', async () => {
    mockFirestoreState.failGetCount = 1;
    const { service, errorNoticeList } = createService();
    track(service);

    await expect(service.initialize()).rejects.toThrow('UNAVAILABLE');
    expect(errorNoticeList).toEqual(['Failed to initialize Firebase service']);
  });

  it('still accepts a TelegramNotifier-shaped notifier (backward compatible)', async () => {
    const telegramNotifier = { sendFormattedMessage: jest.fn(), sendError: jest.fn() };
    const service = track(new FirebaseServiceBase<TestSettings>({
      documentPath: DOCUMENT_PATH,
      defaultData: DEFAULT_SETTINGS,
      telegramNotifier: telegramNotifier as unknown as ConstructorParameters<typeof FirebaseServiceBase<TestSettings>>[0]['telegramNotifier'],
    }));

    await service.initialize();

    expect(telegramNotifier.sendFormattedMessage).toHaveBeenCalledWith('No data found in Firebase — created document with defaults');
  });
});

describe('FirebaseServiceBase — live subscription recovery', () => {
  it('re-opens a subscription that Firestore closed with an error, with backoff, and reports lost/restored', async () => {
    jest.useFakeTimers();
    mockFirestoreState.documentByPath.set(DOCUMENT_PATH, { ...DEFAULT_SETTINGS });
    const { service, noticeList, errorNoticeList } = createService({ resubscribeInitialDelayMs: 1000 });
    track(service);
    const eventList: string[] = [];
    service.on(FIREBASE_SERVICE_EVENT.ConnectionLost, (event: { reason: string }) => eventList.push(`lost:${event.reason}`));
    service.on(FIREBASE_SERVICE_EVENT.ConnectionRestored, () => eventList.push('restored'));

    await service.initialize();
    activeListenerList()[0].isActive = false;
    mockFirestoreState.listenerList[0].onError(new Error('RESOURCE_EXHAUSTED'));

    expect(service.isConnected()).toBe(false);
    expect(activeListenerList()).toHaveLength(0);

    jest.advanceTimersByTime(999);
    expect(activeListenerList()).toHaveLength(0);

    jest.advanceTimersByTime(1);
    expect(activeListenerList()).toHaveLength(1);
    expect(service.isConnected()).toBe(true);
    expect(eventList).toEqual(['lost:listenerError', 'restored']);

    await flushMicrotasks();
    expect(errorNoticeList).toEqual(['Firebase connection lost (listenerError) — retrying']);
    expect(noticeList).toContain('Firebase connection restored');
  });

  it('doubles the pause while the re-opened subscription keeps failing', () => {
    jest.useFakeTimers();
    const { service } = createService({ resubscribeInitialDelayMs: 100, resubscribeMaxDelayMs: 250 });
    track(service);
    const internals = service as unknown as { subscribeToDataChanges: () => void; handleListenerError: (error: Error) => void };
    const subscribeSpy = jest.spyOn(internals, 'subscribeToDataChanges').mockImplementation(() => {
      internals.handleListenerError(new Error('still failing'));
    });

    internals.handleListenerError(new Error('first'));
    jest.advanceTimersByTime(100);
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(199);
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(subscribeSpy).toHaveBeenCalledTimes(2);
    // Capped at resubscribeMaxDelayMs.
    jest.advanceTimersByTime(250);
    expect(subscribeSpy).toHaveBeenCalledTimes(3);
  });
});

describe('FirebaseServiceBase — snapshot watchdog', () => {
  it('repairs a cache that silently went stale, emits dataChanged and re-opens the subscription', async () => {
    mockFirestoreState.documentByPath.set(DOCUMENT_PATH, { ...DEFAULT_SETTINGS });
    const { service, noticeList } = createService();
    track(service);
    await service.initialize();

    const changedList: { current: TestSettings; previous: TestSettings }[] = [];
    const divergedList: { divergentKeyList: string[] }[] = [];
    service.on(FIREBASE_SERVICE_EVENT.DataChanged, event => changedList.push(event));
    service.on(FIREBASE_SERVICE_EVENT.SnapshotDiverged, event => divergedList.push(event));

    // The live subscription died without a word: a change in Firestore never reaches the app.
    mockFirestoreState.isEchoMuted = true;
    for (const listener of activeListenerList()) {
      listener.isActive = false;
    }
    mockFirestoreState.documentByPath.set(DOCUMENT_PATH, { ...DEFAULT_SETTINGS, volumeUsdt: 250 });
    mockFirestoreState.isEchoMuted = false;

    expect(service.getData().volumeUsdt).toBe(100);

    await service.checkSnapshotFreshness();

    expect(service.getData().volumeUsdt).toBe(250);
    expect(changedList[0].previous.volumeUsdt).toBe(100);
    expect(changedList.some(event => event.current.volumeUsdt === 250)).toBe(true);
    expect(divergedList[0].divergentKeyList).toEqual(['volumeUsdt']);
    expect(activeListenerList()).toHaveLength(1);

    await flushMicrotasks();
    expect(noticeList.filter(message => message.includes('diverged'))).toHaveLength(1);
  });

  it('stays quiet when the cache matches, whatever the key order', async () => {
    mockFirestoreState.documentByPath.set(DOCUMENT_PATH, { general: { trigger: { ratioPercent: 5, periodMinutes: 30 } }, volumeUsdt: 100, isActive: false });
    const { service } = createService();
    track(service);
    await service.initialize();
    const divergedHandler = jest.fn();
    service.on(FIREBASE_SERVICE_EVENT.SnapshotDiverged, divergedHandler);

    await service.checkSnapshotFreshness();

    expect(divergedHandler).not.toHaveBeenCalled();
  });

  it('reports a failed re-read as a lost connection and the next good one as restored', async () => {
    mockFirestoreState.documentByPath.set(DOCUMENT_PATH, { ...DEFAULT_SETTINGS });
    const { service } = createService();
    track(service);
    await service.initialize();
    const eventList: string[] = [];
    service.on(FIREBASE_SERVICE_EVENT.ConnectionLost, (event: { reason: string }) => eventList.push(`lost:${event.reason}`));
    service.on(FIREBASE_SERVICE_EVENT.ConnectionRestored, () => eventList.push('restored'));

    mockFirestoreState.failGetCount = 1;
    await service.checkSnapshotFreshness();
    await service.checkSnapshotFreshness();

    expect(eventList).toEqual(['lost:watchdogReadFailed', 'restored']);
  });

  it('runs on its own interval when configured', async () => {
    jest.useFakeTimers();
    mockFirestoreState.documentByPath.set(DOCUMENT_PATH, { ...DEFAULT_SETTINGS });
    const { service } = createService({ snapshotWatchdogIntervalMs: 60_000 });
    track(service);
    await service.initialize();
    const checkSpy = jest.spyOn(service, 'checkSnapshotFreshness').mockResolvedValue();

    jest.advanceTimersByTime(60_000);

    expect(checkSpy).toHaveBeenCalledTimes(1);
  });
});

describe('FirebaseServiceBase — disk copy of the last good snapshot', () => {
  let directory: string;
  let cacheFilePath: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'firebase-cache-'));
    cacheFilePath = path.join(directory, 'settings.json');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('saves the document on disk after a good start', async () => {
    mockFirestoreState.documentByPath.set(DOCUMENT_PATH, { ...DEFAULT_SETTINGS, volumeUsdt: 300 });
    const { service } = createService({ snapshotCacheFilePath: cacheFilePath });
    track(service);
    await service.initialize();

    const diskCopy = JSON.parse(readFileSync(cacheFilePath, 'utf8')) as { documentPath: string; data: TestSettings };

    expect(diskCopy.documentPath).toBe(DOCUMENT_PATH);
    expect(diskCopy.data.volumeUsdt).toBe(300);
  });

  it('starts from the disk copy when Firestore is unreachable, then reconnects and reloads', async () => {
    writeFileSync(cacheFilePath, JSON.stringify({ documentPath: DOCUMENT_PATH, savedAtMs: Date.UTC(2026, 8, 25), data: { ...DEFAULT_SETTINGS, isActive: true, volumeUsdt: 300 } }));
    mockFirestoreState.documentByPath.set(DOCUMENT_PATH, { ...DEFAULT_SETTINGS, isActive: true, volumeUsdt: 400 });
    mockFirestoreState.failGetCount = 1;
    const { service, errorNoticeList, noticeList } = createService({ snapshotCacheFilePath: cacheFilePath, connectionRetryIntervalMs: 20 });
    track(service);
    const startedHandler = jest.fn();
    const restoredHandler = jest.fn();
    service.on(FIREBASE_SERVICE_EVENT.StartedFromDiskCopy, startedHandler);
    service.on(FIREBASE_SERVICE_EVENT.ConnectionRestored, restoredHandler);

    await expect(service.initialize()).resolves.toBeUndefined();

    expect(service.getData().volumeUsdt).toBe(300);
    expect(service.isConnected()).toBe(false);
    expect(startedHandler).toHaveBeenCalledWith(expect.objectContaining({ savedAtMs: Date.UTC(2026, 8, 25) }));
    await flushMicrotasks();
    expect(errorNoticeList[0]).toContain('running on the local copy saved at 2026-09-25T00:00:00.000Z');

    await new Promise(resolve => setTimeout(resolve, 60));

    expect(service.isConnected()).toBe(true);
    expect(restoredHandler).toHaveBeenCalledTimes(1);
    expect(service.getData().volumeUsdt).toBe(400);
    expect(noticeList).toContain('Firebase connection restored');
  });

  it('gives up on a hanging first read after the cap and uses the disk copy', async () => {
    writeFileSync(cacheFilePath, JSON.stringify({ documentPath: DOCUMENT_PATH, savedAtMs: 1, data: { ...DEFAULT_SETTINGS, volumeUsdt: 300 } }));
    mockFirestoreState.isGetHanging = true;
    const { service } = createService({ snapshotCacheFilePath: cacheFilePath, initialReadTimeoutMs: 20, connectionRetryIntervalMs: 60_000 });
    track(service);

    await service.initialize();

    expect(service.getData().volumeUsdt).toBe(300);
  });

  it('refuses a disk copy of ANOTHER document and throws as before', async () => {
    writeFileSync(cacheFilePath, JSON.stringify({ documentPath: 'bot-bybit/settings', savedAtMs: 1, data: { ...DEFAULT_SETTINGS } }));
    mockFirestoreState.failGetCount = 1;
    const { service } = createService({ snapshotCacheFilePath: cacheFilePath });
    track(service);

    await expect(service.initialize()).rejects.toThrow('UNAVAILABLE');
  });
});

describe('FirebaseServiceBase — written value visible immediately', () => {
  it('shows a written value at once, even before Firestore echoes it back', async () => {
    mockFirestoreState.documentByPath.set(DOCUMENT_PATH, { ...DEFAULT_SETTINGS });
    const { service } = createService();
    track(service);
    await service.initialize();

    mockFirestoreState.isEchoMuted = true;
    await service.updateData({ volumeUsdt: 500 });

    expect(service.getData().volumeUsdt).toBe(500);
  });

  it('merges a nested write into the stored settings instead of replacing the whole branch', async () => {
    mockFirestoreState.documentByPath.set(DOCUMENT_PATH, { ...DEFAULT_SETTINGS });
    const { service } = createService();
    track(service);
    await service.initialize();

    mockFirestoreState.isEchoMuted = true;
    await service.updateData({ general: { trigger: { ratioPercent: 7 } } } as Partial<TestSettings>);

    expect(service.getData().general.trigger).toEqual({ periodMinutes: 30, ratioPercent: 7 });
  });

  it('lets a later change made elsewhere show once the pending value expired', async () => {
    mockFirestoreState.documentByPath.set(DOCUMENT_PATH, { ...DEFAULT_SETTINGS });
    const { service } = createService({ pendingWriteMaxAgeMs: 10 });
    track(service);
    await service.initialize();

    mockFirestoreState.isEchoMuted = true;
    await service.updateData({ volumeUsdt: 500 });
    (service as unknown as { currentData: TestSettings }).currentData = { ...DEFAULT_SETTINGS, volumeUsdt: 700 };

    expect(service.getData().volumeUsdt).toBe(500);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(service.getData().volumeUsdt).toBe(700);
  });

  it('drops the pending value as soon as the echo confirms it', async () => {
    mockFirestoreState.documentByPath.set(DOCUMENT_PATH, { ...DEFAULT_SETTINGS });
    const { service } = createService();
    track(service);
    await service.initialize();

    await service.updateData({ volumeUsdt: 500 });

    expect((service as unknown as { pendingWriteByPath: Map<string, unknown> }).pendingWriteByPath.size).toBe(0);
    expect(service.getData().volumeUsdt).toBe(500);
  });

  it('keeps the old value showing when the write is rejected', async () => {
    const { service } = createService();
    track(service);
    // No initialize(): the document does not exist, so update() is refused with NOT_FOUND.
    await expect(service.updateData({ volumeUsdt: 500 })).rejects.toThrow('NOT_FOUND');

    expect(service.getData().volumeUsdt).toBe(100);
  });

  it('can be switched off', async () => {
    mockFirestoreState.documentByPath.set(DOCUMENT_PATH, { ...DEFAULT_SETTINGS });
    const { service } = createService({ isWriteVisibleImmediately: false });
    track(service);
    await service.initialize();

    mockFirestoreState.isEchoMuted = true;
    await service.updateData({ volumeUsdt: 500 });

    expect(service.getData().volumeUsdt).toBe(100);
  });
});

describe('FirebaseServiceBase — sibling documents and maps of items', () => {
  it('reads and merge-writes a document next to the settings', async () => {
    const { service } = createService();
    track(service);

    await expect(service.readSiblingDocument('pinned')).resolves.toBeNull();

    await service.writeSiblingDocument('pinned', { messageIdList: [1, 2] });
    await service.writeSiblingDocument('pinned', { chatId: '7' });

    await expect(service.readSiblingDocument('pinned')).resolves.toEqual({ messageIdList: [1, 2], chatId: '7' });
    expect(mockFirestoreState.documentByPath.has('bot-binance/pinned')).toBe(true);
  });

  it('sets, updates and removes one item of a map field without touching the others', async () => {
    mockFirestoreState.documentByPath.set(DOCUMENT_PATH, { ...DEFAULT_SETTINGS, chasers: { A: { price: 1, side: 'long' } } });
    const { service } = createService();
    track(service);
    await service.initialize();

    await service.setMapItem('chasers', 'B', { price: 2, side: 'short' });
    await service.updateMapItem('chasers', 'A', { price: 1.5 });

    expect(storedSettings()?.chasers).toEqual({ A: { price: 1.5, side: 'long' }, B: { price: 2, side: 'short' } });

    await service.setMapItem('chasers', 'A', { price: 9 });
    await service.removeMapItem('chasers', 'B');

    // set replaces the item wholly — a stale field of the old item must not survive.
    expect(storedSettings()?.chasers).toEqual({ A: { price: 9 } });
  });

  it('works on the top-level fields of a sibling document (ma-chaser "chasers" layout), dotted ids included', async () => {
    const { service } = createService();
    track(service);
    const location = { siblingDocumentName: 'chasers' };

    await service.setMapItem(location, 'BTCUSDT.P', { price: 2 });
    await service.updateMapItem(location, 'BTCUSDT.P', { price: 3 });

    expect(mockFirestoreState.documentByPath.get('bot-binance/chasers')).toEqual({ 'BTCUSDT.P': { price: 3 } });

    await service.removeMapItem(location, 'BTCUSDT.P');

    expect(mockFirestoreState.documentByPath.get('bot-binance/chasers')).toEqual({});
  });
});
