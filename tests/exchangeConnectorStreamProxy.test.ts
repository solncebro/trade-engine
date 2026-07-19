import { ExchangeNameEnum, PositionModeEnum } from '@solncebro/exchange-engine';

import { ExchangeConnector } from '../src/services/exchangeConnector';
import { ExchangeConfig } from '../src/types';

jest.mock('../src/core/logger', () => ({
  logger: { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() },
}));

// mock-prefixed so the jest.mock factory may reference them.
const mockStreamFutures = {
  subscribeKlines: jest.fn(),
  unsubscribeKlines: jest.fn(),
  subscribeOrderbook: jest.fn(),
  unsubscribeOrderbook: jest.fn(),
  subscribePublicTrades: jest.fn(),
  unsubscribePublicTrades: jest.fn(),
  subscribeMarkPrices: jest.fn(),
  unsubscribeMarkPrices: jest.fn(),
  loadTradeSymbols: jest.fn().mockResolvedValue(new Map()),
  fetchTickers: jest.fn().mockResolvedValue(new Map()),
};
const mockStreamSpot = {
  subscribeOrderbook: jest.fn(),
  unsubscribeOrderbook: jest.fn(),
  loadTradeSymbols: jest.fn().mockResolvedValue(new Map()),
  fetchTickers: jest.fn().mockResolvedValue(new Map()),
};

jest.mock('@solncebro/exchange-engine', () => {
  const actual = jest.requireActual('@solncebro/exchange-engine');

  return {
    ...actual,
    Exchange: jest.fn().mockImplementation(() => ({
      futures: mockStreamFutures,
      spot: mockStreamSpot,
      close: jest.fn(),
    })),
  };
});

function buildConnector(): ExchangeConnector {
  return new ExchangeConnector(
    ExchangeNameEnum.Bybit,
    { apiKey: 'k', secret: 's' } as ExchangeConfig,
    undefined,
    PositionModeEnum.OneWay,
    { isEnabled: false }, // disable kline watchdog to isolate the stream proxy paths
    null,
    { orderbook: { isEnabled: true }, markPrice: { isEnabled: true } },
  );
}

describe('ExchangeConnector stream-watchdog proxy', () => {
  beforeEach(() => {
    // Fake timers so the watchdog setInterval does not leave real open handles.
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('orderbook unsubscribe passes the SAME wrapped ref as subscribe — per symbol, with a shared handler', () => {
    const connector = buildConnector();
    const client = connector.futures; // proxied (orderbook watchdog enabled)
    const sharedHandler = jest.fn();

    client.subscribeOrderbook({ symbol: 'AAAUSDT', depth: 200, handler: sharedHandler });
    client.subscribeOrderbook({ symbol: 'BBBUSDT', depth: 200, handler: sharedHandler });

    const subCalls = mockStreamFutures.subscribeOrderbook.mock.calls;
    const wrappedA = subCalls[0][0].handler;
    const wrappedB = subCalls[1][0].handler;

    // distinct wrapped per symbol, and never the original
    expect(wrappedA).not.toBe(wrappedB);
    expect(wrappedA).not.toBe(sharedHandler);
    expect(wrappedB).not.toBe(sharedHandler);

    client.unsubscribeOrderbook({ symbol: 'AAAUSDT', depth: 200, handler: sharedHandler });

    const unsubArg = mockStreamFutures.unsubscribeOrderbook.mock.calls[0][0];
    // must remove the wrapped ref for AAAUSDT specifically (not BBBUSDT's, not original)
    expect(unsubArg.handler).toBe(wrappedA);
    expect(unsubArg.symbol).toBe('AAAUSDT');
  });

  it('wrapped orderbook handler forwards to the original and records freshness', () => {
    const connector = buildConnector();
    const client = connector.futures;
    const original = jest.fn();

    client.subscribeOrderbook({ symbol: 'AAAUSDT', depth: 200, handler: original });
    const wrapped = mockStreamFutures.subscribeOrderbook.mock.calls[0][0].handler;

    const update = { updateType: 'snapshot' } as never;
    wrapped('AAAUSDT', update);

    expect(original).toHaveBeenCalledWith('AAAUSDT', update);
  });

  it('mark-price subscribe/unsubscribe wrap and unwrap symmetrically via the proxy', () => {
    const connector = buildConnector();
    const client = connector.futures;
    const handler = jest.fn();

    client.subscribeMarkPrices(handler);
    const wrapped = mockStreamFutures.subscribeMarkPrices.mock.calls[0][0];
    expect(wrapped).not.toBe(handler);

    client.unsubscribeMarkPrices(handler);
    expect(mockStreamFutures.unsubscribeMarkPrices.mock.calls[0][0]).toBe(wrapped);
  });

  it('kline unsubscribe passes the SAME wrapped ref as subscribe — fixes the topic-leak', () => {
    const connector = new ExchangeConnector(
      ExchangeNameEnum.Bybit,
      { apiKey: 'k', secret: 's' } as ExchangeConfig,
      undefined,
      PositionModeEnum.OneWay,
      undefined, // kline watchdog ON by default
      null,
    );
    const client = connector.futures;
    const sharedHandler = jest.fn();

    client.subscribeKlines({ symbol: 'AAAUSDT', interval: '1m', handler: sharedHandler });
    client.subscribeKlines({ symbol: 'BBBUSDT', interval: '1m', handler: sharedHandler });

    const subCalls = mockStreamFutures.subscribeKlines.mock.calls;
    const wrappedA = subCalls[0][0].handler;
    const wrappedB = subCalls[1][0].handler;

    expect(wrappedA).not.toBe(wrappedB);
    expect(wrappedA).not.toBe(sharedHandler);

    client.unsubscribeKlines({ symbol: 'AAAUSDT', interval: '1m', handler: sharedHandler });

    const unsubArg = mockStreamFutures.unsubscribeKlines.mock.calls[0][0];
    expect(unsubArg.handler).toBe(wrappedA);
    expect(unsubArg.symbol).toBe('AAAUSDT');
  });

  it('leaves publicTrade unwrapped when its watchdog is disabled (passthrough)', () => {
    const connector = buildConnector(); // publicTrade not enabled
    const client = connector.futures;
    const handler = jest.fn();

    client.subscribePublicTrades({ symbol: 'AAAUSDT', handler });

    // passthrough → underlying received the ORIGINAL handler unchanged
    expect(mockStreamFutures.subscribePublicTrades.mock.calls[0][0].handler).toBe(handler);
  });
});
