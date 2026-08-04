import type { ExchangeClient, KlineInterval } from '@solncebro/exchange-engine';

// Structured health event — mirrors the generic StreamSubscriptionWatchdog event
// contract so consumers treat kline and non-kline stream health uniformly.
export interface KlineWatchdogHealthEvent {
  symbol: string;
  interval: KlineInterval;
  ageMs?: number;
  replayedCount?: number;
  errorText?: string;
  consecutiveFailCount?: number;
}

export interface KlineSubscriptionWatchdogConfig {
  isEnabled?: boolean;
  checkIntervalMs?: number;
  graceMs?: number;
  parallelismLimit?: number;
  restRefetchLimit?: number;
  restTimeoutMs?: number;
  heartbeatEveryNTicks?: number;
  recoveryCooldownMs?: number;
  recoveryFailCooldownMs?: number;
  recoveryFailCountThreshold?: number;
  restInterCallMs?: number;
  graceScaledIntervalList?: KlineInterval[];
  symbolMarker?: (symbol: string, interval: KlineInterval) => string;
  // Structured health hooks (fired alongside onNotify). Consumers (e.g. ma-chaser)
  // hook onStreamRecoveryFailed to escalate after persistent recovery failure.
  onStreamStale?: (event: KlineWatchdogHealthEvent) => void;
  onStreamRecovered?: (event: KlineWatchdogHealthEvent) => void;
  onStreamRecoveryFailed?: (event: KlineWatchdogHealthEvent) => void;
}

export interface KlineSubscriptionWatchdogArgs {
  client: ExchangeClient;
  clientLabel: string;
  config?: KlineSubscriptionWatchdogConfig;
  onNotify?: (message: string) => void | Promise<void>;
}

export interface KlineSubscriptionLastEntry {
  openTimestamp: number;
  receivedAtMs: number;
}

export interface KlineSubscriptionRecoveryState {
  isInProgress: boolean;
  lastAttemptAtMs: number;
  consecutiveFailCount: number;
}

export interface KlineSubscriptionOverdueEntry {
  symbol: string;
  interval: KlineInterval;
  ageMs: number;
  expectedNextOpenTimestamp: number;
}

export type KlineRecoveryAttemptStatus = 'recovered' | 'failed';

export interface KlineRecoveryAttemptResult {
  symbol: string;
  interval: KlineInterval;
  status: KlineRecoveryAttemptStatus;
  replayedCount: number;
  errorText: string | null;
}

export interface KlineSubscriptionWatchdogDiagnostic {
  totalSubscriptions: number;
  overdueCount: number;
  inProgressCount: number;
  suppressedCount: number;
  tickCount: number;
  lastTickTimestamp: number | null;
}
