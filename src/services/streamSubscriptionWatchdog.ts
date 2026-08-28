import type {
  StreamHealthEvent,
  StreamLastEntry,
  StreamOverdueEntry,
  StreamRecoveryAttemptResult,
  StreamRecoveryContext,
  StreamRecoveryState,
  StreamScanResultFormatArgs,
  StreamSubscriptionWatchdogArgs,
  StreamSubscriptionWatchdogConfig,
  StreamSubscriptionWatchdogDiagnostic,
  StreamWatchdogCallbacks,
  StreamWatchdogStrategy,
} from './streamSubscriptionWatchdog.types';

import { logger } from '../core/logger';
import { sleep } from '../utils/sleep';

const DEFAULT_CHECK_INTERVAL_MS = 15_000;
const DEFAULT_GRACE_MS = 15_000;
const DEFAULT_PARALLELISM_LIMIT = 2;
const DEFAULT_REST_INTER_CALL_MS = 100;
const DEFAULT_HEARTBEAT_EVERY_N_TICKS = 20;
const DEFAULT_RECOVERY_COOLDOWN_MS = 60_000;
const DEFAULT_RECOVERY_FAIL_COOLDOWN_MS = 300_000;
const DEFAULT_RECOVERY_FAIL_COUNT_THRESHOLD = 3;

const FAILED_PREVIEW_COUNT = 10;
const LOG_PREFIX = '[StreamWatchdog]';

/**
 * Generic, stream-type-agnostic subscription health watchdog. Tracks per-key
 * freshness pings, detects staleness via the injected strategy, and recovers
 * stale subscriptions through the strategy with cooldown / fail-escalation /
 * suppression / bounded parallelism — the same machinery for every public
 * stream (orderbook, publicTrade, mark-price, and kline through
 * KlineWatchdogStrategy; KlineSubscriptionWatchdog is the thin shim over it).
 *
 * The watchdog is handler-type-agnostic: callers (the ExchangeConnector proxy)
 * wrap the concrete handler and feed `recordFreshness` / consult `isSuppressed`,
 * so this class never depends on a specific handler signature.
 */
export class StreamSubscriptionWatchdog {
  private readonly clientLabel: string;
  private readonly strategy: StreamWatchdogStrategy;
  private readonly callbacks: StreamWatchdogCallbacks;

  private readonly checkIntervalMs: number;
  private readonly graceMs: number;
  private readonly parallelismLimit: number;
  private readonly restInterCallMs: number;
  private readonly heartbeatEveryNTicks: number;
  private readonly recoveryCooldownMs: number;
  private readonly recoveryFailCooldownMs: number;
  private readonly recoveryFailCountThreshold: number;

  private readonly lastEntryByKey: Map<string, StreamLastEntry> = new Map();
  private readonly recoveryStateByKey: Map<string, StreamRecoveryState> = new Map();
  private readonly suppressedKeySet: Set<string> = new Set();

  private watchdogTimer: NodeJS.Timeout | null = null;
  private tickCount: number = 0;
  private lastTickTimestamp: number | null = null;
  private isStarted: boolean = false;

  constructor(args: StreamSubscriptionWatchdogArgs) {
    this.clientLabel = args.clientLabel;
    this.strategy = args.strategy;
    this.callbacks = args.callbacks ?? {};

    const config: StreamSubscriptionWatchdogConfig = args.config ?? {};
    this.checkIntervalMs = config.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.graceMs = config.graceMs ?? DEFAULT_GRACE_MS;
    this.parallelismLimit = config.parallelismLimit ?? DEFAULT_PARALLELISM_LIMIT;
    this.restInterCallMs = config.restInterCallMs ?? DEFAULT_REST_INTER_CALL_MS;
    this.heartbeatEveryNTicks = config.heartbeatEveryNTicks ?? DEFAULT_HEARTBEAT_EVERY_N_TICKS;
    this.recoveryCooldownMs = config.recoveryCooldownMs ?? DEFAULT_RECOVERY_COOLDOWN_MS;
    this.recoveryFailCooldownMs = config.recoveryFailCooldownMs ?? DEFAULT_RECOVERY_FAIL_COOLDOWN_MS;
    this.recoveryFailCountThreshold = config.recoveryFailCountThreshold ?? DEFAULT_RECOVERY_FAIL_COUNT_THRESHOLD;
  }

  public get streamLabel(): string {
    return `${this.clientLabel} ${this.strategy.streamType}`;
  }

  // Begin tracking a subscription. Seeds freshness to "now" (or to the given
  // timestamp — a kline seeds the open of the interval in progress) so a
  // just-subscribed key is not immediately flagged overdue before its first event.
  public registerKey(key: string, freshnessTimestamp?: number): void {
    if (!this.lastEntryByKey.has(key)) {
      const nowMs = Date.now();
      this.lastEntryByKey.set(key, { freshnessTimestamp: freshnessTimestamp ?? nowMs, receivedAtMs: nowMs });
    }
  }

  public unregisterKey(key: string): void {
    this.lastEntryByKey.delete(key);
    this.recoveryStateByKey.delete(key);
    this.suppressedKeySet.delete(key);
  }

  public recordFreshness(key: string, freshnessTimestamp: number): void {
    if (!Number.isFinite(freshnessTimestamp) || freshnessTimestamp <= 0) {
      return;
    }

    const previous = this.lastEntryByKey.get(key);
    const nowMs = Date.now();

    if (previous === undefined || freshnessTimestamp >= previous.freshnessTimestamp) {
      this.lastEntryByKey.set(key, { freshnessTimestamp, receivedAtMs: nowMs });
    }
  }

  public isSuppressed(key: string): boolean {
    return this.suppressedKeySet.has(key);
  }

  public start(): void {
    if (this.isStarted) {
      logger.warn(`${LOG_PREFIX} ${this.streamLabel} start called when already started — ignoring`);

      return;
    }

    this.isStarted = true;
    this.watchdogTimer = setInterval(() => {
      this.tickCount += 1;
      this.lastTickTimestamp = Date.now();

      this.runScan().catch((error: unknown) => {
        logger.error({ error, tickCount: this.tickCount }, `${LOG_PREFIX} ${this.streamLabel} runScan threw at tick #${this.tickCount}`);
      });

      if (this.tickCount % this.heartbeatEveryNTicks === 0) {
        logger.info({
          tickCount: this.tickCount,
          totalSubscriptions: this.lastEntryByKey.size,
          inProgressCount: this.countInProgress(),
          suppressedCount: this.suppressedKeySet.size,
        }, `${LOG_PREFIX} ${this.streamLabel} alive — tick #${this.tickCount}, ${this.lastEntryByKey.size} subs, ${this.countInProgress()} in recovery, ${this.suppressedKeySet.size} suppressed`);
      }
    }, this.checkIntervalMs).unref();

    const startupDetail = this.strategy.describeStartup?.() ?? '';

    logger.info({ checkIntervalMs: this.checkIntervalMs, graceMs: this.graceMs }, `${LOG_PREFIX} ${this.streamLabel} started — checkIntervalMs=${this.checkIntervalMs}, graceMs=${this.graceMs}${startupDetail.length > 0 ? `, ${startupDetail}` : ''}`);
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

    this.lastEntryByKey.clear();
    this.recoveryStateByKey.clear();
    this.suppressedKeySet.clear();

    logger.info(`${LOG_PREFIX} ${this.streamLabel} stopped`);
  }

  public getDiagnosticInfo(): StreamSubscriptionWatchdogDiagnostic {
    return {
      streamType: this.strategy.streamType,
      totalSubscriptions: this.lastEntryByKey.size,
      overdueCount: this.collectOverdueList().length,
      inProgressCount: this.countInProgress(),
      suppressedCount: this.suppressedKeySet.size,
      tickCount: this.tickCount,
      lastTickTimestamp: this.lastTickTimestamp,
    };
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
    this.emitStaleEvents(recoverableList);

    const resultList = await this.runRecoveryBatch(recoverableList);
    this.emitRecoveryEvents(resultList);
    this.notifyScanResult({ overdueList, resultList, inProgressCount });
  }

  private collectOverdueList(): StreamOverdueEntry[] {
    const nowMs = Date.now();
    const overdueList: StreamOverdueEntry[] = [];

    for (const [key, entry] of this.lastEntryByKey) {
      const ageMs = this.strategy.computeAgeMs(entry, nowMs, key);
      const graceMs = this.strategy.computeGraceMs?.(key, this.graceMs) ?? this.graceMs;

      if (ageMs <= graceMs) {
        continue;
      }

      overdueList.push({ key, ageMs });
    }

    overdueList.sort((a, b) => b.ageMs - a.ageMs);

    return overdueList;
  }

  private filterRecoverable(overdueList: StreamOverdueEntry[]): StreamOverdueEntry[] {
    const recoverableList: StreamOverdueEntry[] = [];
    const nowMs = Date.now();

    for (const entry of overdueList) {
      const recoveryState = this.getOrCreateRecoveryState(entry.key);

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

  private async runRecoveryBatch(recoverableList: StreamOverdueEntry[]): Promise<StreamRecoveryAttemptResult[]> {
    const resultList: StreamRecoveryAttemptResult[] = [];

    this.strategy.prepareRecoveryBatch?.(recoverableList.map(entry => entry.key));

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
          const result = await this.runSingleRecovery(entry.key);
          resultList.push(result);
        }
      })());
    }

    await Promise.all(workerList);

    return resultList;
  }

  private async runSingleRecovery(key: string): Promise<StreamRecoveryAttemptResult> {
    const recoveryState = this.getOrCreateRecoveryState(key);

    recoveryState.isInProgress = true;

    if (this.strategy.suppressDuringRecovery) {
      this.suppressedKeySet.add(key);
    }

    let isSuccessful = false;
    const context: StreamRecoveryContext = { lastEntry: this.lastEntryByKey.get(key) ?? null };

    try {
      const result = await this.strategy.recover(key, context);
      isSuccessful = result.status === 'recovered';

      // Seed freshness on success so a recovered key is not immediately re-flagged
      // before its next live event arrives.
      if (isSuccessful) {
        const nowMs = Date.now();
        this.lastEntryByKey.set(key, { freshnessTimestamp: result.freshnessTimestamp ?? nowMs, receivedAtMs: nowMs });
      }

      return result;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error, key }, `${LOG_PREFIX} ${this.streamLabel} recover threw for ${key}`);

      return { key, status: 'failed', errorText: errorMessage };
    } finally {
      if (this.strategy.suppressDuringRecovery) {
        this.suppressedKeySet.delete(key);
      }

      recoveryState.isInProgress = false;
      recoveryState.lastAttemptAtMs = Date.now();
      recoveryState.consecutiveFailCount = isSuccessful ? 0 : recoveryState.consecutiveFailCount + 1;
    }
  }

  private getOrCreateRecoveryState(key: string): StreamRecoveryState {
    let state = this.recoveryStateByKey.get(key);

    if (state === undefined) {
      state = { isInProgress: false, lastAttemptAtMs: 0, consecutiveFailCount: 0 };
      this.recoveryStateByKey.set(key, state);
    }

    return state;
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

  private emitStaleEvents(recoverableList: StreamOverdueEntry[]): void {
    if (this.callbacks.onStreamStale === undefined) {
      return;
    }

    for (const entry of recoverableList) {
      this.safeEmit(() => this.callbacks.onStreamStale?.(this.buildEvent(entry.key, { ageMs: entry.ageMs })));
    }
  }

  private emitRecoveryEvents(resultList: StreamRecoveryAttemptResult[]): void {
    for (const result of resultList) {
      if (result.status === 'recovered') {
        this.safeEmit(() => this.callbacks.onStreamRecovered?.(this.buildEvent(result.key, { replayedCount: result.replayedCount })));
      } else {
        const consecutiveFailCount = this.recoveryStateByKey.get(result.key)?.consecutiveFailCount;

        this.safeEmit(() => this.callbacks.onStreamRecoveryFailed?.(this.buildEvent(result.key, { errorText: result.errorText ?? 'unknown', consecutiveFailCount })));
      }
    }
  }

  private buildEvent(key: string, extra: Omit<StreamHealthEvent, 'streamType' | 'key'>): StreamHealthEvent {
    return { streamType: this.strategy.streamType, key, ...extra };
  }

  private safeEmit(action: () => void): void {
    try {
      action();
    } catch (error: unknown) {
      logger.error({ error }, `${LOG_PREFIX} ${this.streamLabel} health-event callback threw — swallowed`);
    }
  }

  private notifyOverdue(overdueList: StreamOverdueEntry[]): void {
    const formattedList = this.strategy.formatOverdue?.(overdueList);

    if (formattedList !== undefined) {
      logger.warn({ overdueCount: overdueList.length, partCount: formattedList.length }, `${LOG_PREFIX} ${this.streamLabel} ${overdueList.length} overdue, sending notify (${formattedList.length} part(s))`);

      for (const part of formattedList) {
        this.dispatchNotify(part);
      }

      return;
    }

    const previewList = overdueList.slice(0, FAILED_PREVIEW_COUNT).map((entry) => `${entry.key} (${Math.round(entry.ageMs / 1000)}s)`);
    const suffix = overdueList.length > FAILED_PREVIEW_COUNT ? `, +${overdueList.length - FAILED_PREVIEW_COUNT} more` : '';
    const message = `⚠️ ${this.streamLabel} — ${overdueList.length} subscription(s) overdue: ${previewList.join(', ')}${suffix}`;

    logger.warn({ overdueCount: overdueList.length }, `${LOG_PREFIX} ${this.streamLabel} ${overdueList.length} overdue, sending notify`);
    this.dispatchNotify(message);
  }

  private notifyScanResult(args: StreamScanResultFormatArgs): void {
    const { overdueList, resultList, inProgressCount } = args;
    const overdueCount = overdueList.length;
    const recoveredCount = resultList.filter((result) => result.status === 'recovered').length;
    const failedList = resultList.filter((result) => result.status === 'failed');
    const formattedList = this.strategy.formatScanResult?.(args);

    logger.warn({ overdueCount, recoveredCount, failedCount: failedList.length, inProgressCount }, `${LOG_PREFIX} ${this.streamLabel} scan result — overdue=${overdueCount} recovered=${recoveredCount} failed=${failedList.length} inProgress=${inProgressCount}`);

    if (formattedList !== undefined) {
      for (const part of formattedList) {
        this.dispatchNotify(part);
      }

      return;
    }

    const lineList: string[] = [`🔄 ${this.streamLabel} — recovery (overdue=${overdueCount})`];

    if (recoveredCount > 0) {
      lineList.push(`✅ Recovered: ${recoveredCount}`);
    }

    if (failedList.length > 0) {
      lineList.push(`❌ Failed: ${failedList.length}`);

      for (const failed of failedList.slice(0, FAILED_PREVIEW_COUNT)) {
        lineList.push(`   • ${failed.key} — ${failed.errorText ?? 'unknown'}`);
      }
    }

    this.dispatchNotify(lineList.join('\n'));
  }

  private dispatchNotify(message: string): void {
    if (this.callbacks.onNotify === undefined) {
      return;
    }

    try {
      const result = this.callbacks.onNotify(message);

      if (result instanceof Promise) {
        result.catch((error: unknown) => {
          logger.error({ error, messagePreview: message.slice(0, 100) }, `${LOG_PREFIX} ${this.streamLabel} onNotify rejected`);
        });
      }
    } catch (error: unknown) {
      logger.error({ error, messagePreview: message.slice(0, 100) }, `${LOG_PREFIX} ${this.streamLabel} onNotify threw synchronously`);
    }
  }
}
