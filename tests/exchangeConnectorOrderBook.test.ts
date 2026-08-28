import { ExchangeNameEnum, PositionModeEnum } from '@solncebro/exchange-engine';

import { ExchangeConnector } from '../src/services/exchangeConnector';
import { ExchangeConfig, MarketTypeEnum } from '../src/types';

jest.mock('../src/core/logger', () => ({
  logger: { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() },
}));

const mockFutures = {
  subscribeOrderbook: jest.fn(),
  unsubscribeOrderbook: jest.fn(),
  resubscribeOrderbook: jest.fn(),
  fetchOrderBook: jest.fn(),
  loadTradeSymbols: jest.fn().mockResolvedValue(new Map()),
  fetchTickers: jest.fn().mockResolvedValue(new Map()),
};
const mockSpot = {
  loadTradeSymbols: jest.fn().mockResolvedValue(new Map()),
  fetchTickers: jest.fn().mockResolvedValue(new Map()),
};
const mockClose = jest.fn();

jest.mock('@solncebro/exchange-engine', () => {
  const actual = jest.requireActual('@solncebro/exchange-engine');

  return {
    ...actual,
    Exchange: jest.fn().mockImplementation(() => ({ futures: mockFutures, spot: mockSpot, close: mockClose })),
  };
});

function buildConnector(): ExchangeConnector {
  return new ExchangeConnector(
    ExchangeNameEnum.Binance,
    { apiKey: 'k', secret: 's' } as ExchangeConfig,
    undefined,
    PositionModeEnum.OneWay,
    { isEnabled: false },
    null
  );
}

describe('ExchangeConnector order book door', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('subscribes at the exchange depth, serves the merged book, and unsubscribes with the same handler', () => {
    const connector = buildConnector();

    connector.subscribeOrderBook('AAAUSDT', MarketTypeEnum.Futures);

    expect(mockFutures.subscribeOrderbook).toHaveBeenCalledWith({ symbol: 'AAAUSDT', depth: 20, handler: expect.any(Function) });
    expect(connector.getOrderBook('AAAUSDT', MarketTypeEnum.Futures)).toBeNull();

    const handler = mockFutures.subscribeOrderbook.mock.calls[0][0].handler;

    handler('AAAUSDT', { symbol: 'AAAUSDT', updateType: 'snapshot', updateId: 1, askList: [['2.5', '10']], bidList: [['2.4', '3']], eventTimestamp: 1, receivedTimestamp: 2 });

    expect(connector.getOrderBook('AAAUSDT', MarketTypeEnum.Futures)?.askList).toEqual([{ price: 2.5, quantity: 10 }]);

    connector.unsubscribeOrderBook('AAAUSDT', MarketTypeEnum.Futures);
    expect(mockFutures.unsubscribeOrderbook.mock.calls[0][0].handler).toBe(handler);
    expect(connector.getOrderBook('AAAUSDT', MarketTypeEnum.Futures)).toBeNull();
  });

  it('reads null for a market that was never subscribed', () => {
    expect(buildConnector().getOrderBook('AAAUSDT', MarketTypeEnum.Spot)).toBeNull();
  });

  it('fetchOrderBook is a one-shot REST read through the raw client', async () => {
    const connector = buildConnector();
    const book = { symbol: 'AAAUSDT', askList: [{ price: 2.5, quantity: 1 }], bidList: [], timestamp: 5 };

    mockFutures.fetchOrderBook.mockResolvedValue(book);

    await expect(connector.fetchOrderBook('AAAUSDT', MarketTypeEnum.Futures, 20)).resolves.toBe(book);
    expect(mockFutures.fetchOrderBook).toHaveBeenCalledWith('AAAUSDT', 20);
  });

  it('disconnect drops every live book subscription', async () => {
    const connector = buildConnector();

    connector.subscribeOrderBook('AAAUSDT', MarketTypeEnum.Futures);
    connector.subscribeOrderBook('BBBUSDT', MarketTypeEnum.Futures);
    await connector.disconnect();

    expect(mockFutures.unsubscribeOrderbook).toHaveBeenCalledTimes(2);
    expect(mockClose).toHaveBeenCalled();
  });
});
