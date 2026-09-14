import { ExchangeNameEnum, PositionModeEnum } from '@solncebro/exchange-engine';

import { ExchangeConnector } from '../src/services/exchangeConnector';
import type { TradeSymbolsRefreshConfig } from '../src/services/exchangeConnector';
import { ExchangeConfig } from '../src/types';

jest.mock('../src/core/logger', () => ({
  logger: { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() },
}));

// mock-prefixed so the jest.mock factory may reference them.
const mockFutures = {
  tradeSymbols: new Map<string, unknown>(),
  loadTradeSymbols: jest.fn().mockResolvedValue(new Map()),
  fetchTickers: jest.fn().mockResolvedValue(new Map()),
};
const mockSpot = {
  tradeSymbols: new Map<string, unknown>(),
  loadTradeSymbols: jest.fn().mockResolvedValue(new Map()),
  fetchTickers: jest.fn().mockResolvedValue(new Map()),
};
const mockClose = jest.fn().mockResolvedValue(undefined);

jest.mock('@solncebro/exchange-engine', () => {
  const actual = jest.requireActual('@solncebro/exchange-engine');

  return {
    ...actual,
    Exchange: jest.fn().mockImplementation(() => ({
      futures: mockFutures,
      spot: mockSpot,
      close: mockClose,
    })),
  };
});

// 2026-09-12 12:00 UTC → the next 00:05 UTC anchor is 12 hours 5 minutes away.
const START_TIME_ISO = '2026-09-12T12:00:00.000Z';
const MS_TO_NEXT_ANCHOR = 12 * 60 * 60 * 1000 + 5 * 60 * 1000;
// Math.random is pinned to 0.5, so the random spread is exactly half of its 120s ceiling.
const EXPECTED_JITTER_MS = 60_000;
const EXPECTED_FIRST_DELAY_MS = MS_TO_NEXT_ANCHOR + EXPECTED_JITTER_MS;
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

function buildConnector(tradeSymbolsRefreshConfig?: TradeSymbolsRefreshConfig): ExchangeConnector {
  return new ExchangeConnector(
    ExchangeNameEnum.Bybit,
    { apiKey: 'k', secret: 's' } as ExchangeConfig,
    undefined,
    PositionModeEnum.OneWay,
    { isEnabled: false },
    null,
    undefined,
    tradeSymbolsRefreshConfig,
  );
}

async function initializeAndForgetStartupLoads(
  tradeSymbolsRefreshConfig?: TradeSymbolsRefreshConfig,
): Promise<ExchangeConnector> {
  const connector = buildConnector(tradeSymbolsRefreshConfig);

  await connector.initialize();
  // initialize() loads both markets once itself — the counters below must see only the timer.
  mockFutures.loadTradeSymbols.mockClear();
  mockSpot.loadTradeSymbols.mockClear();

  return connector;
}

describe('ExchangeConnector daily trade-symbol refresh', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date(START_TIME_ISO));
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    mockFutures.loadTradeSymbols.mockResolvedValue(new Map());
    mockSpot.loadTradeSymbols.mockResolvedValue(new Map());
    mockFutures.fetchTickers.mockResolvedValue(new Map());
    mockSpot.fetchTickers.mockResolvedValue(new Map());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('schedules the first round at the next 00:05 UTC plus the random spread', async () => {
    await initializeAndForgetStartupLoads();

    await jest.advanceTimersByTimeAsync(EXPECTED_FIRST_DELAY_MS - 1);
    expect(mockFutures.loadTradeSymbols).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(mockFutures.loadTradeSymbols).toHaveBeenCalledTimes(1);
  });

  it('reloads both markets exactly once per round', async () => {
    await initializeAndForgetStartupLoads();

    await jest.advanceTimersByTimeAsync(EXPECTED_FIRST_DELAY_MS);

    expect(mockFutures.loadTradeSymbols).toHaveBeenCalledTimes(1);
    expect(mockSpot.loadTradeSymbols).toHaveBeenCalledTimes(1);
  });

  it('arms the next round only after the running one has settled', async () => {
    await initializeAndForgetStartupLoads();
    // Hang the futures read only AFTER initialize — its own startup loads must go through.
    let releaseFuturesLoad: (() => void) | null = null;
    mockFutures.loadTradeSymbols.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFuturesLoad = (): void => resolve(new Map());
        }),
    );

    await jest.advanceTimersByTimeAsync(EXPECTED_FIRST_DELAY_MS);
    // The round is stuck on the futures read — two more days must not start a second one.
    await jest.advanceTimersByTimeAsync(TWO_DAYS_MS);

    expect(mockFutures.loadTradeSymbols).toHaveBeenCalledTimes(1);
    expect(mockSpot.loadTradeSymbols).not.toHaveBeenCalled();

    (releaseFuturesLoad as unknown as () => void)();
    await jest.advanceTimersByTimeAsync(0);
    expect(mockSpot.loadTradeSymbols).toHaveBeenCalledTimes(1);
  });

  it('disconnect() cancels the schedule', async () => {
    const connector = await initializeAndForgetStartupLoads();

    await connector.disconnect();
    await jest.advanceTimersByTimeAsync(TWO_DAYS_MS);

    expect(mockFutures.loadTradeSymbols).not.toHaveBeenCalled();
    expect(mockSpot.loadTradeSymbols).not.toHaveBeenCalled();
  });

  it('schedules nothing when the interval is 0', async () => {
    await initializeAndForgetStartupLoads({ tradeSymbolsRefreshIntervalMs: 0 });

    await jest.advanceTimersByTimeAsync(TWO_DAYS_MS);

    expect(mockFutures.loadTradeSymbols).not.toHaveBeenCalled();
    expect(mockSpot.loadTradeSymbols).not.toHaveBeenCalled();
  });

  it('keeps the futures refresh and the schedule alive when the spot read fails', async () => {
    const connector = await initializeAndForgetStartupLoads();
    mockSpot.loadTradeSymbols.mockRejectedValue(new Error('exchange is down'));

    await expect(connector.refreshAllTradeSymbols()).resolves.toBeUndefined();
    expect(mockFutures.loadTradeSymbols).toHaveBeenCalledTimes(1);
    expect(mockSpot.loadTradeSymbols).toHaveBeenCalledTimes(1);
  });
});
