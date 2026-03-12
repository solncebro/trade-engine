import path from 'path';

import dotenv from 'dotenv';

import { ExchangeConnector } from '../../../src/services/exchangeConnector';
import {
  ExchangeConfig,
  ExchangeNameEnum,
  MarketType,
  SymbolMappingByExchange,
} from '../../../src/types';

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
  exchangeName: ExchangeNameEnum,
  name: string,
  fn: () => void
): void => {
  const hasCredentials =
    exchangeName === ExchangeNameEnum.Binance
      ? hasBinanceCredentials()
      : hasBybitCredentials();

  if (hasCredentials) {
    describe(name, fn);
  } else {
    describe.skip(`${name} (no ${exchangeName} demo credentials)`, fn);
  }
};

export const MIN_TEST_USDT = 100;

export const BYBIT_FUTURES_TEST_SYMBOL = 'BTCUSDT';
export const BYBIT_FUTURES_TEST_SYMBOL_LIST = [
  BYBIT_FUTURES_TEST_SYMBOL,
  '10000QUBICUSDT',
  'FLOKIUSDT',
  'MOGUSDT',
];
export const BYBIT_SPOT_FALLBACK_SYMBOL = 'CFGUSDT';

export const BINANCE_FUTURES_TEST_SYMBOL = 'ETHUSDT';
export const BINANCE_FUTURES_TEST_SYMBOL_LIST = [
  BINANCE_FUTURES_TEST_SYMBOL,
  'FLOKIUSDT',
  'SHIBUSDT',
];
export const BINANCE_SPOT_FALLBACK_SYMBOL = 'CFGUSDT';

export const serializeMapping = (
  mapping: SymbolMappingByExchange
): Record<string, Record<string, string>> => {
  const result: Record<string, Record<string, string>> = {};

  for (const [exchange, symbolMap] of mapping) {
    result[exchange] = Object.fromEntries(symbolMap);
  }

  return result;
};

export const calculateTestAmount = (
  connector: ExchangeConnector,
  symbol: string,
  price: number
): number =>
  parseFloat(
    connector.getClient().amountToPrecision(symbol, MIN_TEST_USDT / price)
  );

export const waitForTickers = async (
  connector: ExchangeConnector,
  symbol: string,
  timeoutMs: number = 30000
): Promise<void> => {
  const pollIntervalMs = 1000;
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const resolvedSymbol = connector.resolveSymbolWithPrefix(symbol);
    const ticker = connector.getTicker(resolvedSymbol, MarketType.Futures);

    if (ticker?.lastPrice !== undefined && ticker.lastPrice > 0) {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Tickers for ${symbol} did not populate within ${timeoutMs}ms`
  );
};

