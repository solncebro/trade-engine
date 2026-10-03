import type { OrderUpdateEvent, UserDataStreamHandlerArgs } from '@solncebro/exchange-engine';

import { UserDataStreamRouter } from '../src/services/userDataStreamRouter';

jest.mock('../src/core/logger', () => ({
  logger: { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() },
}));

function createFakeClient() {
  let handler: UserDataStreamHandlerArgs | null = null;
  const connectUserDataStream = jest.fn(async (nextHandler: UserDataStreamHandlerArgs) => {
    handler = nextHandler;
  });
  const disconnectUserDataStream = jest.fn();

  return {
    client: { connectUserDataStream, disconnectUserDataStream },
    connectUserDataStream,
    disconnectUserDataStream,
    getHandler: (): UserDataStreamHandlerArgs => {
      if (handler === null) {
        throw new Error('not connected');
      }

      return handler;
    },
  };
}

const ORDER_EVENT: OrderUpdateEvent = { symbol: 'BTCUSDT', orderId: 'o1', clientOrderId: '', side: 'buy' as never, status: 'closed', price: 1, avgPrice: 1, amount: 1, filledAmount: 1, timestamp: 0 };

async function flushPromises(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}

describe('UserDataStreamRouter', () => {
  it('opens ONE stream however many subscribers and connect calls there are', async () => {
    const fake = createFakeClient();
    const router = new UserDataStreamRouter({ client: fake.client, label: 'Test Futures' });
    const firstList: string[] = [];
    const secondList: string[] = [];

    router.subscribe({ name: 'orderManager', onOrderUpdate: event => void firstList.push(event.orderId) });
    router.subscribe({ name: 'positionMonitor', onOrderUpdate: async event => void secondList.push(event.orderId) });
    await Promise.all([router.connect(), router.connect()]);
    await router.connect();
    fake.getHandler().onOrderUpdate(ORDER_EVENT);
    await flushPromises();

    expect(fake.connectUserDataStream).toHaveBeenCalledTimes(1);
    expect(firstList).toEqual(['o1']);
    expect(secondList).toEqual(['o1']);
    expect(router.isLive()).toBe(true);
  });

  it('isolates subscribers: a throw or a rejection of one does not stop the others', async () => {
    const fake = createFakeClient();
    const router = new UserDataStreamRouter({ client: fake.client, label: 'Test Futures' });
    const receivedList: string[] = [];

    router.subscribe({ name: 'throws', onOrderUpdate: () => { throw new Error('sync boom'); } });
    router.subscribe({ name: 'rejects', onOrderUpdate: async () => { throw new Error('async boom'); } });
    router.subscribe({ name: 'healthy', onOrderUpdate: event => void receivedList.push(event.orderId) });
    await router.connect();

    expect(() => fake.getHandler().onOrderUpdate(ORDER_EVENT)).not.toThrow();
    await flushPromises();
    expect(receivedList).toEqual(['o1']);
  });

  it('fans position and balance events out too, skipping subscribers without that callback', async () => {
    const fake = createFakeClient();
    const router = new UserDataStreamRouter({ client: fake.client, label: 'Test Futures' });
    const onPositionUpdate = jest.fn();
    const onBalanceUpdate = jest.fn();

    router.subscribe({ name: 'orders-only', onOrderUpdate: jest.fn() });
    router.subscribe({ name: 'account', onPositionUpdate, onBalanceUpdate });
    await router.connect();
    fake.getHandler().onPositionUpdate({ symbol: 'BTCUSDT', side: 'Buy', size: 1, entryPrice: 1, unrealisedPnl: 0 } as never);
    fake.getHandler().onBalanceUpdate?.({ balanceList: [], timestamp: 0 });

    expect(onPositionUpdate).toHaveBeenCalledTimes(1);
    expect(onBalanceUpdate).toHaveBeenCalledTimes(1);
  });

  it('drop → connectionLost to all; return → connectionRestored, then resyncRequired', async () => {
    const fake = createFakeClient();
    const router = new UserDataStreamRouter({ client: fake.client, label: 'Test Futures' });
    const callList: string[] = [];

    router.subscribe({
      name: 'a',
      onConnectionLost: () => void callList.push('a:lost'),
      onConnectionRestored: () => void callList.push('a:restored'),
      onResyncRequired: () => void callList.push('a:resync'),
    });
    router.subscribe({ name: 'b', onResyncRequired: () => void callList.push('b:resync') });
    await router.connect();

    fake.getHandler().onConnectionLost?.();
    expect(router.isLive()).toBe(false);
    fake.getHandler().onConnectionRestored?.();

    expect(router.isLive()).toBe(true);
    expect(callList).toEqual(['a:lost', 'a:restored', 'a:resync', 'b:resync']);
  });

  it('unsubscribe stops delivery; a failed connect can be retried', async () => {
    const fake = createFakeClient();
    fake.connectUserDataStream.mockRejectedValueOnce(new Error('listen key refused'));
    const router = new UserDataStreamRouter({ client: fake.client, label: 'Test Futures' });
    const onOrderUpdate = jest.fn();
    const unsubscribe = router.subscribe({ name: 'x', onOrderUpdate });

    await expect(router.connect()).rejects.toThrow('listen key refused');
    await router.connect();
    unsubscribe();
    fake.getHandler().onOrderUpdate(ORDER_EVENT);

    expect(fake.connectUserDataStream).toHaveBeenCalledTimes(2);
    expect(onOrderUpdate).not.toHaveBeenCalled();
    expect(router.getSubscriberCount()).toBe(0);
  });

  it('disconnect closes the stream once and allows a new connect', async () => {
    const fake = createFakeClient();
    const router = new UserDataStreamRouter({ client: fake.client, label: 'Test Futures' });

    router.disconnect();
    expect(fake.disconnectUserDataStream).not.toHaveBeenCalled();
    await router.connect();
    router.disconnect();
    expect(fake.disconnectUserDataStream).toHaveBeenCalledTimes(1);
    await router.connect();
    expect(fake.connectUserDataStream).toHaveBeenCalledTimes(2);
  });
});
