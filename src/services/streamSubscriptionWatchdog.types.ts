export type StreamType = 'kline' | 'orderbook' | 'publicTrade' | 'markPrice';

export interface StreamLastEntry {
  // For kline this is the kline openTimestamp; for heartbeat-based streams
  // (orderbook/publicTrade/markPrice) it equals the arrival wall-clock time.
  freshnessTimestamp: number;
  receivedAtMs: number;
}

export interface StreamRecoveryState {
  isInProgress: boolean;
  lastAttemptAtMs: number;
  consecutiveFailCount: number;
}

export interface StreamOverdueEntry {
  key: string;
  ageMs: number;
}

export type StreamRecoveryStatus = 'recovered' | 'failed';

export interface StreamRecoveryAttemptResult {
  key: string;
  status: StreamRecoveryStatus;
  errorText: string | null;
  // Freshness to seed after a successful recovery. Absent → "now". A replay-based
  // strategy reports the open timestamp of the last kline it fetched, so the next
  // staleness projection starts from real data rather than from the wall clock.
  freshnessTimestamp?: number;
  // How many events a replay-based recovery pushed into the user handler.
  replayedCount?: number;
}

/** What the watchdog knows about a key at the moment a recovery starts. */
export interface StreamRecoveryContext {
  lastEntry: StreamLastEntry | null;
}

export interface StreamHealthEvent {
  streamType: StreamType;
  key: string;
  ageMs?: number;
  errorText?: string;
  replayedCount?: number;
  consecutiveFailCount?: number;
}

export interface StreamWatchdogCallbacks {
  // Human-readable Telegram-style notifications (overdue / recovery summaries).
  onNotify?: (message: string) => void | Promise<void>;
  // Structured hooks so consumers can react (e.g. invalidate cached state)
  // without writing their own watchdog.
  onStreamStale?: (event: StreamHealthEvent) => void;
  onStreamRecovered?: (event: StreamHealthEvent) => void;
  onStreamRecoveryFailed?: (event: StreamHealthEvent) => void;
}

export interface StreamSubscriptionWatchdogConfig {
  isEnabled?: boolean;
  checkIntervalMs?: number;
  graceMs?: number;
  parallelismLimit?: number;
  restInterCallMs?: number;
  heartbeatEveryNTicks?: number;
  recoveryCooldownMs?: number;
  recoveryFailCooldownMs?: number;
  recoveryFailCountThreshold?: number;
}

export interface StreamScanResultFormatArgs {
  overdueList: StreamOverdueEntry[];
  resultList: StreamRecoveryAttemptResult[];
  // Overdue keys skipped this scan because their recovery was still running.
  inProgressCount: number;
}

/**
 * Encapsulates the per-stream-type behaviour the generic watchdog cannot know:
 * how to measure staleness and how to recover a stale subscription. The shared
 * machinery (scan loop, cooldown/fail-escalation, suppression, parallel batch,
 * heartbeat, notify) lives in StreamSubscriptionWatchdog and is identical for
 * every stream type. The optional members let a stream type refine the shared
 * machinery without forking it: a per-key grace (klines wait a whole extra
 * interval on quiet symbols), a one-shot preparation before a recovery batch
 * (one bulk resubscribe instead of N), and richer notification texts.
 */
export interface StreamWatchdogStrategy {
  readonly streamType: StreamType;
  // Age of a subscription relative to "now". Values > grace are overdue. The key is
  // passed for strategies whose age depends on what was subscribed (kline interval).
  computeAgeMs(entry: StreamLastEntry, nowMs: number, key: string): number;
  // Perform recovery for the given key (resubscribe + optional backfill/replay).
  // Must resolve with a result; throwing is caught and treated as 'failed'.
  recover(key: string, context: StreamRecoveryContext): Promise<StreamRecoveryAttemptResult>;
  // Whether incoming events must be withheld from the user handler during an
  // in-progress recovery (true for replay-based recovery to avoid duplicates;
  // false for resubscribe-only recovery).
  readonly suppressDuringRecovery: boolean;
  // Grace for one key; absent → the watchdog's flat graceMs (passed in as default).
  computeGraceMs?(key: string, defaultGraceMs: number): number;
  // Runs once before the recovery workers start on this batch of keys.
  prepareRecoveryBatch?(keyList: string[]): void;
  // Notification texts (each string is one message); absent → the watchdog's plain text.
  formatOverdue?(overdueList: StreamOverdueEntry[]): string[];
  formatScanResult?(args: StreamScanResultFormatArgs): string[];
  // Extra detail for the start-up log line.
  describeStartup?(): string;
}

export interface StreamSubscriptionWatchdogArgs {
  clientLabel: string;
  strategy: StreamWatchdogStrategy;
  config?: StreamSubscriptionWatchdogConfig;
  callbacks?: StreamWatchdogCallbacks;
}

export interface StreamSubscriptionWatchdogDiagnostic {
  streamType: StreamType;
  totalSubscriptions: number;
  overdueCount: number;
  inProgressCount: number;
  suppressedCount: number;
  tickCount: number;
  lastTickTimestamp: number | null;
}
