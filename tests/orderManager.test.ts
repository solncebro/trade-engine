import { OrderManager } from '../src/core/OrderManager';
import type { ConfirmedCancelInfo, ExhaustedCancelInfo } from '../src/core/OrderManager.types';

jest.mock('../src/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn(), fatal: jest.fn() },
  createLogger: jest.fn(),
}));

function createMockExchange() {
  const getOrder = jest.fn(async (_symbol: string, _orderId: string): Promise<{ status: string; filledAmount?: number; avgPrice?: number } | null> => ({ status: 'open', filledAmount: 0 }));
  const cancelOrder = jest.fn(async (_args: { symbol: string; orderId: string }) => undefined);
  const cancelBatchOrders = jest.fn(async (_args: { symbol: string; orderIdList: string[] }) =>
    _args.orderIdList.map((orderId) => ({ orderId, isSuccess: true, errorCode: null, errorText: null })),
  );
  const placeStopLoss = jest.fn(async (_args: Record<string, unknown>): Promise<{ orderId?: string; errorText?: string }> => ({ orderId: 'sl-default' }));
  const openPositionLimit = jest.fn(async (_args: Record<string, unknown>): Promise<{ orderId?: string; errorText?: string }> => ({ orderId: 'order-default' }));
  const closePositionMarket = jest.fn(async (_args: Record<string, unknown>): Promise<{ orderId?: string; errorText?: string }> => ({ orderId: 'close-default' }));
  const closePositionLimit = jest.fn(async (_args: Record<string, unknown>): Promise<{ orderId?: string; errorText?: string }> => ({ orderId: 'tp-default' }));
  const openPositionBatchLimit = jest.fn(
    async (args: { itemList: Array<{ direction: string; amount: number; price: number }>; leverage?: number; marginMode?: unknown }): Promise<Array<{ isSuccess: boolean; orderId: string | null; errorText: string | null }>> =>
      args.itemList.map((_, index) => ({ isSuccess: true, orderId: `order-batch-${index + 1}`, errorText: null })),
  );
  const closePositionBatchLimit = jest.fn(
    async (args: { itemList: Array<{ direction: string; amount: number; price: number }>; leverage?: number; marginMode?: unknown }): Promise<Array<{ isSuccess: boolean; orderId: string | null; errorText: string | null }>> =>
      args.itemList.map((_, index) => ({ isSuccess: true, orderId: `tp-batch-${index + 1}`, errorText: null })),
  );

  const exchangeConnector = {
    futures: { getOrder },
    positionManager: { cancelOrder, cancelBatchOrders, placeStopLoss, openPositionLimit, closePositionMarket, closePositionLimit, openPositionBatchLimit, closePositionBatchLimit },
  };

  return { exchangeConnector, getOrder, cancelOrder, cancelBatchOrders, placeStopLoss, openPositionLimit, closePositionMarket, closePositionLimit, openPositionBatchLimit, closePositionBatchLimit };
}

function createMockTelegramNotifier() {
  return {
    sendMessage: jest.fn(async (_message: string) => undefined),
  };
}

describe('OrderManager', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('enqueueCancel — WS confirm (canceled) inside immediate-verify-window resolves to cancelled', async () => {
    const { exchangeConnector, getOrder, cancelOrder } = createMockExchange();
    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    const onConfirmed = jest.fn();

    const promise = tracker.enqueueCancel({
      symbol: 'BTCUSDT',
      orderId: 'order-1',
      modulePrefix: '[Test]',
      contextLabel: 'unit-test',
      onConfirmed,
    });

    // Wait microtask cycle so initial cancelOrder runs
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // WS arrives while we're inside the 1500ms wait
    tracker.handleOrderUpdate({ symbol: 'BTCUSDT', orderId: 'order-1', clientOrderId: '', side: 'buy' as never, status: 'canceled', price: 0, avgPrice: 0, amount: 1, filledAmount: 0, timestamp: 0 });

    await jest.advanceTimersByTimeAsync(1500);
    const outcome = await promise;

    expect(cancelOrder).toHaveBeenCalledTimes(1);
    expect(getOrder).not.toHaveBeenCalled(); // WS confirmed before REST verify
    expect(outcome.immediateResult).toBe('cancelled');
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(onConfirmed.mock.calls[0][0]).toMatchObject({ kind: 'cancelled', source: 'ws', orderId: 'order-1' });

    await tracker.shutdown();
  });

  it('enqueueCancel — REST verify (canceled) after IMMEDIATE_VERIFY_WAIT_MS resolves to cancelled', async () => {
    const { exchangeConnector, getOrder } = createMockExchange();
    getOrder.mockResolvedValue({ status: 'canceled', filledAmount: 0 });
    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    const onConfirmed = jest.fn();

    const promise = tracker.enqueueCancel({
      symbol: 'BTCUSDT',
      orderId: 'order-1',
      modulePrefix: '[Test]',
      contextLabel: 'unit-test',
      onConfirmed,
    });

    await jest.advanceTimersByTimeAsync(1500);
    const outcome = await promise;

    expect(outcome.immediateResult).toBe('cancelled');
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(onConfirmed.mock.calls[0][0]).toMatchObject({ kind: 'cancelled', source: 'rest', orderId: 'order-1' });

    await tracker.shutdown();
  });

  it('enqueueCancel — REST verify (closed) detects fill and returns filled', async () => {
    const { exchangeConnector, getOrder } = createMockExchange();
    getOrder.mockResolvedValue({ status: 'closed', filledAmount: 1, avgPrice: 65000 });
    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    const onConfirmed = jest.fn();

    const promise = tracker.enqueueCancel({
      symbol: 'BTCUSDT',
      orderId: 'order-1',
      modulePrefix: '[Test]',
      contextLabel: 'unit-test',
      onConfirmed,
    });

    await jest.advanceTimersByTimeAsync(1500);
    const outcome = await promise;

    expect(outcome.immediateResult).toBe('filled');
    expect(outcome.filledAmount).toBe(1);
    expect(onConfirmed).toHaveBeenCalledTimes(1);

    const info = onConfirmed.mock.calls[0][0] as ConfirmedCancelInfo;
    expect(info.kind).toBe('filled');
    if (info.kind === 'filled') {
      expect(info.avgPrice).toBe(65000);
      expect(info.filledAmount).toBe(1);
    }

    await tracker.shutdown();
  });

  it('enqueueCancel — partial fill on canceled status returns partial_then_terminal', async () => {
    const { exchangeConnector, getOrder } = createMockExchange();
    getOrder.mockResolvedValue({ status: 'canceled', filledAmount: 0.5 });
    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    const onConfirmed = jest.fn();

    const promise = tracker.enqueueCancel({
      symbol: 'BTCUSDT',
      orderId: 'order-1',
      modulePrefix: '[Test]',
      contextLabel: 'unit-test',
      onConfirmed,
    });

    await jest.advanceTimersByTimeAsync(1500);
    const outcome = await promise;

    expect(outcome.immediateResult).toBe('filled');
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(onConfirmed.mock.calls[0][0]).toMatchObject({ kind: 'partial_then_terminal', filledAmount: 0.5, status: 'canceled' });

    await tracker.shutdown();
  });

  it('enqueueCancel — open status returns pending; tick retry eventually confirms', async () => {
    const { exchangeConnector, getOrder, cancelOrder } = createMockExchange();
    getOrder.mockResolvedValue({ status: 'open', filledAmount: 0 });
    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    tracker.start();

    const onConfirmed = jest.fn();

    const promise = tracker.enqueueCancel({
      symbol: 'BTCUSDT',
      orderId: 'order-1',
      modulePrefix: '[Test]',
      contextLabel: 'unit-test',
      onConfirmed,
    });

    await jest.advanceTimersByTimeAsync(1500);
    const outcome = await promise;

    expect(outcome.immediateResult).toBe('pending');
    expect(outcome.isStillTracked).toBe(true);
    expect(cancelOrder).toHaveBeenCalledTimes(1);

    // Make subsequent verify resolve as canceled
    getOrder.mockResolvedValue({ status: 'canceled', filledAmount: 0 });

    // PER_ENTRY_COOLDOWN_MS = 2000, TICK_INTERVAL_MS = 1000.
    // Advance enough for next tick to fire & complete its async work.
    await jest.advanceTimersByTimeAsync(3000);
    await jest.advanceTimersByTimeAsync(100);

    expect(onConfirmed).toHaveBeenCalled();
    expect(onConfirmed.mock.calls[0][0]).toMatchObject({ kind: 'cancelled' });

    await tracker.shutdown();
  });

  it('enqueueCancel — repeated enqueue of same orderId merges callbacks', async () => {
    const { exchangeConnector, getOrder } = createMockExchange();
    getOrder.mockResolvedValue({ status: 'open', filledAmount: 0 });
    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    const onConfirmedA = jest.fn();
    const onConfirmedB = jest.fn();

    const promiseA = tracker.enqueueCancel({
      symbol: 'BTCUSDT',
      orderId: 'order-1',
      modulePrefix: '[Test]',
      contextLabel: 'caller-a',
      onConfirmed: onConfirmedA,
    });

    // Second enqueue (same orderId) — should merge
    const outcomeB = await tracker.enqueueCancel({
      symbol: 'BTCUSDT',
      orderId: 'order-1',
      modulePrefix: '[Test]',
      contextLabel: 'caller-b',
      onConfirmed: onConfirmedB,
    });

    expect(outcomeB.immediateResult).toBe('pending');
    expect(outcomeB.isStillTracked).toBe(true);

    // Now WS confirms — both callbacks should fire
    tracker.handleOrderUpdate({ symbol: 'BTCUSDT', orderId: 'order-1', clientOrderId: '', side: 'buy' as never, status: 'canceled', price: 0, avgPrice: 0, amount: 1, filledAmount: 0, timestamp: 0 });

    await jest.advanceTimersByTimeAsync(1500);
    await promiseA;

    expect(onConfirmedA).toHaveBeenCalledTimes(1);
    expect(onConfirmedB).toHaveBeenCalledTimes(1);

    await tracker.shutdown();
  });

  it('tick loop — exhaust after MAX_ATTEMPTS calls onExhausted + Telegram alert', async () => {
    const { exchangeConnector, getOrder } = createMockExchange();
    // Order never becomes terminal — every getOrder returns 'open'
    getOrder.mockResolvedValue({ status: 'open', filledAmount: 0 });
    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    tracker.start();

    const onConfirmed = jest.fn();
    const onExhausted = jest.fn();

    const promise = tracker.enqueueCancel({
      symbol: 'BTCUSDT',
      orderId: 'order-stuck',
      modulePrefix: '[Test]',
      contextLabel: 'unit-test',
      onConfirmed,
      onExhausted,
    });

    await jest.advanceTimersByTimeAsync(1500);
    await promise;

    // 8 max attempts, 2000ms cooldown each → ~16s total
    // First attempt was inside enqueueCancel (attempt 1)
    // Subsequent attempts via tick loop
    await jest.advanceTimersByTimeAsync(20_000);
    await jest.advanceTimersByTimeAsync(100);

    expect(onConfirmed).not.toHaveBeenCalled();
    expect(onExhausted).toHaveBeenCalledTimes(1);

    const info = onExhausted.mock.calls[0][0] as ExhaustedCancelInfo;
    expect(info.reason).toBe('max_attempts');
    expect(info.orderId).toBe('order-stuck');

    expect(telegramNotifier.sendMessage).toHaveBeenCalled();
    const alertText = telegramNotifier.sendMessage.mock.calls.find((args) => String(args[0]).includes('EXHAUSTED'))?.[0];
    expect(alertText).toBeDefined();
    expect(String(alertText)).toContain('order-stuck');

    await tracker.shutdown();
  });

  it('shutdown — pending entries exhaust with reason=shutdown', async () => {
    const { exchangeConnector, getOrder } = createMockExchange();
    getOrder.mockResolvedValue({ status: 'open', filledAmount: 0 });
    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    const onExhausted = jest.fn();

    const promise = tracker.enqueueCancel({
      symbol: 'BTCUSDT',
      orderId: 'order-pending',
      modulePrefix: '[Test]',
      contextLabel: 'unit-test',
      onExhausted,
    });

    await jest.advanceTimersByTimeAsync(1500);
    await promise;

    await tracker.shutdown();

    expect(onExhausted).toHaveBeenCalledTimes(1);
    const info = onExhausted.mock.calls[0][0] as ExhaustedCancelInfo;
    expect(info.reason).toBe('shutdown');
    expect(info.orderId).toBe('order-pending');

    expect(telegramNotifier.sendMessage).toHaveBeenCalled();
  });

  it('enqueueCancelBatch — successful batch + REST verify confirms all', async () => {
    const { exchangeConnector, getOrder, cancelBatchOrders } = createMockExchange();
    getOrder.mockResolvedValue({ status: 'canceled', filledAmount: 0 });
    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    const onConfirmed = jest.fn();

    const promise = tracker.enqueueCancelBatch({
      symbol: 'BTCUSDT',
      orderIdList: ['o1', 'o2', 'o3'],
      modulePrefix: '[Test]',
      contextLabel: 'batch-test',
      onConfirmed,
    });

    await jest.advanceTimersByTimeAsync(1500);
    const outcome = await promise;

    expect(cancelBatchOrders).toHaveBeenCalledTimes(1);
    expect(outcome.cancelledOrderIdList).toHaveLength(3);
    expect(outcome.pendingOrderIdList).toHaveLength(0);
    expect(outcome.failedToSendOrderIdList).toHaveLength(0);
    expect(onConfirmed).toHaveBeenCalledTimes(3);

    await tracker.shutdown();
  });

  it('enqueueCancelBatch — batch send fails, entries remain pending', async () => {
    const { exchangeConnector, cancelBatchOrders } = createMockExchange();
    cancelBatchOrders.mockRejectedValue(new Error('exchange down'));
    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    const promise = tracker.enqueueCancelBatch({
      symbol: 'BTCUSDT',
      orderIdList: ['o1', 'o2'],
      modulePrefix: '[Test]',
      contextLabel: 'batch-fail-test',
    });

    await jest.advanceTimersByTimeAsync(1500);
    const outcome = await promise;

    expect(outcome.failedToSendOrderIdList).toEqual(['o1', 'o2']);
    expect(outcome.cancelledOrderIdList).toHaveLength(0);

    await tracker.shutdown();
  });

  it('getDiagnostics — returns current state snapshot', async () => {
    const { exchangeConnector, getOrder } = createMockExchange();
    getOrder.mockResolvedValue({ status: 'open', filledAmount: 0 });
    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    const initial = tracker.getDiagnostics();
    expect(initial.pendingCount).toBe(0);

    const promise = tracker.enqueueCancel({
      symbol: 'BTCUSDT',
      orderId: 'order-1',
      modulePrefix: '[Test]',
      contextLabel: 'unit-test',
    });

    await jest.advanceTimersByTimeAsync(1500);
    await promise;

    const afterEnqueue = tracker.getDiagnostics();
    expect(afterEnqueue.pendingCount).toBe(1);

    await tracker.shutdown();
  });

  it('enqueueReplaceStopLoss — parallel calls on same positionId serialize FIFO (no race on placeStopLoss)', async () => {
    jest.useRealTimers();

    const { exchangeConnector, placeStopLoss } = createMockExchange();
    let callIndex = 0;
    const callStartOrder: number[] = [];

    placeStopLoss.mockImplementation(async () => {
      const myIndex = callIndex++;

      callStartOrder.push(myIndex);
      await new Promise((resolve) => setTimeout(resolve, 50));

      return { orderId: `sl-${myIndex}` };
    });

    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    const args = {
      positionId: 'pos-1',
      symbol: 'BTCUSDT',
      direction: 'long' as const,
      oldOrderId: null,
      triggerPrice: 100,
      amount: 1,
    };

    const [result1, result2, result3] = await Promise.all([
      tracker.enqueueReplaceStopLoss(args),
      tracker.enqueueReplaceStopLoss(args),
      tracker.enqueueReplaceStopLoss(args),
    ]);

    expect(callStartOrder).toEqual([0, 1, 2]);
    expect(placeStopLoss).toHaveBeenCalledTimes(3);
    expect(result1.orderId).toBe('sl-0');
    expect(result2.orderId).toBe('sl-1');
    expect(result3.orderId).toBe('sl-2');

    await tracker.shutdown();
  });

  it('enqueueReplaceStopLoss — parallel calls on different positionId run in parallel', async () => {
    jest.useRealTimers();

    const { exchangeConnector, placeStopLoss } = createMockExchange();
    const concurrentCallCount = { value: 0, max: 0 };

    placeStopLoss.mockImplementation(async () => {
      concurrentCallCount.value += 1;
      concurrentCallCount.max = Math.max(concurrentCallCount.max, concurrentCallCount.value);
      await new Promise((resolve) => setTimeout(resolve, 50));
      concurrentCallCount.value -= 1;

      return { orderId: `sl-${Math.random().toString(36).slice(2)}` };
    });

    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    await Promise.all([
      tracker.enqueueReplaceStopLoss({ positionId: 'pos-A', symbol: 'BTCUSDT', direction: 'long', oldOrderId: null, triggerPrice: 100, amount: 1 }),
      tracker.enqueueReplaceStopLoss({ positionId: 'pos-B', symbol: 'ETHUSDT', direction: 'short', oldOrderId: null, triggerPrice: 3000, amount: 0.1 }),
      tracker.enqueueReplaceStopLoss({ positionId: 'pos-C', symbol: 'SOLUSDT', direction: 'long', oldOrderId: null, triggerPrice: 200, amount: 5 }),
    ]);

    expect(concurrentCallCount.max).toBeGreaterThanOrEqual(2);

    await tracker.shutdown();
  });

  it('enqueueCreateTpSplitFan + enqueueReplaceStopLoss on same positionId — serialized (no race)', async () => {
    jest.useRealTimers();

    const { exchangeConnector, placeStopLoss, closePositionBatchLimit } = createMockExchange();
    const callOrder: string[] = [];

    placeStopLoss.mockImplementation(async () => {
      callOrder.push('placeStopLoss');
      await new Promise((resolve) => setTimeout(resolve, 30));

      return { orderId: 'sl-1' };
    });

    closePositionBatchLimit.mockImplementation(async (args: { itemList: Array<{ direction: string; amount: number; price: number }> }) => {
      callOrder.push('closePositionBatchLimit');
      await new Promise((resolve) => setTimeout(resolve, 30));

      return args.itemList.map((_, index) => ({ isSuccess: true, orderId: `tp-${index + 1}`, errorText: null }));
    });

    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    await Promise.all([
      tracker.enqueueReplaceStopLoss({ positionId: 'pos-1', symbol: 'BTCUSDT', direction: 'long', oldOrderId: null, triggerPrice: 100, amount: 1 }),
      tracker.enqueueCreateTpSplitFan({ positionId: 'pos-1', symbol: 'BTCUSDT', direction: 'long', priceList: [110, 120, 130], amountList: [0.1, 0.1, 0.1] }),
    ]);

    expect(callOrder).toEqual(['placeStopLoss', 'closePositionBatchLimit']);

    await tracker.shutdown();
  });

  it('enqueueReplaceStopLoss — idempotent skip when caller passes stale oldOrderId with identical triggerPrice + amount', async () => {
    jest.useRealTimers();

    const { exchangeConnector, placeStopLoss, cancelOrder, getOrder } = createMockExchange();
    let placeCount = 0;

    placeStopLoss.mockImplementation(async () => {
      placeCount += 1;

      return { orderId: `sl-${placeCount}` };
    });

    getOrder.mockResolvedValue({ status: 'canceled', filledAmount: 0 });

    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    const firstResult = await tracker.enqueueReplaceStopLoss({
      positionId: 'pos-1',
      symbol: 'BTCUSDT',
      direction: 'long',
      oldOrderId: null,
      triggerPrice: 100,
      amount: 1,
    });

    expect(firstResult.isSuccess).toBe(true);
    expect(firstResult.orderId).toBe('sl-1');
    expect(placeStopLoss).toHaveBeenCalledTimes(1);

    const staleResult1 = await tracker.enqueueReplaceStopLoss({
      positionId: 'pos-1',
      symbol: 'BTCUSDT',
      direction: 'long',
      oldOrderId: 'stale-orderId-from-prev-snapshot',
      triggerPrice: 100,
      amount: 1,
    });

    const staleResult2 = await tracker.enqueueReplaceStopLoss({
      positionId: 'pos-1',
      symbol: 'BTCUSDT',
      direction: 'long',
      oldOrderId: 'another-stale-orderId',
      triggerPrice: 100,
      amount: 1,
    });

    expect(staleResult1.isSuccess).toBe(true);
    expect(staleResult1.orderId).toBe('sl-1');
    expect(staleResult2.isSuccess).toBe(true);
    expect(staleResult2.orderId).toBe('sl-1');
    expect(placeStopLoss).toHaveBeenCalledTimes(1);
    expect(cancelOrder).not.toHaveBeenCalled();

    await tracker.shutdown();
  });

  it('enqueueReplaceStopLoss — different triggerPrice forces cancel+place (no idempotent skip)', async () => {
    jest.useRealTimers();

    const { exchangeConnector, placeStopLoss, cancelOrder, getOrder } = createMockExchange();
    let placeCount = 0;

    placeStopLoss.mockImplementation(async () => {
      placeCount += 1;

      return { orderId: `sl-${placeCount}` };
    });

    getOrder.mockResolvedValue({ status: 'canceled', filledAmount: 0 });

    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    const first = await tracker.enqueueReplaceStopLoss({
      positionId: 'pos-1',
      symbol: 'BTCUSDT',
      direction: 'long',
      oldOrderId: null,
      triggerPrice: 100,
      amount: 1,
    });

    expect(first.orderId).toBe('sl-1');

    const second = await tracker.enqueueReplaceStopLoss({
      positionId: 'pos-1',
      symbol: 'BTCUSDT',
      direction: 'long',
      oldOrderId: 'sl-1',
      triggerPrice: 105,
      amount: 1,
    });

    expect(second.isSuccess).toBe(true);
    expect(second.orderId).toBe('sl-2');
    expect(placeStopLoss).toHaveBeenCalledTimes(2);
    expect(cancelOrder).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'sl-1' }));

    await tracker.shutdown();
  });

  it('enqueueReplaceStopLoss — different amount forces cancel+place (no idempotent skip)', async () => {
    jest.useRealTimers();

    const { exchangeConnector, placeStopLoss, cancelOrder, getOrder } = createMockExchange();
    let placeCount = 0;

    placeStopLoss.mockImplementation(async () => {
      placeCount += 1;

      return { orderId: `sl-${placeCount}` };
    });

    getOrder.mockResolvedValue({ status: 'canceled', filledAmount: 0 });

    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    await tracker.enqueueReplaceStopLoss({
      positionId: 'pos-1',
      symbol: 'BTCUSDT',
      direction: 'long',
      oldOrderId: null,
      triggerPrice: 100,
      amount: 1,
    });

    const second = await tracker.enqueueReplaceStopLoss({
      positionId: 'pos-1',
      symbol: 'BTCUSDT',
      direction: 'long',
      oldOrderId: 'sl-1',
      triggerPrice: 100,
      amount: 2,
    });

    expect(second.orderId).toBe('sl-2');
    expect(placeStopLoss).toHaveBeenCalledTimes(2);
    expect(cancelOrder).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'sl-1' }));

    await tracker.shutdown();
  });

  it('enqueueReplaceStopLoss — caller passes oldOrderId=null skips idempotency (verifyAndRestore semantics)', async () => {
    jest.useRealTimers();

    const { exchangeConnector, placeStopLoss } = createMockExchange();
    let placeCount = 0;

    placeStopLoss.mockImplementation(async () => {
      placeCount += 1;

      return { orderId: `sl-${placeCount}` };
    });

    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    await tracker.enqueueReplaceStopLoss({
      positionId: 'pos-1',
      symbol: 'BTCUSDT',
      direction: 'long',
      oldOrderId: null,
      triggerPrice: 100,
      amount: 1,
    });

    const second = await tracker.enqueueReplaceStopLoss({
      positionId: 'pos-1',
      symbol: 'BTCUSDT',
      direction: 'long',
      oldOrderId: null,
      triggerPrice: 100,
      amount: 1,
    });

    expect(second.orderId).toBe('sl-2');
    expect(placeStopLoss).toHaveBeenCalledTimes(2);

    await tracker.shutdown();
  });

  it('enqueueReplaceStopLoss — failed place does not persist snapshot; next call attempts placement again', async () => {
    jest.useRealTimers();

    const { exchangeConnector, placeStopLoss } = createMockExchange();
    let placeCount = 0;

    placeStopLoss.mockImplementation(async () => {
      placeCount += 1;

      if (placeCount === 1) {
        return { errorText: 'exchange rejected' };
      }

      return { orderId: `sl-${placeCount}` };
    });

    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    const first = await tracker.enqueueReplaceStopLoss({
      positionId: 'pos-1',
      symbol: 'BTCUSDT',
      direction: 'long',
      oldOrderId: null,
      triggerPrice: 100,
      amount: 1,
    });

    expect(first.isSuccess).toBe(false);
    expect(first.orderId).toBeNull();
    expect(first.errorText).toBe('exchange rejected');

    const second = await tracker.enqueueReplaceStopLoss({
      positionId: 'pos-1',
      symbol: 'BTCUSDT',
      direction: 'long',
      oldOrderId: 'stale-from-failed-call',
      triggerPrice: 100,
      amount: 1,
    });

    expect(second.isSuccess).toBe(true);
    expect(second.orderId).toBe('sl-2');
    expect(placeStopLoss).toHaveBeenCalledTimes(2);

    await tracker.shutdown();
  });

  it('enqueueReplaceStopLoss — parallel storm with stale oldOrderId + identical triggerPrice yields 1 placeStopLoss (real-world scenario)', async () => {
    jest.useRealTimers();

    const { exchangeConnector, placeStopLoss, cancelOrder, getOrder } = createMockExchange();
    let placeCount = 0;

    placeStopLoss.mockImplementation(async () => {
      placeCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));

      return { orderId: `sl-${placeCount}` };
    });

    getOrder.mockResolvedValue({ status: 'canceled', filledAmount: 0 });

    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    const first = await tracker.enqueueReplaceStopLoss({
      positionId: 'pos-1',
      symbol: 'BTCUSDT',
      direction: 'long',
      oldOrderId: 'sl-prev',
      triggerPrice: 100,
      amount: 1,
    });

    expect(first.orderId).toBe('sl-1');

    const storm = await Promise.all(
      Array.from({ length: 5 }, () =>
        tracker.enqueueReplaceStopLoss({
          positionId: 'pos-1',
          symbol: 'BTCUSDT',
          direction: 'long',
          oldOrderId: 'sl-prev',
          triggerPrice: 100,
          amount: 1,
        }),
      ),
    );

    for (const result of storm) {
      expect(result.isSuccess).toBe(true);
      expect(result.orderId).toBe('sl-1');
    }

    expect(placeStopLoss).toHaveBeenCalledTimes(1);
    expect(cancelOrder).toHaveBeenCalledTimes(1);

    await tracker.shutdown();
  });

  it('enqueueCreateMultiOrderBatch — partCount=10 sends single sub-batch without sleep', async () => {
    const { exchangeConnector, openPositionBatchLimit } = createMockExchange();
    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    const partList = Array.from({ length: 10 }, (_, i) => ({ price: 100 + i, amount: 1 }));
    const promise = tracker.enqueueCreateMultiOrderBatch({
      symbol: 'BTCUSDT',
      direction: 'long',
      partList,
      leverage: 3,
      marginMode: undefined as never,
      contextLabel: 'unit-test',
    });

    await jest.advanceTimersByTimeAsync(50);
    const result = await promise;

    expect(openPositionBatchLimit).toHaveBeenCalledTimes(1);
    expect(openPositionBatchLimit.mock.calls[0][0].itemList).toHaveLength(10);
    expect(openPositionBatchLimit.mock.calls[0][0].leverage).toBe(3);
    expect(result.isCreated).toBe(true);
    expect(result.isPartial).toBe(false);
    expect(result.orderIdList).toHaveLength(10);

    await tracker.shutdown();
  });

  it('enqueueCreateMultiOrderBatch — partCount=15 sends two sub-batches with sleep between them; setLeverage only in first', async () => {
    const { exchangeConnector, openPositionBatchLimit } = createMockExchange();
    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    const partList = Array.from({ length: 15 }, (_, i) => ({ price: 100 + i, amount: 1 }));
    const promise = tracker.enqueueCreateMultiOrderBatch({
      symbol: 'BTCUSDT',
      direction: 'long',
      partList,
      leverage: 5,
      marginMode: undefined as never,
      contextLabel: 'unit-test-split',
    });

    // After microtasks: first sub-batch sent immediately
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(openPositionBatchLimit).toHaveBeenCalledTimes(1);
    expect(openPositionBatchLimit.mock.calls[0][0].itemList).toHaveLength(10);
    expect(openPositionBatchLimit.mock.calls[0][0].leverage).toBe(5);

    // Before 1000ms — second sub-batch NOT sent yet
    await jest.advanceTimersByTimeAsync(500);
    expect(openPositionBatchLimit).toHaveBeenCalledTimes(1);

    // After full 1000ms delay — second sub-batch sent
    await jest.advanceTimersByTimeAsync(600);
    expect(openPositionBatchLimit).toHaveBeenCalledTimes(2);
    expect(openPositionBatchLimit.mock.calls[1][0].itemList).toHaveLength(5);
    expect(openPositionBatchLimit.mock.calls[1][0].leverage).toBeUndefined();

    const result = await promise;
    expect(result.isCreated).toBe(true);
    expect(result.isPartial).toBe(false);
    expect(result.orderIdList).toHaveLength(15);

    await tracker.shutdown();
  });

  it('enqueueCreateMultiOrderBatch — partial failure (rate-limit) in sub-batch 1 still sends sub-batch 2; returns isPartial with failedPartList', async () => {
    const { exchangeConnector, openPositionBatchLimit } = createMockExchange();
    // Sub-batch 1: 10 orders, last one fails with 10006
    // Sub-batch 2: 1 order, succeeds
    let callIndex = 0;
    openPositionBatchLimit.mockImplementation(async (args: { itemList: Array<unknown> }) => {
      const localIndex = callIndex;
      callIndex += 1;
      if (localIndex === 0) {
        return args.itemList.map((_, i) =>
          i === args.itemList.length - 1
            ? { isSuccess: false, orderId: null, errorText: '10006: Too many visits. Exceeded the API Rate Limit.' }
            : { isSuccess: true, orderId: `ok-1-${i}`, errorText: null },
        );
      }
      return args.itemList.map((_, i) => ({ isSuccess: true, orderId: `ok-2-${i}`, errorText: null }));
    });

    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    const partList = Array.from({ length: 11 }, (_, i) => ({ price: 100 + i, amount: 1 }));
    const promise = tracker.enqueueCreateMultiOrderBatch({
      symbol: 'BOBBOBUSDT',
      direction: 'long',
      partList,
      leverage: 2,
      marginMode: undefined as never,
      contextLabel: 'unit-test-partial',
    });

    await jest.advanceTimersByTimeAsync(1200);
    const result = await promise;

    expect(openPositionBatchLimit).toHaveBeenCalledTimes(2);
    expect(result.isCreated).toBe(true);
    expect(result.isPartial).toBe(true);
    expect(result.placedCount).toBe(10);
    expect(result.requestedCount).toBe(11);
    expect(result.failedPartList).toHaveLength(1);
    expect(result.errorText).toContain('10006');

    await tracker.shutdown();
  });

  it('enqueueCreateMultiOrderBatch — first sub-batch throws, remaining sub-batches NOT sent; returns failedPartList with unsent items', async () => {
    const { exchangeConnector, openPositionBatchLimit } = createMockExchange();
    openPositionBatchLimit.mockImplementation(async () => {
      throw new Error('network error');
    });

    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    const partList = Array.from({ length: 15 }, (_, i) => ({ price: 100 + i, amount: 1 }));
    const promise = tracker.enqueueCreateMultiOrderBatch({
      symbol: 'BTCUSDT',
      direction: 'long',
      partList,
      leverage: 3,
      marginMode: undefined as never,
      contextLabel: 'unit-test-throw',
    });

    await jest.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(openPositionBatchLimit).toHaveBeenCalledTimes(1);
    expect(result.isCreated).toBe(false);
    expect(result.errorText).toContain('network error');
    expect(result.failedPartList).toHaveLength(15);

    await tracker.shutdown();
  });

  it('enqueueCreateMultiOrderBatch — partCount=0 returns immediately without transmission', async () => {
    const { exchangeConnector, openPositionBatchLimit } = createMockExchange();
    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    const result = await tracker.enqueueCreateMultiOrderBatch({
      symbol: 'BTCUSDT',
      direction: 'long',
      partList: [],
      leverage: 3,
      marginMode: undefined as never,
      contextLabel: 'unit-test-empty',
    });

    expect(openPositionBatchLimit).not.toHaveBeenCalled();
    expect(result.isCreated).toBe(true);
    expect(result.orderIdList).toHaveLength(0);
    expect(result.isPartial).toBe(false);
    expect(result.placedOrderIdByCanonicalIndex).toHaveLength(0);

    await tracker.shutdown();
  });

  it('enqueueCreateMultiOrderBatch — placedOrderIdByCanonicalIndex is canonical-aligned with no nulls on full success', async () => {
    const { exchangeConnector } = createMockExchange();
    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    const partList = Array.from({ length: 6 }, (_, i) => ({ price: 100 + i, amount: 1 }));
    const promise = tracker.enqueueCreateMultiOrderBatch({
      symbol: 'BTCUSDT',
      direction: 'long',
      partList,
      leverage: 3,
      marginMode: undefined as never,
      contextLabel: 'unit-test-canonical',
    });

    await jest.advanceTimersByTimeAsync(50);
    const result = await promise;

    expect(result.placedOrderIdByCanonicalIndex).toHaveLength(6);
    expect(result.placedOrderIdByCanonicalIndex.every((id) => id !== null)).toBe(true);
    expect(result.placedOrderIdByCanonicalIndex).toEqual(result.orderIdList);

    await tracker.shutdown();
  });

  it('enqueueCreateMultiOrderBatch — placedOrderIdByCanonicalIndex keeps a null at the failed canonical slot on partial failure', async () => {
    const { exchangeConnector, openPositionBatchLimit } = createMockExchange();
    let callIndex = 0;
    openPositionBatchLimit.mockImplementation(async (args: { itemList: Array<unknown> }) => {
      const localIndex = callIndex;
      callIndex += 1;
      if (localIndex === 0) {
        return args.itemList.map((_, i) =>
          i === args.itemList.length - 1
            ? { isSuccess: false, orderId: null, errorText: '10006: rate limit' }
            : { isSuccess: true, orderId: `ok-1-${i}`, errorText: null },
        );
      }
      return args.itemList.map((_, i) => ({ isSuccess: true, orderId: `ok-2-${i}`, errorText: null }));
    });

    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    const partList = Array.from({ length: 11 }, (_, i) => ({ price: 100 + i, amount: 1 }));
    const promise = tracker.enqueueCreateMultiOrderBatch({
      symbol: 'BTCUSDT',
      direction: 'long',
      partList,
      leverage: 2,
      marginMode: undefined as never,
      contextLabel: 'unit-test-canonical-partial',
    });

    await jest.advanceTimersByTimeAsync(1200);
    const result = await promise;

    expect(result.isPartial).toBe(true);
    expect(result.placedOrderIdByCanonicalIndex).toHaveLength(11);
    expect(result.placedOrderIdByCanonicalIndex.filter((id) => id !== null)).toHaveLength(10);
    expect(result.placedOrderIdByCanonicalIndex.filter((id) => id === null)).toHaveLength(1);

    await tracker.shutdown();
  });

  it('enqueueCreateTpSplitFan — 13 parts split into two sub-batches (10 + 3), all success', async () => {
    const { exchangeConnector, closePositionBatchLimit } = createMockExchange();
    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    const priceList = Array.from({ length: 13 }, (_, i) => 100 + i);
    const amountList = Array.from({ length: 13 }, () => 1);
    const promise = tracker.enqueueCreateTpSplitFan({
      positionId: 'pos-tp-13',
      symbol: 'INUSDT',
      direction: 'long',
      priceList,
      amountList,
    });

    // 1000ms inter-sub-batch delay between the two sub-batches.
    await jest.advanceTimersByTimeAsync(1500);
    const result = await promise;

    expect(closePositionBatchLimit).toHaveBeenCalledTimes(2);
    expect(closePositionBatchLimit.mock.calls[0][0].itemList).toHaveLength(10);
    expect(closePositionBatchLimit.mock.calls[1][0].itemList).toHaveLength(3);
    expect(result.isCreated).toBe(true);
    expect(result.orderIdList).toHaveLength(13);

    await tracker.shutdown();
  });

  it('enqueueCreateTpSplitFan — partial failure beyond cap (second sub-batch fails) rolls back all placed orders', async () => {
    const { exchangeConnector, getOrder, closePositionBatchLimit, cancelBatchOrders } = createMockExchange();
    getOrder.mockResolvedValue({ status: 'canceled', filledAmount: 0 });

    let callIndex = 0;
    closePositionBatchLimit.mockImplementation(async (args: { itemList: Array<unknown> }) => {
      const localIndex = callIndex;
      callIndex += 1;
      if (localIndex === 0) {
        return args.itemList.map((_, i) => ({ isSuccess: true, orderId: `tp-ok-${i}`, errorText: null }));
      }
      return args.itemList.map(() => ({ isSuccess: false, orderId: null, errorText: 'Order creation failed in batch' }));
    });

    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    const priceList = Array.from({ length: 13 }, (_, i) => 100 + i);
    const amountList = Array.from({ length: 13 }, () => 1);
    const promise = tracker.enqueueCreateTpSplitFan({
      positionId: 'pos-tp-partial',
      symbol: 'INUSDT',
      direction: 'long',
      priceList,
      amountList,
    });

    // 1000ms inter-sub-batch delay + 1500ms rollback immediate-verify.
    await jest.advanceTimersByTimeAsync(3000);
    const result = await promise;

    expect(closePositionBatchLimit).toHaveBeenCalledTimes(2);
    expect(result.isCreated).toBe(false);
    expect(result.errorText).toContain('Order creation failed in batch');
    // All 10 placed orders (sub-batch 1) rolled back via cancel batch.
    expect(cancelBatchOrders).toHaveBeenCalledTimes(1);
    expect(cancelBatchOrders.mock.calls[0][0].orderIdList).toHaveLength(10);

    await tracker.shutdown();
  });

  it('enqueueCreateTpSplitFan — LONG transmits nearest TP (priceList[0]) first', async () => {
    const { exchangeConnector, closePositionBatchLimit } = createMockExchange();
    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    // LONG TP fan: priceList[0] = 100 is the nearest TP (lowest sell above market).
    const priceList = [100, 105, 110, 115, 120];
    const amountList = [1, 2, 3, 4, 5];
    const promise = tracker.enqueueCreateTpSplitFan({
      positionId: 'pos-tp-long-order',
      symbol: 'INUSDT',
      direction: 'long',
      priceList,
      amountList,
    });

    await jest.advanceTimersByTimeAsync(50);
    const result = await promise;

    expect(result.isCreated).toBe(true);
    expect(closePositionBatchLimit).toHaveBeenCalledTimes(1);
    // Nearest-to-market TP must be transmitted FIRST — canonical priceList order preserved.
    expect(closePositionBatchLimit.mock.calls[0][0].itemList.map((item: { price: number }) => item.price)).toEqual([100, 105, 110, 115, 120]);
    // amountList stays paired with its price after any internal reorder.
    expect(closePositionBatchLimit.mock.calls[0][0].itemList.map((item: { amount: number }) => item.amount)).toEqual([1, 2, 3, 4, 5]);

    await tracker.shutdown();
  });

  it('enqueueCreateTpSplitFan — SHORT transmits nearest TP (priceList[0]) first', async () => {
    const { exchangeConnector, closePositionBatchLimit } = createMockExchange();
    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    // SHORT TP fan: priceList[0] = 120 is the nearest TP (highest buy below market).
    const priceList = [120, 115, 110, 105, 100];
    const amountList = [1, 2, 3, 4, 5];
    const promise = tracker.enqueueCreateTpSplitFan({
      positionId: 'pos-tp-short-order',
      symbol: 'INUSDT',
      direction: 'short',
      priceList,
      amountList,
    });

    await jest.advanceTimersByTimeAsync(50);
    const result = await promise;

    expect(result.isCreated).toBe(true);
    expect(closePositionBatchLimit).toHaveBeenCalledTimes(1);
    expect(closePositionBatchLimit.mock.calls[0][0].itemList.map((item: { price: number }) => item.price)).toEqual([120, 115, 110, 105, 100]);
    expect(closePositionBatchLimit.mock.calls[0][0].itemList.map((item: { amount: number }) => item.amount)).toEqual([1, 2, 3, 4, 5]);

    await tracker.shutdown();
  });

  it('enqueueCancelBatch — 20 orderIds split into two sub-batches of 10', async () => {
    const { exchangeConnector, getOrder, cancelBatchOrders } = createMockExchange();
    getOrder.mockResolvedValue({ status: 'canceled', filledAmount: 0 });
    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    const orderIdList = Array.from({ length: 20 }, (_, i) => `o${i + 1}`);
    const promise = tracker.enqueueCancelBatch({
      symbol: 'BTCUSDT',
      orderIdList,
      modulePrefix: '[Test]',
      contextLabel: 'cancel-chunk',
    });

    // Cancel sub-batches go back-to-back (no inter-batch delay); 1500ms immediate-verify.
    await jest.advanceTimersByTimeAsync(1500);
    const outcome = await promise;

    expect(cancelBatchOrders).toHaveBeenCalledTimes(2);
    expect(cancelBatchOrders.mock.calls[0][0].orderIdList).toHaveLength(10);
    expect(cancelBatchOrders.mock.calls[1][0].orderIdList).toHaveLength(10);
    expect(outcome.cancelledOrderIdList).toHaveLength(20);

    await tracker.shutdown();
  });

  it('enqueueCancelBatch — second sub-batch send fails, only those orders end up not-sent', async () => {
    const { exchangeConnector, getOrder, cancelBatchOrders } = createMockExchange();
    // o1..o10 cancel and confirm; o11..o20 are in the throwing chunk and stay open.
    getOrder.mockImplementation(async (_symbol: string, orderId: string) => {
      const num = Number(orderId.replace('o', ''));
      return { status: num <= 10 ? 'canceled' : 'open', filledAmount: 0 };
    });

    let callIndex = 0;
    cancelBatchOrders.mockImplementation(async (args: { orderIdList: string[] }) => {
      const localIndex = callIndex;
      callIndex += 1;
      if (localIndex === 1) {
        throw new Error('exchange rate-limit on second sub-batch');
      }
      return args.orderIdList.map((orderId) => ({ orderId, isSuccess: true, errorCode: null, errorText: null }));
    });

    const telegramNotifier = createMockTelegramNotifier();
    const tracker = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    const orderIdList = Array.from({ length: 20 }, (_, i) => `o${i + 1}`);
    const promise = tracker.enqueueCancelBatch({
      symbol: 'BTCUSDT',
      orderIdList,
      modulePrefix: '[Test]',
      contextLabel: 'cancel-chunk-fail',
    });

    await jest.advanceTimersByTimeAsync(1500);
    const outcome = await promise;

    expect(cancelBatchOrders).toHaveBeenCalledTimes(2);
    expect(outcome.cancelledOrderIdList).toHaveLength(10);
    expect(outcome.failedToSendOrderIdList).toHaveLength(10);
    expect(outcome.failedToSendOrderIdList).toContain('o11');
    expect(outcome.failedToSendOrderIdList).toContain('o20');

    await tracker.shutdown();
  });

  it('enqueueReplaceStopLoss — rejected placement KEEPS the existing stop (never leaves the position bare)', async () => {
    const { exchangeConnector, placeStopLoss, cancelOrder } = createMockExchange();
    // The exchange rejects the new stop (its trigger is on the wrong side of the market) → no orderId.
    placeStopLoss.mockResolvedValue({ errorText: 'trigger price would trigger immediately' });
    const telegramNotifier = createMockTelegramNotifier();
    const manager = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    const result = await manager.enqueueReplaceStopLoss({
      positionId: 'pos-1',
      symbol: 'BTCUSDT',
      direction: 'short',
      oldOrderId: 'old-sl-1',
      triggerPrice: 100,
      amount: 1,
    });

    expect(result).toMatchObject({ isSuccess: false, orderId: null });
    expect(result.errorText).toBe('trigger price would trigger immediately');
    expect(placeStopLoss).toHaveBeenCalledTimes(1);
    // CRITICAL: the old stop must stay on the exchange — its cancel must NOT have been issued.
    expect(cancelOrder).not.toHaveBeenCalled();

    await manager.shutdown();
  });

  it('enqueueReplaceStopLoss — successful placement places the new stop THEN cancels the old', async () => {
    const { exchangeConnector, placeStopLoss, getOrder, cancelOrder } = createMockExchange();
    placeStopLoss.mockResolvedValue({ orderId: 'new-sl' });
    // The old order's cancel confirms via REST verify.
    getOrder.mockResolvedValue({ status: 'canceled', filledAmount: 0 });
    const telegramNotifier = createMockTelegramNotifier();
    const manager = new OrderManager({ exchangeConnector: exchangeConnector as never, telegramNotifier: telegramNotifier as never });

    const promise = manager.enqueueReplaceStopLoss({
      positionId: 'pos-1',
      symbol: 'BTCUSDT',
      direction: 'short',
      oldOrderId: 'old-sl-1',
      triggerPrice: 100,
      amount: 1,
    });

    await jest.advanceTimersByTimeAsync(1500);
    const result = await promise;

    expect(result).toMatchObject({ isSuccess: true, orderId: 'new-sl' });
    expect(placeStopLoss).toHaveBeenCalledTimes(1);
    // The old stop is cancelled only AFTER the new one is confirmed placed.
    expect(cancelOrder).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'old-sl-1' }));

    await manager.shutdown();
  });
});
