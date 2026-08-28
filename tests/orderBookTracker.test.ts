import type { ExchangeClient, OrderBookHandler, OrderBookUpdate } from '@solncebro/exchange-engine';
import { ExchangeNameEnum } from '@solncebro/exchange-engine';

import { OrderBookTracker, resolveOrderBookStreamDepth } from '../src/services/orderBookTracker';

jest.mock('../src/core/logger', () => ({
  logger: { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() },
}));

interface FakeClient {
  subscribeOrderbook: jest.Mock;
  unsubscribeOrderbook: jest.Mock;
  resubscribeOrderbook: jest.Mock;
  handlerBySymbol: Map<string, OrderBookHandler>;
}

function buildFakeClient(): FakeClient {
  const handlerBySymbol = new Map<string, OrderBookHandler>();

  return {
    handlerBySymbol,
    subscribeOrderbook: jest.fn(({ symbol, handler }: { symbol: string; handler: OrderBookHandler }) => {
      handlerBySymbol.set(symbol, handler);
    }),
    unsubscribeOrderbook: jest.fn(({ symbol }: { symbol: string }) => {
      handlerBySymbol.delete(symbol);
    }),
    resubscribeOrderbook: jest.fn(),
  };
}

function buildTracker(client: FakeClient, now?: () => number): OrderBookTracker {
  return new OrderBookTracker({ client: client as unknown as ExchangeClient, depth: 50, clientLabel: 'Test Futures', now });
}

function frame(symbol: string, updateType: 'snapshot' | 'delta', updateId: number, askList: Array<[string, string]>, bidList: Array<[string, string]> = []): OrderBookUpdate {
  return { symbol, updateType, updateId, askList, bidList, eventTimestamp: 1_000 + updateId, receivedTimestamp: 2_000 + updateId };
}

function emit(client: FakeClient, update: OrderBookUpdate): void {
  const handler = client.handlerBySymbol.get(update.symbol);

  if (handler === undefined) {
    throw new Error(`no handler for ${update.symbol}`);
  }

  handler(update.symbol, update);
}

describe('OrderBookTracker', () => {
  it('opens the topic on the first subscribe and closes it on the last unsubscribe', () => {
    const client = buildFakeClient();
    const tracker = buildTracker(client);

    tracker.subscribe('AAAUSDT');
    tracker.subscribe('AAAUSDT');

    expect(client.subscribeOrderbook).toHaveBeenCalledTimes(1);
    expect(client.subscribeOrderbook).toHaveBeenCalledWith({ symbol: 'AAAUSDT', depth: 50, handler: expect.any(Function) });

    tracker.unsubscribe('AAAUSDT');
    expect(client.unsubscribeOrderbook).not.toHaveBeenCalled();
    expect(tracker.isSubscribed('AAAUSDT')).toBe(true);

    tracker.unsubscribe('AAAUSDT');
    expect(client.unsubscribeOrderbook).toHaveBeenCalledTimes(1);
    // The SAME handler ref the stream stored by reference — otherwise the topic would leak.
    expect(client.unsubscribeOrderbook.mock.calls[0][0].handler).toBe(client.subscribeOrderbook.mock.calls[0][0].handler);
    expect(tracker.isSubscribed('AAAUSDT')).toBe(false);
  });

  it('reads null until the first snapshot lands, then a sorted numeric book', () => {
    const client = buildFakeClient();
    const tracker = buildTracker(client);

    tracker.subscribe('AAAUSDT');
    expect(tracker.getBook('AAAUSDT')).toBeNull();

    emit(client, frame('AAAUSDT', 'snapshot', 10, [['100.5', '3'], ['100.1', '1'], ['100.3', '0']], [['99.5', '2'], ['99.9', '4']]));

    const book = tracker.getBook('AAAUSDT');

    expect(book?.askList).toEqual([{ price: 100.1, quantity: 1 }, { price: 100.5, quantity: 3 }]);
    expect(book?.bidList).toEqual([{ price: 99.9, quantity: 4 }, { price: 99.5, quantity: 2 }]);
    expect(book?.updateId).toBe(10);
    expect(book?.eventTimestamp).toBe(1_010);
  });

  it('applies deltas in place: update, insert, delete', () => {
    const client = buildFakeClient();
    const tracker = buildTracker(client);

    tracker.subscribe('AAAUSDT');
    emit(client, frame('AAAUSDT', 'snapshot', 10, [['100.1', '1'], ['100.5', '3']], [['99.9', '4']]));
    emit(client, frame('AAAUSDT', 'delta', 11, [['100.1', '5'], ['100.3', '2'], ['100.5', '0']], [['99.8', '1']]));

    const book = tracker.getBook('AAAUSDT');

    expect(book?.askList).toEqual([{ price: 100.1, quantity: 5 }, { price: 100.3, quantity: 2 }]);
    expect(book?.bidList).toEqual([{ price: 99.9, quantity: 4 }, { price: 99.8, quantity: 1 }]);
    expect(book?.updateId).toBe(11);
  });

  it('a Binance partial-depth frame (always a snapshot) replaces the book wholesale', () => {
    const client = buildFakeClient();
    const tracker = buildTracker(client);

    tracker.subscribe('AAAUSDT');
    emit(client, frame('AAAUSDT', 'snapshot', 10, [['100.1', '1'], ['100.5', '3']]));
    emit(client, frame('AAAUSDT', 'snapshot', 40, [['100.2', '7']]));

    expect(tracker.getBook('AAAUSDT')?.askList).toEqual([{ price: 100.2, quantity: 7 }]);
  });

  it('drops the book and resubscribes on a delta sequence gap, debounced per symbol', () => {
    const client = buildFakeClient();
    let nowMs = 100_000;
    const tracker = buildTracker(client, () => nowMs);

    tracker.subscribe('AAAUSDT');
    emit(client, frame('AAAUSDT', 'snapshot', 10, [['100.1', '1']]));
    emit(client, frame('AAAUSDT', 'delta', 13, [['100.1', '9']]));

    expect(tracker.getBook('AAAUSDT')).toBeNull();
    expect(client.resubscribeOrderbook).toHaveBeenCalledWith({ symbol: 'AAAUSDT', depth: 50 });

    // A second gap within the debounce window does not hammer the stream.
    emit(client, frame('AAAUSDT', 'snapshot', 20, [['100.1', '1']]));
    nowMs += 1_000;
    emit(client, frame('AAAUSDT', 'delta', 25, [['100.1', '9']]));
    expect(client.resubscribeOrderbook).toHaveBeenCalledTimes(1);

    // The fresh snapshot restores reads.
    emit(client, frame('AAAUSDT', 'snapshot', 30, [['100.4', '2']]));
    expect(tracker.getBook('AAAUSDT')?.askList).toEqual([{ price: 100.4, quantity: 2 }]);
  });

  it('ignores a delta that arrives before any snapshot', () => {
    const client = buildFakeClient();
    const tracker = buildTracker(client);

    tracker.subscribe('AAAUSDT');
    emit(client, frame('AAAUSDT', 'delta', 11, [['100.1', '5']]));

    expect(tracker.getBook('AAAUSDT')).toBeNull();
    expect(client.resubscribeOrderbook).not.toHaveBeenCalled();
  });

  it('a frame that outlives its subscription does not resurrect the book', () => {
    const client = buildFakeClient();
    const tracker = buildTracker(client);

    tracker.subscribe('AAAUSDT');
    const handler = client.subscribeOrderbook.mock.calls[0][0].handler as OrderBookHandler;

    tracker.unsubscribe('AAAUSDT');
    handler('AAAUSDT', frame('AAAUSDT', 'snapshot', 10, [['100.1', '1']]));

    expect(tracker.getBook('AAAUSDT')).toBeNull();
  });

  it('hands out copies — a reader cannot mutate the live book', () => {
    const client = buildFakeClient();
    const tracker = buildTracker(client);

    tracker.subscribe('AAAUSDT');
    emit(client, frame('AAAUSDT', 'snapshot', 10, [['100.1', '1']]));

    const book = tracker.getBook('AAAUSDT');

    (book?.askList as Array<{ price: number; quantity: number }>).push({ price: 1, quantity: 1 });
    expect(tracker.getBook('AAAUSDT')?.askList).toHaveLength(1);
  });

  it('stop() closes every topic', () => {
    const client = buildFakeClient();
    const tracker = buildTracker(client);

    tracker.subscribe('AAAUSDT');
    tracker.subscribe('AAAUSDT');
    tracker.subscribe('BBBUSDT');
    tracker.stop();

    expect(client.unsubscribeOrderbook).toHaveBeenCalledTimes(2);
    expect(tracker.getSubscribedSymbolList()).toEqual([]);
  });

  it('lets a subscribe failure surface and does not count the symbol', () => {
    const client = buildFakeClient();

    client.subscribeOrderbook.mockImplementation(() => {
      throw new Error('Orderbook subscription not supported for spot market');
    });

    const tracker = buildTracker(client);

    expect(() => tracker.subscribe('AAAUSDT')).toThrow('not supported');
    expect(tracker.isSubscribed('AAAUSDT')).toBe(false);
  });
});

describe('resolveOrderBookStreamDepth', () => {
  it('serves the fixed depth each exchange offers', () => {
    expect(resolveOrderBookStreamDepth(ExchangeNameEnum.Binance)).toBe(20);
    expect(resolveOrderBookStreamDepth(ExchangeNameEnum.Bybit)).toBe(50);
  });
});
