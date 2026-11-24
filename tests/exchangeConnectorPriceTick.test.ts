import { ExchangeNameEnum, PositionModeEnum } from '@solncebro/exchange-engine';

import { ExchangeConnector } from '../src/services/exchangeConnector';
import { ExchangeConfig } from '../src/types';
import { configurePriceTickSnapper, readPriceTickSize, snapPriceToTick } from '../src/utils/priceFormat';

jest.mock('../src/core/logger', () => ({
  logger: { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() },
}));

interface FakeClient {
  tradeSymbols: Map<string, { filter: { tickSize: string } }>;
  loadTradeSymbols: jest.Mock;
  fetchTickers: jest.Mock;
  fetchAllLeverageTierList: jest.Mock;
  fetchLeverageTierList: jest.Mock;
  getOrderRateLimit: jest.Mock;
  amountToPrecision: (symbol: string, amount: number) => number;
  priceToPrecision: (symbol: string, price: number) => number;
}

const mockCreatedClientList: Array<{ futures: FakeClient; spot: FakeClient }> = [];

function mockBuildClient(): FakeClient {
  const tradeSymbols = new Map<string, { filter: { tickSize: string } }>();

  return {
    tradeSymbols,
    loadTradeSymbols: jest.fn(async () => tradeSymbols),
    fetchTickers: jest.fn(async () => new Map()),
    fetchAllLeverageTierList: jest.fn(async () => new Map()),
    fetchLeverageTierList: jest.fn(async () => []),
    getOrderRateLimit: jest.fn(async () => ({ writeRequestsPerSecond: 10, source: 'test' })),
    amountToPrecision: (_symbol: string, amount: number) => amount,
    priceToPrecision: (symbol: string, price: number) => {
      const tick = parseFloat(tradeSymbols.get(symbol)?.filter.tickSize ?? '0');

      return Number((Math.round(price / tick) * tick).toFixed(10));
    },
  };
}

jest.mock('@solncebro/exchange-engine', () => {
  const actual = jest.requireActual('@solncebro/exchange-engine');

  return {
    ...actual,
    Exchange: jest.fn().mockImplementation(() => {
      const clients = { futures: mockBuildClient(), spot: mockBuildClient() };

      mockCreatedClientList.push(clients);

      return { ...clients, close: jest.fn() };
    }),
  };
});

afterEach(() => {
  configurePriceTickSnapper(null);
});

describe('ExchangeConnector price tick reader', () => {
  it('installs a tick-size reader next to the snapper, futures first then spot', async () => {
    const connector = new ExchangeConnector(
      ExchangeNameEnum.Binance,
      { apiKey: 'k', secret: 's' } as ExchangeConfig,
      undefined,
      PositionModeEnum.OneWay,
      { isEnabled: false },
      null,
      undefined,
      { tradeSymbolsRefreshIntervalMs: 0 },
      { isEnabled: false }
    );
    const { futures, spot } = mockCreatedClientList[mockCreatedClientList.length - 1];

    futures.tradeSymbols.set('PROMUSDT', { filter: { tickSize: '0.0001' } });
    spot.tradeSymbols.set('PROMUSDT', { filter: { tickSize: '0.5' } });
    spot.tradeSymbols.set('SPOTUSDT', { filter: { tickSize: '0.01' } });

    expect(readPriceTickSize('PROMUSDT')).toBeNull();

    await connector.initialize();

    expect(readPriceTickSize('PROMUSDT')).toBe(0.0001);
    expect(readPriceTickSize('SPOTUSDT')).toBe(0.01);
    expect(readPriceTickSize('NOPEUSDT')).toBeNull();
    expect(snapPriceToTick('PROMUSDT', 2.961579786096256)).toBeCloseTo(2.9616, 9);

    await connector.disconnect();
  });
});
