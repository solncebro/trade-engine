import type { ExchangeClient, Kline, KlineHandler, KlineInterval } from '@solncebro/exchange-engine';

import type { KlineWatchdogStrategyArgs } from './klineWatchdogStrategy.types';
import type {
  StreamLastEntry,
  StreamOverdueEntry,
  StreamRecoveryAttemptResult,
  StreamRecoveryContext,
  StreamScanResultFormatArgs,
  StreamType,
  StreamWatchdogStrategy,
} from './streamSubscriptionWatchdog.types';

import { logger } from '../core/logger';
import { withTimeout } from '../utils/timeout';

const DEFAULT_REST_REFETCH_LIMIT = 100;
const DEFAULT_REST_TIMEOUT_MS = 30_000;
const FAILED_PREVIEW_COUNT = 10;
const TELEGRAM_MESSAGE_LIMIT = 4096;
const LOG_PREFIX = '[KlineWatchdog]';
const FALLBACK_INTERVAL_MS = 1_800_000;

const INTERVAL_MS_BY_KEY: Record<string, number> = {
  '1s': 1_000,
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '6h': 21_600_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '3d': 259_200_000,
  '1w': 604_800_000,
  '1M': 2_592_000_000,
};

interface KlineWatchdogKey {
  symbol: string;
  interval: KlineInterval;
}

interface KlineOverdueEntry extends KlineWatchdogKey {
  ageMs: number;
}

interface KlineRecoveryResultEntry extends KlineWatchdogKey {
  result: StreamRecoveryAttemptResult;
}

function buildKlineWatchdogKey(symbol: string, interval: KlineInterval): string {
  return `${symbol}:${interval}`;
}

function parseKlineWatchdogKey(key: string): KlineWatchdogKey {
  const colonIndex = key.lastIndexOf(':');

  if (colonIndex < 0) {
    return { symbol: key, interval: '' as KlineInterval };
  }

  return { symbol: key.slice(0, colonIndex), interval: key.slice(colonIndex + 1) as KlineInterval };
}

function getIntervalMs(interval: KlineInterval): number {
  return INTERVAL_MS_BY_KEY[interval] ?? FALLBACK_INTERVAL_MS;
}

function splitMessageByBoundary(message: string, limit: number): string[] {
  if (message.length <= limit) {
    return [message];
  }

  const partList: string[] = [];
  const blockList = message.split('\n\n');
  let current = '';

  for (const block of blockList) {
    const candidate = current.length === 0 ? block : `${current}\n\n${block}`;

    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }

    if (current.length > 0) {
      partList.push(current);
      current = '';
    }

    if (block.length <= limit) {
      current = block;
      continue;
    }

    const subPartList = splitOversizedBlock(block, limit);

    for (let i = 0; i < subPartList.length - 1; i += 1) {
      partList.push(subPartList[i]);
    }

    current = subPartList[subPartList.length - 1] ?? '';
  }

  if (current.length > 0) {
    partList.push(current);
  }

  return partList;
}

function splitOversizedBlock(block: string, limit: number): string[] {
  const lineList = block.split('\n');
  const headerLine = lineList[0];
  const tailLineList = lineList.slice(1);
  const result: string[] = [];

  for (const line of tailLineList) {
    const candidate = `${headerLine}\n${line}`;

    if (candidate.length <= limit) {
      result.push(candidate);
      continue;
    }

    const symbolList = line.split(', ');
    const headerWithNewline = `${headerLine}\n`;
    let chunkSymbolList: string[] = [];
    let chunkLength = headerWithNewline.length;

    for (const symbol of symbolList) {
      const additionLength = chunkSymbolList.length === 0 ? symbol.length : symbol.length + 2;

      if (chunkLength + additionLength > limit && chunkSymbolList.length > 0) {
        result.push(`${headerWithNewline}${chunkSymbolList.join(', ')}`);
        chunkSymbolList = [symbol];
        chunkLength = headerWithNewline.length + symbol.length;
        continue;
      }

      chunkSymbolList.push(symbol);
      chunkLength += additionLength;
    }

    if (chunkSymbolList.length > 0) {
      result.push(`${headerWithNewline}${chunkSymbolList.join(', ')}`);
    }
  }

  return result;
}

function groupBy<T, K>(list: T[], keyOf: (item: T) => K): Map<K, T[]> {
  const groupByKey = new Map<K, T[]>();

  for (const item of list) {
    const key = keyOf(item);
    let group = groupByKey.get(key);

    if (group === undefined) {
      group = [];
      groupByKey.set(key, group);
    }

    group.push(item);
  }

  return groupByKey;
}

function sortIntervalList(intervalList: KlineInterval[]): KlineInterval[] {
  return [...intervalList].sort((a, b) => getIntervalMs(a) - getIntervalMs(b));
}

/**
 * Kline behaviour for StreamSubscriptionWatchdog. Staleness is a projection, not a
 * heartbeat: a subscription is overdue once the kline that should have followed the
 * last seen one has not arrived within the grace (plus a whole interval for the
 * intervals listed in `graceScaledIntervalList` — a quiet symbol legitimately skips
 * a kline). Recovery is one bulk resubscribe for the whole batch, then per key a REST
 * refetch replayed into the user handler (only klines newer than the last seen one),
 * with the live handler suppressed meanwhile so nothing is delivered twice.
 * Notifications keep the interval-grouped Telegram layout the operators read.
 */
class KlineWatchdogStrategy implements StreamWatchdogStrategy {
  public readonly streamType: StreamType = 'kline';
  public readonly suppressDuringRecovery = true;

  private readonly client: ExchangeClient;
  private readonly clientLabel: string;
  private readonly restRefetchLimit: number;
  private readonly restTimeoutMs: number;
  private readonly graceScaledIntervalSet: Set<KlineInterval>;
  private readonly symbolMarker: ((symbol: string, interval: KlineInterval) => string) | undefined;
  private readonly handlerByKey: Map<string, KlineHandler> = new Map();
  private readonly intervalByKey: Map<string, KlineInterval> = new Map();

  public constructor(args: KlineWatchdogStrategyArgs) {
    this.client = args.client;
    this.clientLabel = args.clientLabel;
    this.restRefetchLimit = args.restRefetchLimit ?? DEFAULT_REST_REFETCH_LIMIT;
    this.restTimeoutMs = args.restTimeoutMs ?? DEFAULT_REST_TIMEOUT_MS;
    this.graceScaledIntervalSet = new Set(args.graceScaledIntervalList ?? []);
    this.symbolMarker = args.symbolMarker;
  }

  public registerHandler(symbol: string, interval: KlineInterval, handler: KlineHandler): string {
    const key = buildKlineWatchdogKey(symbol, interval);

    this.handlerByKey.set(key, handler);
    this.intervalByKey.set(key, interval);

    return key;
  }

  public forgetKey(key: string): void {
    this.handlerByKey.delete(key);
    this.intervalByKey.delete(key);
  }

  public clear(): void {
    this.handlerByKey.clear();
    this.intervalByKey.clear();
  }

  /** The open timestamp of the interval in progress right now — the seed for a fresh subscription. */
  public estimateCurrentOpenTimestamp(interval: KlineInterval, nowMs: number): number {
    const intervalMs = getIntervalMs(interval);

    return Math.floor(nowMs / intervalMs) * intervalMs;
  }

  // Age = how long the kline that should have followed the last seen one is late.
  public computeAgeMs(entry: StreamLastEntry, nowMs: number, key: string): number {
    const interval = this.intervalByKey.get(key);

    if (interval === undefined) {
      // Unknown interval → never overdue (nothing to resubscribe to).
      return Number.NEGATIVE_INFINITY;
    }

    return nowMs - (entry.freshnessTimestamp + getIntervalMs(interval));
  }

  public computeGraceMs(key: string, defaultGraceMs: number): number {
    const interval = this.intervalByKey.get(key);

    return interval !== undefined && this.graceScaledIntervalSet.has(interval) ? getIntervalMs(interval) + defaultGraceMs : defaultGraceMs;
  }

  public prepareRecoveryBatch(keyList: string[]): void {
    const subscriptionList = keyList.map(key => parseKlineWatchdogKey(key));

    try {
      this.client.resubscribeKlineList(subscriptionList);
    } catch (error: unknown) {
      logger.warn({ error, subscriptionCount: subscriptionList.length }, `${LOG_PREFIX} ${this.clientLabel} bulk resubscribeKlineList failed — proceeding to REST refetch`);
    }
  }

  public async recover(key: string, context: StreamRecoveryContext): Promise<StreamRecoveryAttemptResult> {
    const { symbol, interval } = parseKlineWatchdogKey(key);

    logger.debug({ symbol, interval, restRefetchLimit: this.restRefetchLimit }, `${LOG_PREFIX} ${this.clientLabel} ${symbol} fetchKlines request limit=${this.restRefetchLimit} [${interval}]`);

    let restKlineList: Kline[];

    try {
      restKlineList = await withTimeout(
        this.client.fetchKlines(symbol, interval, { limit: this.restRefetchLimit }),
        this.restTimeoutMs,
        `${this.clientLabel} fetchKlines timeout for ${symbol} ${interval}`
      );
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error({ error, symbol, interval }, `${LOG_PREFIX} ${this.clientLabel} ${symbol} fetchKlines failed: ${errorMessage} [${interval}]`);

      return { key, status: 'failed', errorText: `REST: ${errorMessage}`, replayedCount: 0 };
    }

    logger.debug({ symbol, interval, klineCount: restKlineList.length }, `${LOG_PREFIX} ${this.clientLabel} ${symbol} fetchKlines response klineCount=${restKlineList.length} [${interval}]`);

    if (restKlineList.length === 0) {
      logger.warn({ symbol, interval }, `${LOG_PREFIX} ${this.clientLabel} ${symbol} fetchKlines returned empty list — aborting replay [${interval}]`);

      return { key, status: 'failed', errorText: 'REST returned empty', replayedCount: 0 };
    }

    const userHandler = this.handlerByKey.get(key);

    if (userHandler === undefined) {
      logger.warn({ symbol, interval }, `${LOG_PREFIX} ${this.clientLabel} ${symbol} userHandler missing — skipping replay [${interval}]`);

      return { key, status: 'failed', errorText: 'handler missing', replayedCount: 0 };
    }

    const lastKnownOpenTimestamp = context.lastEntry?.freshnessTimestamp ?? 0;
    const freshKlineList = restKlineList.filter(kline => kline.openTimestamp > lastKnownOpenTimestamp);
    const skippedCount = restKlineList.length - freshKlineList.length;
    let replayedCount = 0;

    for (const kline of freshKlineList) {
      try {
        userHandler(symbol, kline);
        replayedCount += 1;
      } catch (error: unknown) {
        logger.error({ error, symbol, interval, openTimestamp: kline.openTimestamp }, `${LOG_PREFIX} ${this.clientLabel} ${symbol} userHandler threw on REST replay — continuing [${interval}]`);
      }
    }

    const lastRestKline = restKlineList[restKlineList.length - 1];

    logger.debug({ symbol, interval, replayedCount, skippedCount, totalCount: restKlineList.length }, `${LOG_PREFIX} ${this.clientLabel} ${symbol} recovery complete — replayed ${replayedCount} fresh kline(s), skipped ${skippedCount} already-known kline(s) [${interval}]`);

    return { key, status: 'recovered', errorText: null, replayedCount, freshnessTimestamp: lastRestKline.openTimestamp };
  }

  public formatOverdue(overdueList: StreamOverdueEntry[]): string[] {
    const entryList: KlineOverdueEntry[] = overdueList.map(entry => ({ ...parseKlineWatchdogKey(entry.key), ageMs: entry.ageMs }));
    const entryListByInterval = groupBy(entryList, entry => entry.interval);
    const blockList: string[] = [];

    for (const interval of sortIntervalList([...entryListByInterval.keys()])) {
      const entryListByLagSec = groupBy(entryListByInterval.get(interval)!, entry => Math.round(entry.ageMs / 1000));

      for (const lagSec of [...entryListByLagSec.keys()].sort((a, b) => a - b)) {
        const lagEntryList = entryListByLagSec.get(lagSec)!;

        blockList.push(this.buildSymbolBlock(`${interval} — Lag ${lagSec}s (${lagEntryList.length} symbols)`, interval, lagEntryList.map(entry => entry.symbol)));
      }
    }

    const header = `⚠️ ${this.clientLabel} — Kline subscriptions overdue (${overdueList.length} total)`;

    return splitMessageByBoundary(`${header}\n\n${blockList.join('\n\n')}`, TELEGRAM_MESSAGE_LIMIT);
  }

  public formatScanResult(args: StreamScanResultFormatArgs): string[] {
    const { overdueList, resultList, inProgressCount } = args;
    const overdueCountByInterval = new Map<KlineInterval, number>();

    for (const entry of overdueList) {
      const { interval } = parseKlineWatchdogKey(entry.key);

      overdueCountByInterval.set(interval, (overdueCountByInterval.get(interval) ?? 0) + 1);
    }

    const overdueIntervalLabel = [...overdueCountByInterval.entries()].map(([interval, count]) => `${interval}: ${count}`).join(', ');
    const resultEntryList: KlineRecoveryResultEntry[] = resultList.map(result => ({ ...parseKlineWatchdogKey(result.key), result }));
    const recoveredList = resultEntryList.filter(entry => entry.result.status === 'recovered');
    const failedList = resultEntryList.filter(entry => entry.result.status === 'failed');

    if (failedList.length === 0 && inProgressCount === 0 && recoveredList.length > 0) {
      const recoveredByInterval = groupBy(recoveredList, entry => entry.interval);
      const blockList = sortIntervalList([...recoveredByInterval.keys()]).map(interval => {
        const symbolList = recoveredByInterval.get(interval)!.map(entry => entry.symbol);

        return this.buildSymbolBlock(`${interval} (${symbolList.length} symbols)`, interval, symbolList);
      });
      const header = `✅ ${this.clientLabel} — Kline recovery complete (${recoveredList.length} symbols, ${overdueIntervalLabel})`;

      return splitMessageByBoundary(`${header}\n\n${blockList.join('\n\n')}`, TELEGRAM_MESSAGE_LIMIT);
    }

    const lineList: string[] = [`🔄 ${this.clientLabel} — Kline recovery (${overdueIntervalLabel})`];

    if (recoveredList.length > 0) {
      lineList.push(`✅ Recovered: ${recoveredList.length}`);
    }

    if (failedList.length > 0) {
      lineList.push(`❌ Failed: ${failedList.length}`);

      for (const failed of failedList.slice(0, FAILED_PREVIEW_COUNT)) {
        lineList.push(`   • ${failed.symbol} (${failed.interval}) — ${failed.result.errorText ?? 'unknown'}`);
      }

      if (failedList.length > FAILED_PREVIEW_COUNT) {
        lineList.push(`   (+${failedList.length - FAILED_PREVIEW_COUNT} more)`);
      }
    }

    if (inProgressCount > 0) {
      lineList.push(`⏳ In progress (skipped this scan): ${inProgressCount}`);
    }

    return [lineList.join('\n')];
  }

  public describeStartup(): string {
    return `graceScaledIntervalList=[${[...this.graceScaledIntervalSet].join(', ')}]`;
  }

  // Symbols carrying a marker (e.g. "has a chaser") go on their own line, marked, ahead of
  // the plain ones — the operator sees at a glance which stale symbols hold live positions.
  private buildSymbolBlock(headerLine: string, interval: KlineInterval, symbolList: string[]): string {
    const markedList: { symbol: string; display: string }[] = [];
    const plainList: string[] = [];

    for (const symbol of symbolList) {
      const marker = this.symbolMarker?.(symbol, interval) ?? '';

      if (marker.length > 0) {
        markedList.push({ symbol, display: `${marker}${symbol}` });
      } else {
        plainList.push(symbol);
      }
    }

    markedList.sort((a, b) => a.symbol.localeCompare(b.symbol));
    plainList.sort();

    const lineList: string[] = [headerLine];

    if (markedList.length > 0) {
      lineList.push(markedList.map(entry => entry.display).join(', '));
    }

    if (plainList.length > 0) {
      lineList.push(plainList.join(', '));
    }

    return lineList.join('\n');
  }
}

export { buildKlineWatchdogKey, getIntervalMs, KlineWatchdogStrategy, parseKlineWatchdogKey };
