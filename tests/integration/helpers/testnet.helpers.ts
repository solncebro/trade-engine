import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { ExchangeConnector } from '../../../src/services/exchangeConnector';
import {
  ExchangeConfig,
  ExchangeNameEnum,
  MarketTypeEnum,
  PositionModeEnum,
} from '../../../src/types';

const ENVIRONMENT_LINE_REGEX = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
const SURROUNDING_QUOTES_REGEX = /^(['"])(.*)\1$/s;

function unquoteEnvironmentValue(rawValue: string): string {
  const trimmedValue = rawValue.trim();
  const quotedMatch = SURROUNDING_QUOTES_REGEX.exec(trimmedValue);

  return quotedMatch === null ? trimmedValue : quotedMatch[2];
}

/**
 * Своё чтение `.env.test` вместо `dotenv` (пакета в проекте нет) и вместо встроенного
 * `process.loadEnvFile` (внутри Jest он пишет в НАСТОЯЩЕЕ окружение процесса, а тест видит
 * подменённую песочницей копию `process.env` — значения до проверок не доезжают).
 */
function loadTestEnvironmentFile(): void {
  const envTestPath = path.resolve(__dirname, '../../../.env.test');

  if (!existsSync(envTestPath)) {
    return;
  }

  for (const line of readFileSync(envTestPath, 'utf8').split('\n')) {
    if (line.trim().startsWith('#')) {
      continue;
    }

    const lineMatch = ENVIRONMENT_LINE_REGEX.exec(line);

    if (lineMatch === null) {
      continue;
    }

    process.env[lineMatch[1]] = unquoteEnvironmentValue(lineMatch[2]);
  }
}

loadTestEnvironmentFile();

export const BINANCE_DEMO_CONFIG: ExchangeConfig = {
  apiKey: process.env.BINANCE_DEMO_API_KEY ?? '',
  secret: process.env.BINANCE_DEMO_SECRET_KEY ?? '',
  isDemoMode: true,
};

export const BYBIT_DEMO_CONFIG: ExchangeConfig = {
  apiKey: process.env.BYBIT_DEMO_API_KEY ?? '',
  secret: process.env.BYBIT_DEMO_SECRET_KEY ?? '',
  isDemoMode: true,
};

export const OKX_DEMO_CONFIG: ExchangeConfig = {
  apiKey: process.env.OKX_DEMO_API_KEY ?? '',
  secret: process.env.OKX_DEMO_SECRET_KEY ?? '',
  passphrase: process.env.OKX_DEMO_PASSPHRASE ?? '',
  isDemoMode: true,
};

const DEMO_CONFIG_BY_EXCHANGE: ReadonlyMap<ExchangeNameEnum, ExchangeConfig> =
  new Map([
    [ExchangeNameEnum.Binance, BINANCE_DEMO_CONFIG],
    [ExchangeNameEnum.Bybit, BYBIT_DEMO_CONFIG],
    [ExchangeNameEnum.Okx, OKX_DEMO_CONFIG],
  ]);

function hasDemoCredentials(exchangeName: ExchangeNameEnum): boolean {
  const config = DEMO_CONFIG_BY_EXCHANGE.get(exchangeName);

  if (config === undefined) {
    return false;
  }

  if (config.apiKey === '' || config.secret === '') {
    return false;
  }

  if (exchangeName !== ExchangeNameEnum.Okx) {
    return true;
  }

  return (config.passphrase ?? '') !== '';
}

export function describeIfCredentials(
  exchangeName: ExchangeNameEnum,
  name: string,
  fn: () => void
): void {
  if (hasDemoCredentials(exchangeName)) {
    describe(name, fn);

    return;
  }

  describe.skip(`${name} (no ${exchangeName} demo credentials)`, fn);
}

export const MIN_TEST_USDT = 100;

export const BINANCE_FUTURES_TEST_SYMBOL = 'ETHUSDT';
export const BINANCE_FUTURES_TEST_SYMBOL_LIST = [
  BINANCE_FUTURES_TEST_SYMBOL,
  'FLOKIUSDT',
  'SHIBUSDT',
];

export const BYBIT_FUTURES_TEST_SYMBOL = 'BTCUSDT';
export const BYBIT_FUTURES_TEST_SYMBOL_LIST = [
  BYBIT_FUTURES_TEST_SYMBOL,
  'SATSUSDT',
  'FLOKIUSDT',
  'MOGUSDT',
];

/**
 * У OKX множителя в названии нет вовсе: один контракт стоит `ctVal` монет, и число это лежит
 * отдельным полем, а не приставкой к имени. Живой список подтверждает — `FLOKI-USDT-SWAP`
 * (ctVal 100000), `SHIB-USDT-SWAP`, `SATS-USDT-SWAP` названы без приставок, а те три
 * инструмента, что начинаются с цифры (`0G`, `1INCH`, `2Z`), — настоящие имена монет.
 * Поэтому от `resolveSymbolWithPrefix` тут ждём символ ровно таким, каким его дали.
 */
export const OKX_FUTURES_TEST_SYMBOL = 'ETHUSDT';
export const OKX_FUTURES_TEST_SYMBOL_LIST = [
  OKX_FUTURES_TEST_SYMBOL,
  'FLOKIUSDT',
  'SHIBUSDT',
  'SATSUSDT',
];

export function calculateTestAmount(
  connector: ExchangeConnector,
  symbol: string,
  price: number
): number {
  return connector.futures.amountToPrecision(symbol, MIN_TEST_USDT / price);
}

async function readFuturesPositionMode(
  connector: ExchangeConnector
): Promise<PositionModeEnum> {
  try {
    return (await connector.futures.fetchPositionMode()) ?? PositionModeEnum.OneWay;
  } catch {
    return PositionModeEnum.OneWay;
  }
}

/**
 * Счёт живой, и в каком он режиме — знает только он сам. Спрашиваем биржу и собираем коннектор
 * под ответ: на счёте в режиме «лонг и шорт» заявка без стороны позиции законно отвергается
 * (OKX отвечает `OKX_POSITION_SIDE_REQUIRED`), а односторонний режим — значение по умолчанию,
 * поэтому пересборка нужна только счёту в двустороннем.
 */
export async function createDemoConnector(
  exchangeName: ExchangeNameEnum,
  config: ExchangeConfig
): Promise<ExchangeConnector> {
  const probeConnector = new ExchangeConnector(exchangeName, config);
  await probeConnector.initialize();

  const positionMode = await readFuturesPositionMode(probeConnector);

  if (positionMode === PositionModeEnum.OneWay) {
    return probeConnector;
  }

  await probeConnector.disconnect();

  const connector = new ExchangeConnector(
    exchangeName,
    config,
    undefined,
    positionMode
  );
  await connector.initialize();

  return connector;
}

export async function waitForTickers(
  connector: ExchangeConnector,
  symbol: string,
  timeoutMs = 30000
): Promise<void> {
  const pollIntervalMs = 1000;
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const resolvedSymbol = connector.resolveSymbolWithPrefix(
      symbol,
      MarketTypeEnum.Futures
    );
    const ticker = connector.getTicker(resolvedSymbol, MarketTypeEnum.Futures);

    if (ticker?.lastPrice !== undefined && ticker.lastPrice > 0) {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`Tickers for ${symbol} did not populate within ${timeoutMs}ms`);
}
