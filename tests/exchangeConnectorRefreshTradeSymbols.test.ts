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
    { isEnabled: false },
    null,
    undefined,
  );
}

const SWAP_SPEC = { isActive: true, type: 'swap', isLinear: true, symbol: 'BTC/USDT:USDT' };

describe('ExchangeConnector.refreshFuturesTradeSymbols', () => {
  beforeEach(() => {
    mockFuturesTradeSymbols.clear();
    jest.clearAllMocks();
    mockFutures.loadTradeSymbols.mockResolvedValue(mockFuturesTradeSymbols);
  });

  it('reloads the trade-symbol cache so getFuturesSymbols sees a new listing', async () => {
    mockFutures.loadTradeSymbols.mockImplementation(async () => {
      mockFuturesTradeSymbols.set('NEW/USDT:USDT', { ...SWAP_SPEC, symbol: 'NEW/USDT:USDT' });

      return mockFuturesTradeSymbols;
    });
    const connector = buildConnector();

    await connector.refreshFuturesTradeSymbols();
    const symbolList = await connector.getFuturesSymbols();

    expect(mockFutures.loadTradeSymbols).toHaveBeenCalledTimes(1);
    expect(symbolList).toContain('NEWUSDT');
  });

  it('swallows a failed reload and keeps the previous cache (stale is better than empty)', async () => {
    mockFuturesTradeSymbols.set('BTC/USDT:USDT', SWAP_SPEC);
    mockFutures.loadTradeSymbols.mockRejectedValue(new Error('exchange is down'));
    const connector = buildConnector();

    await expect(connector.refreshFuturesTradeSymbols()).resolves.toBeUndefined();

    const symbolList = await connector.getFuturesSymbols();
    expect(symbolList).toContain('BTCUSDT');
  });

  it('skips the second refresh inside the reload cooldown', async () => {
    const connector = buildConnector();

    await connector.refreshFuturesTradeSymbols();
    await connector.refreshFuturesTradeSymbols();

    expect(mockFutures.loadTradeSymbols).toHaveBeenCalledTimes(1);
  });

  it('shares one reload with a concurrent on-demand ensure call (single-flight)', async () => {
    let resolveLoad: (() => void) | null = null;
    mockFutures.loadTradeSymbols.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLoad = (): void => {
            mockFuturesTradeSymbols.set('NEW/USDT:USDT', { ...SWAP_SPEC, symbol: 'NEW/USDT:USDT' });
            resolve(mockFuturesTradeSymbols);
          };
        }),
    );
    const connector = buildConnector();

    const refreshPromise = connector.refreshFuturesTradeSymbols();
    const ensurePromise = connector.ensureFuturesTradeSymbolLoaded('NEW/USDT:USDT');

    expect(resolveLoad).not.toBeNull();
    (resolveLoad as unknown as () => void)();

    await Promise.all([refreshPromise, ensurePromise]);

    expect(mockFutures.loadTradeSymbols).toHaveBeenCalledTimes(1);
  });
});
