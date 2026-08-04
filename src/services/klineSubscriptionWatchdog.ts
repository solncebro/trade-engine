import type { ExchangeClient, Kline, KlineHandler, KlineInterval } from '@solncebro/exchange-engine';

import type {
  KlineRecoveryAttemptResult,
  KlineSubscriptionLastEntry,
  KlineSubscriptionOverdueEntry,
  KlineSubscriptionRecoveryState,
  KlineSubscriptionWatchdogArgs,
  KlineSubscriptionWatchdogConfig,
  KlineSubscriptionWatchdogDiagnostic,
  KlineWatchdogHealthEvent,
} from './klineSubscriptionWatchdog.types';

import { logger } from '../core/logger';

const DEFAULT_CHECK_INTERVAL_MS = 30_000;
const DEFAULT_GRACE_MS = 60_000;
const DEFAULT_PARALLELISM_LIMIT = 2;
const DEFAULT_REST_REFETCH_LIMIT = 100;
const DEFAULT_REST_TIMEOUT_MS = 30_000;
const DEFAULT_HEARTBEAT_EVERY_N_TICKS = 10;
const DEFAULT_RECOVERY_COOLDOWN_MS = 120_000;
const DEFAULT_RECOVERY_FAIL_COOLDOWN_MS = 600_000;
const DEFAULT_RECOVERY_FAIL_COUNT_THRESHOLD = 3;
const DEFAULT_REST_INTER_CALL_MS = 100;

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

const FAILED_PREVIEW_COUNT = 10;
const TELEGRAM_MESSAGE_LIMIT = 4096;
const LOG_PREFIX = '[KlineWatchdog]';

function buildKey(symbol: string, interval: KlineInterval): string {
  return `${symbol}:${interval}`;
}

function getIntervalMs(interval: KlineInterval): number {
  return INTERVAL_MS_BY_KEY[interval] ?? 1_800_000;
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }
  }
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

export class KlineSubscriptionWatchdog {
  private readonly client: ExchangeClient;
  private readonly clientLabel: string;
  private readonly onNotify?: (message: string) => void | Promise<void>;

  private readonly checkIntervalMs: number;
  private readonly graceMs: number;
  private readonly parallelismLimit: number;
  private readonly restRefetchLimit: number;
  private readonly restTimeoutMs: number;
  private readonly heartbeatEveryNTicks: number;
  private readonly recoveryCooldownMs: number;
  private readonly recoveryFailCooldownMs: number;
  private readonly recoveryFailCountThreshold: number;
  private readonly restInterCallMs: number;
  private readonly graceScaledIntervalSet: Set<KlineInterval>;
  private readonly symbolMarker: ((symbol: string, interval: KlineInterval) => string) | undefined;
  private readonly onStreamStale: ((event: KlineWatchdogHealthEvent) => void) | undefined;
  private readonly onStreamRecovered: ((event: KlineWatchdogHealthEvent) => void) | undefined;
  private readonly onStreamRecoveryFailed: ((event: KlineWatchdogHealthEvent) => void) | undefined;

  private readonly subscribedHandlerByKey: Map<string, KlineHandler> = new Map();
  private readonly subscribedIntervalByKey: Map<string, KlineInterval> = new Map();
  private readonly lastKlineByKey: Map<string, KlineSubscriptionLastEntry> = new Map();
  private readonly recoveryStateByKey: Map<string, KlineSubscriptionRecoveryState> = new Map();
  private readonly suppressedKeySet: Set<string> = new Set();

  private watchdogTimer: NodeJS.Timeout | null = null;
  private tickCount: number = 0;
  private lastTickTimestamp: number | null = null;
  private isStarted: boolean = false;

  constructor(args: KlineSubscriptionWatchdogArgs) {
    this.client = args.client;
    this.clientLabel = args.clientLabel;
    this.onNotify = args.onNotify;

    const config: KlineSubscriptionWatchdogConfig = args.config ?? {};
    this.checkIntervalMs = config.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.graceMs = config.graceMs ?? DEFAULT_GRACE_MS;
    this.parallelismLimit = config.parallelismLimit ?? DEFAULT_PARALLELISM_LIMIT;
    this.restRefetchLimit = config.restRefetchLimit ?? DEFAULT_REST_REFETCH_LIMIT;
    this.restTimeoutMs = config.restTimeoutMs ?? DEFAULT_REST_TIMEOUT_MS;
    this.heartbeatEveryNTicks = config.heartbeatEveryNTicks ?? DEFAULT_HEARTBEAT_EVERY_N_TICKS;
    this.recoveryCooldownMs = config.recoveryCooldownMs ?? DEFAULT_RECOVERY_COOLDOWN_MS;
    this.recoveryFailCooldownMs = config.recoveryFailCooldownMs ?? DEFAULT_RECOVERY_FAIL_COOLDOWN_MS;
    this.recoveryFailCountThreshold = config.recoveryFailCountThreshold ?? DEFAULT_RECOVERY_FAIL_COUNT_THRESHOLD;
    this.restInterCallMs = config.restInterCallMs ?? DEFAULT_REST_INTER_CALL_MS;
    this.graceScaledIntervalSet = new Set(config.graceScaledIntervalList ?? []);
    this.symbolMarker = config.symbolMarker;
    this.onStreamStale = config.onStreamStale;
    this.onStreamRecovered = config.onStreamRecovered;
    this.onStreamRecoveryFailed = config.onStreamRecoveryFailed;
  }

  private safeEmitHealthEvent(
    callback: ((event: KlineWatchdogHealthEvent) => void) | undefined,
    event: KlineWatchdogHealthEvent
  ): void {
    if (callback === undefined) {
      return;
    }

    try {
      callback(event);
    } catch (error: unknown) {
      logger.error({ error, symbol: event.symbol, interval: event.interval }, `${LOG_PREFIX} ${this.clientLabel} health-event callback threw — swallowed`);
    }
  }

  public wrapHandler(symbol: string, interval: KlineInterval, userHandler: KlineHandler): KlineHandler {
    const key = buildKey(symbol, interval);

    this.subscribedHandlerByKey.set(key, userHandler);
    this.subscribedIntervalByKey.set(key, interval);

    if (!this.lastKlineByKey.has(key)) {
      const intervalMs = getIntervalMs(interval);
      const nowMs = Date.now();
      const estimatedOpenTimestamp = Math.floor(nowMs / intervalMs) * intervalMs;
      this.lastKlineByKey.set(key, { openTimestamp: estimatedOpenTimestamp, receivedAtMs: nowMs });
    }

    const wrappedHandler: KlineHandler = (eventSymbol: string, kline: Kline): void => {
      try {
        this.recordIncomingKline(key, kline);
      } catch (error: unknown) {
        logger.error({ error, symbol, interval }, `${LOG_PREFIX} ${this.clientLabel} ${symbol} recordIncomingKline threw [${interval}]`);
      }

      if (this.suppressedKeySet.has(key)) {
        return;
      }

      try {
        userHandler(eventSymbol, kline);
      } catch (error: unknown) {
        logger.error({ error, symbol, interval }, `${LOG_PREFIX} ${this.clientLabel} ${symbol} userHandler threw — swallowed to keep SDK loop alive [${interval}]`);
      }
    };

    return wrappedHandler;
  }

  public unregisterHandler(symbol: string, interval: KlineInterval): void {
    const key = buildKey(symbol, interval);

    this.subscribedHandlerByKey.delete(key);
    this.subscribedIntervalByKey.delete(key);
    this.lastKlineByKey.delete(key);
    this.recoveryStateByKey.delete(key);
    this.suppressedKeySet.delete(key);
  }

  public start(): void {
    if (this.isStarted) {
      logger.warn(`${LOG_PREFIX} ${this.clientLabel} start called when already started — ignoring`);
      return;
    }

    this.isStarted = true;
    this.watchdogTimer = setInterval(() => {
      this.tickCount += 1;
      this.lastTickTimestamp = Date.now();

      this.runScan().catch((error: unknown) => {
        logger.error({ error, tickCount: this.tickCount }, `${LOG_PREFIX} ${this.clientLabel} runScan threw at tick #${this.tickCount}`);
      });

      if (this.tickCount % this.heartbeatEveryNTicks === 0) {
        const totalSubscriptions = this.lastKlineByKey.size;
        const inProgressCount = this.countInProgress();
        const suppressedCount = this.suppressedKeySet.size;
        logger.info({
          tickCount: this.tickCount,
          totalSubscriptions,
          inProgressCount,
          suppressedCount,
        }, `${LOG_PREFIX} ${this.clientLabel} alive — tick #${this.tickCount}, ${totalSubscriptions} subs, ${inProgressCount} in recovery, ${suppressedCount} suppressed`);
      }
    }, this.checkIntervalMs).unref();

    const graceScaledIntervalList = Array.from(this.graceScaledIntervalSet);

    logger.info({
      checkIntervalMs: this.checkIntervalMs,
      graceMs: this.graceMs,
      graceScaledIntervalList,
    }, `${LOG_PREFIX} ${this.clientLabel} started — checkIntervalMs=${this.checkIntervalMs}, graceMs=${this.graceMs}, graceScaledIntervalList=[${graceScaledIntervalList.join(', ')}]`);
  }

  public stop(): void {
    if (!this.isStarted) {
      return;
    }

    this.isStarted = false;

    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }

    this.subscribedHandlerByKey.clear();
    this.subscribedIntervalByKey.clear();
    this.lastKlineByKey.clear();
    this.recoveryStateByKey.clear();
    this.suppressedKeySet.clear();

    logger.info(`${LOG_PREFIX} ${this.clientLabel} stopped`);
  }

  public getDiagnosticInfo(): KlineSubscriptionWatchdogDiagnostic {
    return {
      totalSubscriptions: this.lastKlineByKey.size,
      overdueCount: this.collectOverdueList().length,
      inProgressCount: this.countInProgress(),
      suppressedCount: this.suppressedKeySet.size,
      tickCount: this.tickCount,
      lastTickTimestamp: this.lastTickTimestamp,
    };
  }

  private recordIncomingKline(key: string, kline: Kline): void {
    if (!Number.isFinite(kline.openTimestamp) || kline.openTimestamp <= 0) {
      return;
    }

    const previousEntry = this.lastKlineByKey.get(key);
    const nowMs = Date.now();

    if (previousEntry === undefined || kline.openTimestamp >= previousEntry.openTimestamp) {
      this.lastKlineByKey.set(key, { openTimestamp: kline.openTimestamp, receivedAtMs: nowMs });
    }
  }

  private async runScan(): Promise<void> {
    const overdueList = this.collectOverdueList();

    if (overdueList.length === 0) {
      return;
    }

    const recoverableList = this.filterRecoverable(overdueList);
    const inProgressCount = overdueList.length - recoverableList.length;

    if (recoverableList.length === 0) {
      return;
    }

    this.notifyOverdue(overdueList);

    for (const entry of recoverableList) {
      this.safeEmitHealthEvent(this.onStreamStale, { symbol: entry.symbol, interval: entry.interval, ageMs: entry.ageMs });
    }

    const resultList = await this.runRecoveryBatch(recoverableList);
    this.notifyScanResult(overdueList, resultList, inProgressCount);
  }

  private notifyOverdue(overdueList: KlineSubscriptionOverdueEntry[]): void {
    const entryListByInterval = new Map<KlineInterval, KlineSubscriptionOverdueEntry[]>();

    for (const entry of overdueList) {
      let entryList = entryListByInterval.get(entry.interval);

      if (entryList === undefined) {
        entryList = [];
        entryListByInterval.set(entry.interval, entryList);
      }

      entryList.push(entry);
    }

    const sortedIntervalList = Array.from(entryListByInterval.keys()).sort((a, b) => getIntervalMs(a) - getIntervalMs(b));

    const blockList: string[] = [];

    for (const interval of sortedIntervalList) {
      const entryList = entryListByInterval.get(interval)!;

      const entryListByLagSec = new Map<number, KlineSubscriptionOverdueEntry[]>();

      for (const entry of entryList) {
        const lagSec = Math.round(entry.ageMs / 1000);
        let lagEntryList = entryListByLagSec.get(lagSec);

        if (lagEntryList === undefined) {
          lagEntryList = [];
          entryListByLagSec.set(lagSec, lagEntryList);
        }

        lagEntryList.push(entry);
      }

      const sortedLagSecList = Array.from(entryListByLagSec.keys()).sort((a, b) => a - b);

      for (const lagSec of sortedLagSecList) {
        const lagEntryList = entryListByLagSec.get(lagSec)!;
        const block = this.buildLagBlock(interval, lagSec, lagEntryList);
        blockList.push(block);
      }
    }

    const header = `⚠️ ${this.clientLabel} — Kline subscriptions overdue (${overdueList.length} total)`;
    const fullMessage = `${header}\n\n${blockList.join('\n\n')}`;
    const partList = splitMessageByBoundary(fullMessage, TELEGRAM_MESSAGE_LIMIT);

    logger.warn({ overdueCount: overdueList.length, partCount: partList.length }, `${LOG_PREFIX} ${this.clientLabel} ${overdueList.length} subscriptions overdue, sending notify (${partList.length} part(s))`);

    for (const part of partList) {
      this.dispatchNotify(part);
    }
  }

  private buildLagBlock(interval: KlineInterval, lagSec: number, entryList: KlineSubscriptionOverdueEntry[]): string {
    const withChaserList: { symbol: string; display: string }[] = [];
    const noChaserList: string[] = [];

    for (const entry of entryList) {
      const marker = this.symbolMarker?.(entry.symbol, entry.interval) ?? '';

      if (marker.length > 0) {
        withChaserList.push({ symbol: entry.symbol, display: `${marker}${entry.symbol}` });
      } else {
        noChaserList.push(entry.symbol);
      }
    }

    withChaserList.sort((a, b) => a.symbol.localeCompare(b.symbol));
    noChaserList.sort();

    const lines: string[] = [`${interval} — Lag ${lagSec}s (${entryList.length} symbols)`];

    if (withChaserList.length > 0) {
      lines.push(withChaserList.map((entry) => entry.display).join(', '));
    }

    if (noChaserList.length > 0) {
      lines.push(noChaserList.join(', '));
    }

    return lines.join('\n');
  }

  private buildIntervalBlock(interval: KlineInterval, symbolList: string[]): string {
    const withChaserList: { symbol: string; display: string }[] = [];
    const noChaserList: string[] = [];

    for (const symbol of symbolList) {
      const marker = this.symbolMarker?.(symbol, interval) ?? '';

      if (marker.length > 0) {
        withChaserList.push({ symbol, display: `${marker}${symbol}` });
      } else {
        noChaserList.push(symbol);
      }
    }

    withChaserList.sort((a, b) => a.symbol.localeCompare(b.symbol));
    noChaserList.sort();

    const lines: string[] = [`${interval} (${symbolList.length} symbols)`];

    if (withChaserList.length > 0) {
      lines.push(withChaserList.map((entry) => entry.display).join(', '));
    }

    if (noChaserList.length > 0) {
      lines.push(noChaserList.join(', '));
    }

    return lines.join('\n');
  }

  private filterRecoverable(overdueList: KlineSubscriptionOverdueEntry[]): KlineSubscriptionOverdueEntry[] {
    const recoverableList: KlineSubscriptionOverdueEntry[] = [];
    const nowMs = Date.now();

    for (const entry of overdueList) {
      const key = buildKey(entry.symbol, entry.interval);
      const recoveryState = this.getOrCreateRecoveryState(key);

      if (recoveryState.isInProgress) {
        continue;
      }

      if (recoveryState.lastAttemptAtMs > 0) {
        const sinceLastAttemptMs = nowMs - recoveryState.lastAttemptAtMs;
        const requiredCooldownMs = recoveryState.consecutiveFailCount >= this.recoveryFailCountThreshold
          ? this.recoveryFailCooldownMs
          : this.recoveryCooldownMs;

        if (sinceLastAttemptMs < requiredCooldownMs) {
          continue;
        }
      }

      recoverableList.push(entry);
    }

    return recoverableList;
  }

  private collectOverdueList(): KlineSubscriptionOverdueEntry[] {
    const nowMs = Date.now();
    const overdueList: KlineSubscriptionOverdueEntry[] = [];

    for (const [key, entry] of this.lastKlineByKey) {
      const interval = this.subscribedIntervalByKey.get(key);

      if (interval === undefined) {
        continue;
      }

      const intervalMs = getIntervalMs(interval);
      const expectedNextOpenTimestamp = entry.openTimestamp + intervalMs;
      const ageMs = nowMs - expectedNextOpenTimestamp;

      if (ageMs <= this.calcGraceMs(interval)) {
        continue;
      }

      const symbol = this.parseSymbolFromKey(key);

      overdueList.push({
        symbol,
        interval,
        ageMs,
        expectedNextOpenTimestamp,
      });
    }

    overdueList.sort((a, b) => b.ageMs - a.ageMs);

    return overdueList;
  }

  private calcGraceMs(interval: KlineInterval): number {
    if (!this.graceScaledIntervalSet.has(interval)) {
      return this.graceMs;
    }

    return getIntervalMs(interval) + this.graceMs;
  }

  private parseSymbolFromKey(key: string): string {
    const colonIndex = key.lastIndexOf(':');

    if (colonIndex < 0) {
      return key;
    }

    return key.slice(0, colonIndex);
  }

  private notifyScanResult(
    overdueList: KlineSubscriptionOverdueEntry[],
    resultList: KlineRecoveryAttemptResult[],
    inProgressCount: number
  ): void {
    const overdueByInterval = new Map<KlineInterval, number>();

    for (const entry of overdueList) {
      overdueByInterval.set(entry.interval, (overdueByInterval.get(entry.interval) ?? 0) + 1);
    }

    const overdueIntervalLabel = Array.from(overdueByInterval.entries())
      .map(([interval, count]) => `${interval}: ${count}`)
      .join(', ');

    const recoveredList = resultList.filter((result) => result.status === 'recovered');
    const failedList = resultList.filter((result) => result.status === 'failed');

    if (failedList.length === 0 && inProgressCount === 0 && recoveredList.length > 0) {
      const recoveredByInterval = new Map<KlineInterval, KlineRecoveryAttemptResult[]>();

      for (const recovered of recoveredList) {
        let group = recoveredByInterval.get(recovered.interval);

        if (group === undefined) {
          group = [];
          recoveredByInterval.set(recovered.interval, group);
        }

        group.push(recovered);
      }

      const sortedIntervalList = Array.from(recoveredByInterval.keys()).sort((a, b) => getIntervalMs(a) - getIntervalMs(b));
      const blockList: string[] = [];

      for (const interval of sortedIntervalList) {
        const group = recoveredByInterval.get(interval)!;
        const symbolList = group.map((recovered) => recovered.symbol);
        const block = this.buildIntervalBlock(interval, symbolList);
        blockList.push(block);
      }

      const header = `✅ ${this.clientLabel} — Kline recovery complete (${recoveredList.length} symbols, ${overdueIntervalLabel})`;
      const fullMessage = `${header}\n\n${blockList.join('\n\n')}`;
      const partList = splitMessageByBoundary(fullMessage, TELEGRAM_MESSAGE_LIMIT);

      logger.info({ recoveredCount: recoveredList.length, partCount: partList.length }, `${LOG_PREFIX} ${this.clientLabel} recovery complete, sending notify (${partList.length} part(s))`);

      for (const part of partList) {
        this.dispatchNotify(part);
      }

      return;
    }

    const lineList: string[] = [`🔄 ${this.clientLabel} — Kline recovery (${overdueIntervalLabel})`];

    if (recoveredList.length > 0) {
      lineList.push(`✅ Recovered: ${recoveredList.length}`);
    }

    if (failedList.length > 0) {
      lineList.push(`❌ Failed: ${failedList.length}`);
      const previewList = failedList.slice(0, FAILED_PREVIEW_COUNT);

      for (const failed of previewList) {
        const errorText = failed.errorText ?? 'unknown';
        lineList.push(`   • ${failed.symbol} (${failed.interval}) — ${errorText}`);
      }

      if (failedList.length > FAILED_PREVIEW_COUNT) {
        lineList.push(`   (+${failedList.length - FAILED_PREVIEW_COUNT} more)`);
      }
    }

    if (inProgressCount > 0) {
      lineList.push(`⏳ In progress (skipped this scan): ${inProgressCount}`);
    }

    logger.warn({
      overdueCount: overdueList.length,
      recoveredCount: recoveredList.length,
      failedCount: failedList.length,
      inProgressCount,
    }, `${LOG_PREFIX} ${this.clientLabel} scan result — overdue=${overdueList.length} recovered=${recoveredList.length} failed=${failedList.length} inProgress=${inProgressCount}`);

    this.dispatchNotify(lineList.join('\n'));
  }

  private async runRecoveryBatch(recoverableList: KlineSubscriptionOverdueEntry[]): Promise<KlineRecoveryAttemptResult[]> {
    const resultList: KlineRecoveryAttemptResult[] = [];

    let cursor = 0;
    const workerCount = Math.min(this.parallelismLimit, recoverableList.length);

    const workerList: Promise<void>[] = [];

    for (let i = 0; i < workerCount; i += 1) {
      workerList.push((async () => {
        let isFirstEntry = true;

        while (true) {
          const index = cursor;
          cursor += 1;

          if (index >= recoverableList.length) {
            return;
          }

          if (!isFirstEntry && this.restInterCallMs > 0) {
            await sleep(this.restInterCallMs);
          }
          isFirstEntry = false;

          const entry = recoverableList[index];

          try {
            const result = await this.tryRecover(entry);
            resultList.push(result);
          } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error({ error, symbol: entry.symbol, interval: entry.interval }, `${LOG_PREFIX} ${this.clientLabel} ${entry.symbol} tryRecover threw [${entry.interval}]`);
            resultList.push({ symbol: entry.symbol, interval: entry.interval, status: 'failed', replayedCount: 0, errorText: errorMessage });
          }
        }
      })());
    }

    await Promise.all(workerList);

    return resultList;
  }

  private getOrCreateRecoveryState(key: string): KlineSubscriptionRecoveryState {
    let state = this.recoveryStateByKey.get(key);

    if (state === undefined) {
      state = { isInProgress: false, lastAttemptAtMs: 0, consecutiveFailCount: 0 };
      this.recoveryStateByKey.set(key, state);
    }

    return state;
  }

  private async tryRecover(entry: KlineSubscriptionOverdueEntry): Promise<KlineRecoveryAttemptResult> {
    const { symbol, interval } = entry;
    const key = buildKey(symbol, interval);
    const recoveryState = this.getOrCreateRecoveryState(key);

    recoveryState.isInProgress = true;
    this.suppressedKeySet.add(key);
    let isAttemptSuccessful = false;

    try {
      logger.debug({ symbol, interval }, `${LOG_PREFIX} ${this.clientLabel} ${symbol} resubscribeKlines request [${interval}]`);

      try {
        this.client.resubscribeKlines({ symbol, interval });
      } catch (error: unknown) {
        logger.warn({ error, symbol, interval }, `${LOG_PREFIX} ${this.clientLabel} ${symbol} resubscribeKlines failed — proceeding to REST refetch [${interval}]`);
      }

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

        return { symbol, interval, status: 'failed', replayedCount: 0, errorText: `REST: ${errorMessage}` };
      }

      logger.debug({ symbol, interval, klineCount: restKlineList.length }, `${LOG_PREFIX} ${this.clientLabel} ${symbol} fetchKlines response klineCount=${restKlineList.length} [${interval}]`);

      if (restKlineList.length === 0) {
        logger.warn({ symbol, interval }, `${LOG_PREFIX} ${this.clientLabel} ${symbol} fetchKlines returned empty list — aborting replay [${interval}]`);

        return { symbol, interval, status: 'failed', replayedCount: 0, errorText: 'REST returned empty' };
      }

      const userHandler = this.subscribedHandlerByKey.get(key);

      if (userHandler === undefined) {
        logger.warn({ symbol, interval }, `${LOG_PREFIX} ${this.clientLabel} ${symbol} userHandler missing — skipping replay [${interval}]`);

        return { symbol, interval, status: 'failed', replayedCount: 0, errorText: 'handler missing' };
      }

      const lastKnownOpenTimestamp = this.lastKlineByKey.get(key)?.openTimestamp ?? 0;
      const freshKlineList = restKlineList.filter((kline) => kline.openTimestamp > lastKnownOpenTimestamp);
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
      this.lastKlineByKey.set(key, { openTimestamp: lastRestKline.openTimestamp, receivedAtMs: Date.now() });

      logger.debug({ symbol, interval, replayedCount, skippedCount, totalCount: restKlineList.length }, `${LOG_PREFIX} ${this.clientLabel} ${symbol} recovery complete — replayed ${replayedCount} fresh kline(s), skipped ${skippedCount} already-known kline(s) [${interval}]`);

      isAttemptSuccessful = true;

      return { symbol, interval, status: 'recovered', replayedCount, errorText: null };
    } finally {
      this.suppressedKeySet.delete(key);
      recoveryState.isInProgress = false;
      recoveryState.lastAttemptAtMs = Date.now();

      if (isAttemptSuccessful) {
        recoveryState.consecutiveFailCount = 0;
        this.safeEmitHealthEvent(this.onStreamRecovered, { symbol, interval });
      } else {
        recoveryState.consecutiveFailCount += 1;
        this.safeEmitHealthEvent(this.onStreamRecoveryFailed, {
          symbol,
          interval,
          consecutiveFailCount: recoveryState.consecutiveFailCount,
        });
      }
    }
  }

  private countInProgress(): number {
    let count = 0;

    for (const state of this.recoveryStateByKey.values()) {
      if (state.isInProgress) {
        count += 1;
      }
    }

    return count;
  }

  private dispatchNotify(message: string): void {
    if (this.onNotify === undefined) {
      return;
    }

    try {
      const result = this.onNotify(message);

      if (result instanceof Promise) {
        result.catch((error: unknown) => {
          logger.error({ error, messagePreview: message.slice(0, 100) }, `${LOG_PREFIX} ${this.clientLabel} onNotify rejected`);
        });
      }
    } catch (error: unknown) {
      logger.error({ error, messagePreview: message.slice(0, 100) }, `${LOG_PREFIX} ${this.clientLabel} onNotify threw synchronously`);
    }
  }
}
