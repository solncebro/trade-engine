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
    { isEnabled: false }, // no kline watchdog — isolate the ensure path
    null,
    undefined,
  );
}

const SPEC = { filter: { stepSize: '0.001', minQty: '1', maxQty: '1000000', minNotional: '5' } };

describe('ExchangeConnector.ensureFuturesTradeSymbolLoaded', () => {
  beforeEach(() => {
    mockFuturesTradeSymbols.clear();
    jest.clearAllMocks();
    mockFutures.loadTradeSymbols.mockResolvedValue(mockFuturesTradeSymbols);
  });

  it('returns true with NO reload when the spec is already present', async () => {
    mockFuturesTradeSymbols.set('BTCUSDT', SPEC);
    const connector = buildConnector();

    const isLoaded = await connector.ensureFuturesTradeSymbolLoaded('BTCUSDT');

    expect(isLoaded).toBe(true);
    expect(mockFutures.loadTradeSymbols).not.toHaveBeenCalled();
  });

  it('reloads and returns true when the spec appears after the reload', async () => {
    mockFutures.loadTradeSymbols.mockImplementation(async () => {
      mockFuturesTradeSymbols.set('NEWUSDT', SPEC);

      return mockFuturesTradeSymbols;
    });
    const connector = buildConnector();

    const isLoaded = await connector.ensureFuturesTradeSymbolLoaded('NEWUSDT');

    expect(isLoaded).toBe(true);
    expect(mockFutures.loadTradeSymbols).toHaveBeenCalledTimes(1);
  });

  it('reloads once and returns false when the symbol stays absent', async () => {
    const connector = buildConnector();

    const isLoaded = await connector.ensureFuturesTradeSymbolLoaded('GHOSTUSDT');

    expect(isLoaded).toBe(false);
    expect(mockFutures.loadTradeSymbols).toHaveBeenCalledTimes(1);
  });

  it('skips the reload on cooldown for a second still-missing symbol', async () => {
    const connector = buildConnector();

    const first = await connector.ensureFuturesTradeSymbolLoaded('GHOST1USDT');
    const second = await connector.ensureFuturesTradeSymbolLoaded('GHOST2USDT');

    expect(first).toBe(false);
    expect(second).toBe(false);
    expect(mockFutures.loadTradeSymbols).toHaveBeenCalledTimes(1);
  });

  it('shares one reload across concurrent callers (single-flight)', async () => {
    let resolveLoad: (() => void) | null = null;
    mockFutures.loadTradeSymbols.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLoad = (): void => {
            mockFuturesTradeSymbols.set('NEWUSDT', SPEC);
            resolve(mockFuturesTradeSymbols);
          };
        }),
    );
    const connector = buildConnector();

    const firstPromise = connector.ensureFuturesTradeSymbolLoaded('NEWUSDT');
    const secondPromise = connector.ensureFuturesTradeSymbolLoaded('NEWUSDT');

    // Both callers are now parked on the same in-flight reload.
    expect(resolveLoad).not.toBeNull();
    (resolveLoad as unknown as () => void)();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(mockFutures.loadTradeSymbols).toHaveBeenCalledTimes(1);
  });
});
