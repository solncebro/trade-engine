import { ExchangeNameEnum, PositionModeEnum } from '@solncebro/exchange-engine';

import { ExchangeConnector } from '../src/services/exchangeConnector';
import { ExchangeConfig } from '../src/types';

jest.mock('../src/core/logger', () => ({
  logger: { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() },
}));

// mock-prefixed so the jest.mock factory may reference them.
const mockFuturesTradeSymbols = new Map<string, unknown>();
const mockFutures = {
  tradeSymbols: mockFuturesTradeSymbols,
  loadTradeSymbols: jest.fn().mockResolvedValue(mockFuturesTradeSymbols),
  getMinOrderQty: jest.fn().mockReturnValue(0),
  getMinNotional: jest.fn().mockReturnValue(0),
  getMaxOrderQty: jest.fn().mockReturnValue(0),
};
const mockSpot = {
  tradeSymbols: new Map<string, unknown>(),
  loadTradeSymbols: jest.fn().mockResolvedValue(new Map()),
};

jest.mock('@solncebro/exchange-engine', () => {
  const actual = jest.requireActual('@solncebro/exchange-engine');

  return {
    ...actual,
    Exchange: jest.fn().mockImplementation(() => ({
      futures: mockFutures,
      spot: mockSpot,
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
    { isEnabled: false }, // no kline watchdog — isolate the read path
    null,
    undefined,
  );
}

describe('ExchangeConnector.getFuturesOrderRules', () => {
  beforeEach(() => {
    mockFuturesTradeSymbols.clear();
    jest.clearAllMocks();
    mockFutures.getMinOrderQty.mockReturnValue(0);
    mockFutures.getMinNotional.mockReturnValue(0);
    mockFutures.getMaxOrderQty.mockReturnValue(0);
  });

  it('returns the grid for a loaded symbol', () => {
    mockFuturesTradeSymbols.set('BTCUSDT', { filter: { tickSize: '0.1', stepSize: '0.001', minQty: '0.001', maxQty: '1000000', minNotional: '5' } });
    mockFutures.getMinOrderQty.mockReturnValue(0.001);
    mockFutures.getMinNotional.mockReturnValue(5);
    mockFutures.getMaxOrderQty.mockReturnValue(1000000);
    const connector = buildConnector();

    const rules = connector.getFuturesOrderRules('BTCUSDT');

    expect(rules).toEqual({ symbol: 'BTCUSDT', tickSize: 0.1, stepSize: 0.001, minAmount: 0.001, minNotionalUsd: 5, maxAmount: 1000000 });
    expect(mockFutures.getMaxOrderQty).toHaveBeenCalledWith('BTCUSDT');
  });

  it('returns tickSize/stepSize=0 when the filter values do not parse', () => {
    mockFuturesTradeSymbols.set('WEIRDUSDT', { filter: { tickSize: '', stepSize: 'n/a', minQty: '1', maxQty: '1000000', minNotional: '0' } });
    const connector = buildConnector();

    const rules = connector.getFuturesOrderRules('WEIRDUSDT');

    expect(rules).toEqual(expect.objectContaining({ tickSize: 0, stepSize: 0 }));
  });

  it('returns null for a symbol whose spec is not loaded', () => {
    const connector = buildConnector();

    const rules = connector.getFuturesOrderRules('GHOSTUSDT');

    expect(rules).toBeNull();
  });
});
