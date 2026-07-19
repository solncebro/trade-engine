import { startIntervalScheduler } from './intervalScheduler';
import type { IntervalSchedulerHandle } from './intervalScheduler';

import type { FeederConnectionGuard } from '../core/FeederConnectionGuard';
import { logger } from '../core/logger';
import type { MarketDataSource } from '../core/marketDataSource.types';
import type { TelegramNotifier } from '../services/telegramNotifier';
import type { KlineInterval } from '../types/index';

// Default cadence of the silence watchdog (5 minutes). The connectionLost/connectionRestored events fire
// on a real socket close/error, but a silently stalled feed (socket up, no klines) emits neither — the
// periodic isStale() check catches that.
const FEEDER_STALE_WATCHDOG_INTERVAL_MS = 300_000;

interface FeederMonitoringContext {
  guard: FeederConnectionGuard;
  telegramNotifier: TelegramNotifier;
  // Human label of the consuming app, e.g. 'Volume Breaker' | 'MA Chaser' | 'Rubber'.
  appLabel: string;
  exchangeLabel: string;
}

interface WireFeederConnectionHandlersArgs extends FeederMonitoringContext {
  source: MarketDataSource;
}

interface RunFeederStaleCheckArgs extends FeederMonitoringContext {
  sources: Iterable<MarketDataSource>;
  // Per-interval timestamp (ms) of when each channel was first seen stale. Carried across ticks so the
  // repeated STALE alert can report HOW LONG data has been missing instead of looking like a fresh drop
  // each time. Cleared when a channel recovers. Optional: callers without it get the alert without a duration.
  staleSinceByInterval?: Map<KlineInterval, number>;
}

interface WireFeederConnectionMonitoringArgs extends FeederMonitoringContext {
  sources: Iterable<MarketDataSource>;
  staleWatchdogIntervalMs?: number;
}

// Wires the feeder connection lifecycle for a SINGLE source: connectionLost freezes the channel in the
// guard (+ warn log + Telegram DOWN alert); connectionRestored unfreezes it (+ info log + Telegram
// RESTORED alert, emitted by the feeder only after a fresh snapshot is applied). Per-source so apps that
// load timeframes lazily (e.g. MA Chaser's tier 2) can wire each source as it comes up.
function wireFeederConnectionHandlers(args: WireFeederConnectionHandlersArgs): void {
  const { source, guard, telegramNotifier, appLabel, exchangeLabel } = args;
  const interval = source.getInterval();

  source.on('connectionLost', (reason: string) => {
    guard.markChannelFrozen(interval);
    logger.warn({ interval, reason }, `[FeederMonitor] Feeder channel ${interval} connection LOST — trade actions frozen: ${reason}`);
    void telegramNotifier.sendMessage(`⚠️ ${appLabel} ${exchangeLabel} — feeder channel ${interval} DOWN. Klines frozen; trade actions on ${interval} are blocked until the connection recovers.`);
  });

  source.on('connectionRestored', () => {
    guard.markChannelRestored(interval);
    logger.info({ interval }, `[FeederMonitor] Feeder channel ${interval} connection RESTORED — fresh snapshot applied, trade actions resumed`);
    void telegramNotifier.sendMessage(`✅ ${appLabel} ${exchangeLabel} — feeder channel ${interval} RESTORED. Fresh data reloaded; trade actions on ${interval} resumed.`);
  });
}

// Formats an elapsed duration in ms as a compact "1d 2h 3m" / "2h 3m" / "3m" string for alerts.
function formatStaleDuration(elapsedMs: number): string {
  const totalMinutes = Math.floor(elapsedMs / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const partList: string[] = [];

  if (days > 0) partList.push(`${days}d`);
  if (hours > 0) partList.push(`${hours}h`);
  partList.push(`${minutes}m`);

  return partList.join(' ');
}

// One pass of the stale-feed check: for each non-frozen source whose isStale?() is true, alerts (no
// freeze — a stale feed is a soft warning; only a real connectionLost blocks trading). Already-frozen
// channels are skipped to avoid double alerts. Apps with their own audit scheduler (e.g. MA Chaser's WS
// audit) call this directly per tick; wireFeederConnectionMonitoring runs it on its own interval.
function runFeederStaleCheck(args: RunFeederStaleCheckArgs): void {
  const { guard, telegramNotifier, appLabel, exchangeLabel, staleSinceByInterval } = args;
  const nowMs = Date.now();
  const staleChannelIntervalList: KlineInterval[] = [];

  for (const source of args.sources) {
    const interval = source.getInterval();

    if (guard.isChannelFrozen(interval)) {
      staleSinceByInterval?.delete(interval);
      continue;
    }

    if (source.isStale?.() === true) {
      staleChannelIntervalList.push(interval);

      if (staleSinceByInterval && !staleSinceByInterval.has(interval)) {
        staleSinceByInterval.set(interval, nowMs);
      }
    } else {
      staleSinceByInterval?.delete(interval);
    }
  }

  if (staleChannelIntervalList.length === 0) {
    return;
  }

  const staleChannelLabel = staleChannelIntervalList.join(', ');
  // Duration of the longest-running stale channel (earliest staleSince), so the operator can see this is
  // the same ongoing outage growing — not a new disconnect each tick.
  const earliestStaleMs = staleSinceByInterval
    ? Math.min(...staleChannelIntervalList.map((interval) => staleSinceByInterval.get(interval) ?? nowMs))
    : undefined;
  const durationSuffix = earliestStaleMs !== undefined ? `, no klines for ${formatStaleDuration(nowMs - earliestStaleMs)}` : '';

  logger.warn({ staleChannelIntervalList, durationSuffix }, `[FeederMonitor] Stale watchdog — market-data feeder channel STALE/DOWN for ${staleChannelLabel}${durationSuffix}`);
  void telegramNotifier.sendMessage(`⚠️ ${appLabel} ${exchangeLabel} — market-data feeder channel STALE/DOWN (${staleChannelLabel})${durationSuffix}. Klines may be frozen; treat trading actions with caution until the feeder recovers.`);
}

// Convenience for apps that hold all sources upfront (Volume Breaker, Rubber): wires connection handlers
// for every source and starts the stale-feed watchdog on its own interval. Returns the watchdog handle
// for shutdown. The decision of WHAT to do with a frozen channel (refuse a trade, reject an action) stays
// in each app's trade paths, which consult guard.isChannelFrozen(...).
function wireFeederConnectionMonitoring(args: WireFeederConnectionMonitoringArgs): IntervalSchedulerHandle {
  const { guard, telegramNotifier, appLabel, exchangeLabel } = args;
  const staleWatchdogIntervalMs = args.staleWatchdogIntervalMs ?? FEEDER_STALE_WATCHDOG_INTERVAL_MS;
  const sourceList = [...args.sources];
  // Tracks, per channel, when it was first seen stale — lets the repeated alert report the growing outage age.
  const staleSinceByInterval = new Map<KlineInterval, number>();

  for (const source of sourceList) {
    wireFeederConnectionHandlers({ source, guard, telegramNotifier, appLabel, exchangeLabel });
  }

  const handle = startIntervalScheduler({
    tickHandler: () => {
      runFeederStaleCheck({ sources: sourceList, guard, telegramNotifier, appLabel, exchangeLabel, staleSinceByInterval });
    },
    intervalMs: staleWatchdogIntervalMs,
    contextLabel: '[FeederMonitor] Feeder stale watchdog failed',
  });

  logger.info({ intervalMs: staleWatchdogIntervalMs, channelCount: sourceList.length }, `[FeederMonitor] Feeder connection monitoring wired (stale check every ${staleWatchdogIntervalMs / 1000}s)`);

  return handle;
}

export {
  wireFeederConnectionHandlers,
  runFeederStaleCheck,
  wireFeederConnectionMonitoring,
  FEEDER_STALE_WATCHDOG_INTERVAL_MS,
};
export type {
  WireFeederConnectionHandlersArgs,
  RunFeederStaleCheckArgs,
  WireFeederConnectionMonitoringArgs,
};
