import path from 'path';

import dotenv from 'dotenv';

import { ExchangeConnector } from '../../../src/services/exchangeConnector';
import { ExchangeConfig, ExchangeName, MarketType } from '../../../src/types';

dotenv.config({ path: path.resolve(__dirname, '../../../.env.test') });

export const BINANCE_DEMO_CONFIG: ExchangeConfig = {
  apiKey: process.env.BINANCE_DEMO_API_KEY ?? '',
  secret: process.env.BINANCE_DEMO_SECRET_KEY ?? '',
  demo: true,
};

export const BYBIT_DEMO_CONFIG: ExchangeConfig = {
  apiKey: process.env.BYBIT_DEMO_API_KEY ?? '',
  secret: process.env.BYBIT_DEMO_SECRET_KEY ?? '',
  demo: true,
};

export const hasBinanceCredentials = (): boolean =>
  !!BINANCE_DEMO_CONFIG.apiKey && !!BINANCE_DEMO_CONFIG.secret;

export const hasBybitCredentials = (): boolean =>
  !!BYBIT_DEMO_CONFIG.apiKey && !!BYBIT_DEMO_CONFIG.secret;

export const describeIfCredentials = (
  exchangeName: ExchangeName,
  name: string,
  fn: () => void
): void => {
  const hasCredentials =
    exchangeName === 'binance'
      ? hasBinanceCredentials()
      : hasBybitCredentials();

  if (hasCredentials) {
    describe(name, fn);
  } else {
    describe.skip(`${name} (no ${exchangeName} demo credentials)`, fn);
  }
};

export const FUTURES_TEST_SYMBOL = 'BTCUSDT';
export const MIN_BTC_ORDER_QTY = 0.001;

export const MULTIPLE_TEST_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'XRPUSDT'];

export const getSymbolsForExchange = (exchangeName: ExchangeName): string[] => {
  return MULTIPLE_TEST_SYMBOLS;
};

export const waitForTickers = async (
  connector: ExchangeConnector,
  symbol: string,
  timeoutMs: number = 30000
): Promise<void> => {
  const pollIntervalMs = 1000;
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const ticker = connector.getTicker(symbol, MarketType.Futures);

    if (ticker?.close !== undefined && ticker.close > 0) {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Tickers for ${symbol} did not populate within ${timeoutMs}ms`
  );
};

export const verifySymbolsAvailable = async (
  connector: ExchangeConnector,
  symbols: string[]
): Promise<void> => {
  const failedSymbols: string[] = [];

  for (const symbol of symbols) {
    try {
      await waitForTickers(connector, symbol, 10000);
    } catch (error) {
      failedSymbols.push(symbol);
    }
  }

  if (failedSymbols.length > 0) {
    throw new Error(`Failed to verify symbols: ${failedSymbols.join(', ')}`);
  }
};
