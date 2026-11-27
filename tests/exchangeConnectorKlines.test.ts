import { ExchangeNameEnum, PositionModeEnum } from '@solncebro/exchange-engine';

import { ExchangeConnector } from '../src/services/exchangeConnector';
import { ExchangeConfig, MarketTypeEnum } from '../src/types';

jest.mock('../src/core/logger', () => ({
  logger: { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() },
}));

const mockFutures = {
  subscribeKlines: jest.fn(),
  unsubscribeKlines: jest.fn(),
  loadTradeSymbols: jest.fn().mockResolvedValue(new Map()),
  fetchTickers: jest.fn().mockResolvedValue(new Map()),
};
const mockSpot = {
  subscribeKlines: jest.fn(),
  unsubscribeKlines: jest.fn(),
  loadTradeSymbols: jest.fn().mockResolvedValue(new Map()),
  fetchTickers: jest.fn().mockResolvedValue(new Map()),
};

jest.mock('@solncebro/exchange-engine', () => {
  const actual = jest.requireActual('@solncebro/exchange-engine');

  return {
    ...actual,
    Exchange: jest.fn().mockImplementation(() => ({ futures: mockFutures, spot: mockSpot, close: jest.fn() })),
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

describe('ExchangeConnector single-symbol kline subscription', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('sends a futures subscription to the futures client with the same symbol, interval and handler', () => {
    const connector = buildConnector();
    const handler = jest.fn();

    connector.subscribeKlines({ symbol: 'AAAUSDT', interval: '5m', marketType: MarketTypeEnum.Futures, handler });

    expect(mockFutures.subscribeKlines).toHaveBeenCalledWith({ symbol: 'AAAUSDT', interval: '5m', handler });
    expect(mockSpot.subscribeKlines).not.toHaveBeenCalled();
  });

  it('sends a spot subscription to the spot client', () => {
    const connector = buildConnector();
    const handler = jest.fn();

    connector.subscribeKlines({ symbol: 'AAAUSDT', interval: '30m', marketType: MarketTypeEnum.Spot, handler });

    expect(mockSpot.subscribeKlines).toHaveBeenCalledWith({ symbol: 'AAAUSDT', interval: '30m', handler });
    expect(mockFutures.subscribeKlines).not.toHaveBeenCalled();
  });

  it('unsubscribes with the same handler, per market type', () => {
    const connector = buildConnector();
    const handler = jest.fn();

    connector.unsubscribeKlines({ symbol: 'AAAUSDT', interval: '5m', marketType: MarketTypeEnum.Futures, handler });
    connector.unsubscribeKlines({ symbol: 'BBBUSDT', interval: '5m', marketType: MarketTypeEnum.Spot, handler });

    expect(mockFutures.unsubscribeKlines).toHaveBeenCalledWith({ symbol: 'AAAUSDT', interval: '5m', handler });
    expect(mockSpot.unsubscribeKlines).toHaveBeenCalledWith({ symbol: 'BBBUSDT', interval: '5m', handler });
  });
});
