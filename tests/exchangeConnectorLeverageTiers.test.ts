import { ExchangeNameEnum, PositionModeEnum } from '@solncebro/exchange-engine';
import type { LeverageTier } from '@solncebro/exchange-engine';

import { logger } from '../src/core/logger';
import { ExchangeConnector } from '../src/services/exchangeConnector';
import { ExchangeConfig } from '../src/types';

jest.mock('../src/core/logger', () => ({
  logger: { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() },
}));

const mockFutures = {
  tradeSymbols: new Map<string, unknown>(),
  loadTradeSymbols: jest.fn().mockResolvedValue(new Map()),
  fetchAllLeverageTierList: jest.fn(),
  fetchLeverageTierList: jest.fn(),
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

const AVAUSDT_TIER_LIST: LeverageTier[] = [
  { maxLeverage: 5, maxNotional: 5000, maxBaseAmount: null, initialMarginRate: 0.2, maintenanceMarginRate: 0.1 },
  { maxLeverage: 4.5, maxNotional: 10000, maxBaseAmount: null, initialMarginRate: 0.2222, maintenanceMarginRate: 0.1111 },
];

function buildConnector(exchangeName: ExchangeNameEnum = ExchangeNameEnum.Bybit, config: ExchangeConfig = { apiKey: 'k', secret: 's' } as ExchangeConfig): ExchangeConnector {
  return new ExchangeConnector(
    exchangeName,
    config,
    undefined,
    PositionModeEnum.OneWay,
    { isEnabled: false },
    null,
    undefined,
  );
}

describe('ExchangeConnector leverage tiers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    mockFutures.fetchAllLeverageTierList.mockResolvedValue(new Map([['AVAUSDT', AVAUSDT_TIER_LIST]]));
    mockFutures.fetchLeverageTierList.mockResolvedValue(AVAUSDT_TIER_LIST);
  });

  it('the bulk load fills the cache and the getter reads it without the exchange', async () => {
    const connector = buildConnector();

    expect(connector.getFuturesLeverageTierList('AVAUSDT')).toBeNull();

    await connector.loadFuturesLeverageTiers('test');

    expect(connector.getFuturesLeverageTierList('AVAUSDT')).toEqual(AVAUSDT_TIER_LIST);
    expect(mockFutures.fetchAllLeverageTierList).toHaveBeenCalledTimes(1);
  });

  it('a failed bulk load keeps the previous tiers and does not throw', async () => {
    const connector = buildConnector();

    await connector.loadFuturesLeverageTiers('first');
    mockFutures.fetchAllLeverageTierList.mockRejectedValue(new Error('exchange is down'));

    await expect(connector.loadFuturesLeverageTiers('second')).resolves.toBeUndefined();

    expect(connector.getFuturesLeverageTierList('AVAUSDT')).toEqual(AVAUSDT_TIER_LIST);
  });

  it('a caller that joined a failing read is not thrown at either — both resolve, the cache stays as it was', async () => {
    let rejectLoad: (error: Error) => void = () => undefined;
    mockFutures.fetchAllLeverageTierList.mockReturnValue(new Promise((_resolve, reject) => { rejectLoad = reject; }));
    let rejectSymbolLoad: (error: Error) => void = () => undefined;
    mockFutures.fetchLeverageTierList.mockReturnValue(new Promise((_resolve, reject) => { rejectSymbolLoad = reject; }));
    const connector = buildConnector();

    const bulkPair = Promise.all([connector.loadFuturesLeverageTiers('first'), connector.loadFuturesLeverageTiers('joiner')]);
    const symbolPair = Promise.all([connector.ensureFuturesLeverageTierListLoaded('AVAUSDT'), connector.ensureFuturesLeverageTierListLoaded('AVAUSDT')]);

    rejectLoad(new Error('exchange is down'));
    rejectSymbolLoad(new Error('exchange is down'));

    await expect(bulkPair).resolves.toEqual([undefined, undefined]);
    await expect(symbolPair).resolves.toEqual([false, false]);
    expect(connector.getFuturesLeverageTierList('AVAUSDT')).toBeNull();
  });

  it('the daily trade-symbol round re-reads the tiers too', async () => {
    const connector = buildConnector();

    await connector.refreshAllTradeSymbols('daily');

    expect(mockFutures.fetchAllLeverageTierList).toHaveBeenCalledTimes(1);
    expect(connector.getFuturesLeverageTierList('AVAUSDT')).toEqual(AVAUSDT_TIER_LIST);
  });

  it('a missing symbol is fetched on demand ONCE for concurrent callers, a present one costs nothing', async () => {
    const connector = buildConnector();

    const [first, second] = await Promise.all([
      connector.ensureFuturesLeverageTierListLoaded('AVAUSDT'),
      connector.ensureFuturesLeverageTierListLoaded('AVAUSDT'),
    ]);

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(mockFutures.fetchLeverageTierList).toHaveBeenCalledTimes(1);

    await connector.ensureFuturesLeverageTierListLoaded('AVAUSDT');

    expect(mockFutures.fetchLeverageTierList).toHaveBeenCalledTimes(1);
  });

  it('a symbol the exchange has no tiers for is not asked again during the cooldown, unless forced', async () => {
    mockFutures.fetchLeverageTierList.mockResolvedValue([]);
    const connector = buildConnector();

    expect(await connector.ensureFuturesLeverageTierListLoaded('NOPEUSDT')).toBe(false);
    expect(await connector.ensureFuturesLeverageTierListLoaded('NOPEUSDT')).toBe(false);
    expect(mockFutures.fetchLeverageTierList).toHaveBeenCalledTimes(1);

    mockFutures.fetchLeverageTierList.mockResolvedValue(AVAUSDT_TIER_LIST);

    expect(await connector.ensureFuturesLeverageTierListLoaded('NOPEUSDT', true)).toBe(true);
    expect(mockFutures.fetchLeverageTierList).toHaveBeenCalledTimes(2);
  });

  it('a forced re-read replaces a present entry (a refusal proved the cached table stale)', async () => {
    const connector = buildConnector();

    await connector.loadFuturesLeverageTiers('test');
    const freshTierList: LeverageTier[] = [{ maxLeverage: 4, maxNotional: 15000, maxBaseAmount: null, initialMarginRate: 0.25, maintenanceMarginRate: 0.125 }];
    mockFutures.fetchLeverageTierList.mockResolvedValue(freshTierList);

    await connector.ensureFuturesLeverageTierListLoaded('AVAUSDT', true);

    expect(connector.getFuturesLeverageTierList('AVAUSDT')).toEqual(freshTierList);
  });

  describe('keyless connector (public market data only)', () => {
    const keylessConfig = { apiKey: '', secret: '' } as ExchangeConfig;

    it('Binance: the signed tier reads are skipped, no request, one debug line', async () => {
      const connector = buildConnector(ExchangeNameEnum.Binance, keylessConfig);

      await connector.loadFuturesLeverageTiers('initial');
      await connector.refreshAllTradeSymbols('daily');

      expect(await connector.ensureFuturesLeverageTierListLoaded('AVAUSDT')).toBe(false);
      expect(await connector.ensureFuturesLeverageTierListLoaded('AVAUSDT', true)).toBe(false);
      expect(mockFutures.fetchAllLeverageTierList).not.toHaveBeenCalled();
      expect(mockFutures.fetchLeverageTierList).not.toHaveBeenCalled();
      expect(connector.getFuturesLeverageTierList('AVAUSDT')).toBeNull();
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledTimes(1);
    });

    it('Binance with only one half of the key pair counts as keyless', async () => {
      const connector = buildConnector(ExchangeNameEnum.Binance, { apiKey: 'k', secret: ' ' } as ExchangeConfig);

      await connector.loadFuturesLeverageTiers('initial');

      expect(mockFutures.fetchAllLeverageTierList).not.toHaveBeenCalled();
    });

    it('Bybit reads its public risk-limit table without a key as before', async () => {
      const connector = buildConnector(ExchangeNameEnum.Bybit, keylessConfig);

      await connector.loadFuturesLeverageTiers('initial');

      expect(mockFutures.fetchAllLeverageTierList).toHaveBeenCalledTimes(1);
      expect(connector.getFuturesLeverageTierList('AVAUSDT')).toEqual(AVAUSDT_TIER_LIST);
    });

    it('Binance with a key reads the tiers as before', async () => {
      const connector = buildConnector(ExchangeNameEnum.Binance);

      await connector.loadFuturesLeverageTiers('initial');

      expect(mockFutures.fetchAllLeverageTierList).toHaveBeenCalledTimes(1);
    });
  });
});
