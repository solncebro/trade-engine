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
}

export interface StreamHealthEvent {
  streamType: StreamType;
  key: string;
  ageMs?: number;
  errorText?: string;
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

/**
 * Encapsulates the per-stream-type behaviour the generic watchdog cannot know:
 * how to measure staleness and how to recover a stale subscription. The shared
 * machinery (scan loop, cooldown/fail-escalation, suppression, parallel batch,
 * heartbeat, notify) lives in StreamSubscriptionWatchdog and is identical for
 * every stream type.
 */
export interface StreamWatchdogStrategy {
  readonly streamType: StreamType;
  // Age of a subscription relative to "now". Values > graceMs are overdue.
  computeAgeMs(entry: StreamLastEntry, nowMs: number): number;
  // Perform recovery for the given key (resubscribe + optional backfill/replay).
  // Must resolve with a result; throwing is caught and treated as 'failed'.
  recover(key: string): Promise<StreamRecoveryAttemptResult>;
  // Whether incoming events must be withheld from the user handler during an
  // in-progress recovery (true for replay-based recovery to avoid duplicates;
  // false for resubscribe-only recovery).
  readonly suppressDuringRecovery: boolean;
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
