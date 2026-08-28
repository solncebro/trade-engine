import type { Kline, KlineHandler, KlineInterval } from '@solncebro/exchange-engine';

import type {
  KlineSubscriptionWatchdogArgs,
  KlineSubscriptionWatchdogConfig,
  KlineSubscriptionWatchdogDiagnostic,
  KlineWatchdogHealthEvent,
} from './klineSubscriptionWatchdog.types';
import { buildKlineWatchdogKey, KlineWatchdogStrategy, parseKlineWatchdogKey } from './klineWatchdogStrategy';
import { StreamSubscriptionWatchdog } from './streamSubscriptionWatchdog';
import type { StreamHealthEvent } from './streamSubscriptionWatchdog.types';

import { logger } from '../core/logger';

// Kline defaults are wider than the heartbeat streams': a kline arrives once per
// interval, not several times a second, so both the scan and the grace breathe slower.
const DEFAULT_CHECK_INTERVAL_MS = 30_000;
const DEFAULT_GRACE_MS = 60_000;
const DEFAULT_HEARTBEAT_EVERY_N_TICKS = 10;
const DEFAULT_RECOVERY_COOLDOWN_MS = 120_000;
const DEFAULT_RECOVERY_FAIL_COOLDOWN_MS = 600_000;
const LOG_PREFIX = '[KlineWatchdog]';

function toKlineHealthEvent(event: StreamHealthEvent): KlineWatchdogHealthEvent {
  const { symbol, interval } = parseKlineWatchdogKey(event.key);

  return {
    symbol,
    interval,
    ...(event.ageMs !== undefined ? { ageMs: event.ageMs } : {}),
    ...(event.replayedCount !== undefined ? { replayedCount: event.replayedCount } : {}),
    ...(event.errorText !== undefined ? { errorText: event.errorText } : {}),
    ...(event.consecutiveFailCount !== undefined ? { consecutiveFailCount: event.consecutiveFailCount } : {}),
  };
}

/**
 * The kline face of StreamSubscriptionWatchdog: the same public surface the
 * ExchangeConnector proxy and consumers have always used (wrapHandler /
 * unregisterHandler / start / stop / getDiagnosticInfo / kline-shaped health
 * events), implemented as a thin shim over the generic watchdog plus
 * KlineWatchdogStrategy. All scan / cooldown / suppression / parallelism
 * machinery lives in the generic class — this file only translates keys.
 */
export class KlineSubscriptionWatchdog {
  private readonly clientLabel: string;
  private readonly strategy: KlineWatchdogStrategy;
  private readonly watchdog: StreamSubscriptionWatchdog;

  constructor(args: KlineSubscriptionWatchdogArgs) {
    const config: KlineSubscriptionWatchdogConfig = args.config ?? {};

    this.clientLabel = args.clientLabel;
    this.strategy = new KlineWatchdogStrategy({
      client: args.client,
      clientLabel: args.clientLabel,
      restRefetchLimit: config.restRefetchLimit,
      restTimeoutMs: config.restTimeoutMs,
      graceScaledIntervalList: config.graceScaledIntervalList,
      symbolMarker: config.symbolMarker,
    });
    this.watchdog = new StreamSubscriptionWatchdog({
      clientLabel: args.clientLabel,
      strategy: this.strategy,
      config: {
        checkIntervalMs: config.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS,
        graceMs: config.graceMs ?? DEFAULT_GRACE_MS,
        parallelismLimit: config.parallelismLimit,
        restInterCallMs: config.restInterCallMs,
        heartbeatEveryNTicks: config.heartbeatEveryNTicks ?? DEFAULT_HEARTBEAT_EVERY_N_TICKS,
        recoveryCooldownMs: config.recoveryCooldownMs ?? DEFAULT_RECOVERY_COOLDOWN_MS,
        recoveryFailCooldownMs: config.recoveryFailCooldownMs ?? DEFAULT_RECOVERY_FAIL_COOLDOWN_MS,
        recoveryFailCountThreshold: config.recoveryFailCountThreshold,
      },
      callbacks: {
        onNotify: args.onNotify,
        onStreamStale: config.onStreamStale === undefined ? undefined : (event): void => config.onStreamStale?.(toKlineHealthEvent(event)),
        onStreamRecovered: config.onStreamRecovered === undefined ? undefined : (event): void => config.onStreamRecovered?.(toKlineHealthEvent(event)),
        onStreamRecoveryFailed: config.onStreamRecoveryFailed === undefined ? undefined : (event): void => config.onStreamRecoveryFailed?.(toKlineHealthEvent(event)),
      },
    });
  }

  public wrapHandler(symbol: string, interval: KlineInterval, userHandler: KlineHandler): KlineHandler {
    const key = this.strategy.registerHandler(symbol, interval, userHandler);

    this.watchdog.registerKey(key, this.strategy.estimateCurrentOpenTimestamp(interval, Date.now()));

    return (eventSymbol: string, kline: Kline): void => {
      this.watchdog.recordFreshness(key, kline.openTimestamp);

      if (this.watchdog.isSuppressed(key)) {
        return;
      }

      try {
        userHandler(eventSymbol, kline);
      } catch (error: unknown) {
        logger.error({ error, symbol, interval }, `${LOG_PREFIX} ${this.clientLabel} ${symbol} userHandler threw — swallowed to keep SDK loop alive [${interval}]`);
      }
    };
  }

  public unregisterHandler(symbol: string, interval: KlineInterval): void {
    const key = buildKlineWatchdogKey(symbol, interval);

    this.strategy.forgetKey(key);
    this.watchdog.unregisterKey(key);
  }

  public start(): void {
    this.watchdog.start();
  }

  public stop(): void {
    this.watchdog.stop();
    this.strategy.clear();
  }

  public getDiagnosticInfo(): KlineSubscriptionWatchdogDiagnostic {
    const { streamType: _streamType, ...diagnostic } = this.watchdog.getDiagnosticInfo();

    return diagnostic;
  }
}
