import type { LeverageTier } from '@solncebro/exchange-engine';

import { fitLeverage } from './leverageFit';
import type {
  ComputeMaxLeverageBeforeStopArgs,
  EntryLeverage,
  EstimateIsolatedLiquidationPriceArgs,
  MaxLeverageBeforeStop,
  ResolveEntryLeverageArgs,
} from './liquidationLeverage.types';
import { formatPercent } from './numberFormat';

// Guards the float noise of k = 1 / L around whole numbers (1 / 0.2 = 4.999999…).
const LEVERAGE_EPSILON = 1e-9;

/**
 * Isolated-margin liquidation price of a fresh position, both exchanges' published formula with
 * the position's own margin as the only collateral:
 *
 *   Binance USDⓈ-M (isolated: WB = isolated wallet balance, TMM = 0, UPNL = 0)
 *     LP = (WB + cum − side × Q × EP) / (Q × MMR − side × Q)
 *   Bybit USDT perpetual, isolated
 *     LP(long)  = [EP × Q − EP × Q / L − extra / (1 − takerFee) − MMdeduction] / [Q − Q × MMR]
 *     LP(short) = [EP × Q + EP × Q / L + extra / (1 + takerFee) + MMdeduction] / [Q + Q × MMR]
 *
 * With WB = EP × Q / L, no extra margin and cum = MMdeduction = 0 both collapse to
 *   long  LP = EP × (1 − 1/L) / (1 − MMR)
 *   short LP = EP × (1 + 1/L) / (1 + MMR)
 *
 * Approximated (all on the safe side or covered by the caller's buffer): the maintenance deduction
 * (cum) is taken as zero — it only moves the liquidation FURTHER from the entry; the opening fee that
 * Binance takes from the isolated wallet and the closing-fee estimate Bybit adds to the maintenance
 * margin are ignored — they move it slightly CLOSER, which the liquidation buffer must absorb; the
 * mark price the exchange liquidates by is taken equal to the fill price at the entry.
 */
function estimateIsolatedLiquidationPrice(args: EstimateIsolatedLiquidationPriceArgs): number {
  const { entryPrice, leverage, direction } = args;
  const maintenanceRate = args.maintenanceMarginPercent / 100;

  if (direction === 'long') {
    return (entryPrice * (1 - 1 / leverage)) / (1 - maintenanceRate);
  }

  return (entryPrice * (1 + 1 / leverage)) / (1 + maintenanceRate);
}

function toTierCapUsd(tier: LeverageTier, entryPrice: number): number | null {
  const capUsd = tier.maxNotional ?? (tier.maxBaseAmount === null ? null : tier.maxBaseAmount * entryPrice);

  return capUsd === null || !(capUsd > 0) ? null : capUsd;
}

interface TierWithCap {
  tier: LeverageTier;
  capUsd: number;
}

function toSortedTierList(tierList: ReadonlyArray<LeverageTier>, entryPrice: number): TierWithCap[] {
  return tierList
    .flatMap(tier => {
      const capUsd = toTierCapUsd(tier, entryPrice);

      return capUsd === null ? [] : [{ tier, capUsd }];
    })
    .sort((left, right) => left.capUsd - right.capUsd);
}

/** The tier a position at `leverage` falls into: by its size when known, otherwise the widest tier that still admits the leverage. */
function resolveTierAt(tierList: ReadonlyArray<TierWithCap>, leverage: number, marginUsd: number | undefined): TierWithCap | null {
  if (marginUsd !== undefined) {
    const tier = tierList.find(item => item.capUsd >= marginUsd * leverage) ?? null;

    return tier !== null && tier.tier.maxLeverage >= leverage ? tier : null;
  }

  const allowedList = tierList.filter(item => item.tier.maxLeverage >= leverage);

  return allowedList.length === 0 ? null : allowedList[allowedList.length - 1];
}

function isValidPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * The largest WHOLE leverage (≤ maxLeverage) at which an isolated position liquidates beyond the
 * stop-loss by at least `liquidationBufferPercent` of the stop price — the stop must be hit first.
 * Liquidation price: see estimateIsolatedLiquidationPrice. A tier table (optional) supplies the
 * maintenance rate of the tier the position lands in and caps the leverage by that tier.
 */
function computeMaxLeverageBeforeStop(args: ComputeMaxLeverageBeforeStopArgs): MaxLeverageBeforeStop {
  const { entryPrice, stopPrice, direction, liquidationBufferPercent, marginUsd } = args;
  const topLeverage = Math.floor(args.maxLeverage + LEVERAGE_EPSILON);

  if (!isValidPositive(entryPrice) || !isValidPositive(stopPrice) || topLeverage < 1 || !(liquidationBufferPercent >= 0)) {
    return { isFound: false, reason: 'invalid_input' };
  }

  if ((direction === 'long' && stopPrice >= entryPrice) || (direction === 'short' && stopPrice <= entryPrice)) {
    return { isFound: false, reason: 'stop_on_wrong_side' };
  }

  const tierList = toSortedTierList(args.leverageTierList ?? [], entryPrice);
  const hasTierList = tierList.length > 0;

  if (!hasTierList && args.maintenanceMarginPercent === undefined) {
    return { isFound: false, reason: 'no_maintenance_margin' };
  }

  const limitPrice = direction === 'long' ? stopPrice * (1 - liquidationBufferPercent / 100) : stopPrice * (1 + liquidationBufferPercent / 100);
  let lastSkipReason: 'stop' | 'tier' | 'no_maintenance_margin' | null = null;
  let hasStopFailure = false;

  for (let leverage = topLeverage; leverage >= 1; leverage -= 1) {
    const tier = hasTierList ? resolveTierAt(tierList, leverage, marginUsd) : null;

    if (hasTierList && tier === null) {
      lastSkipReason = 'tier';
      continue;
    }

    const tierMaintenancePercent = tier?.tier.maintenanceMarginRate === null || tier === null ? null : tier.tier.maintenanceMarginRate * 100;
    const candidatePercentList = [args.maintenanceMarginPercent, tierMaintenancePercent ?? undefined].filter((value): value is number => value !== undefined);

    if (candidatePercentList.length === 0) {
      lastSkipReason = 'no_maintenance_margin';
      continue;
    }

    const maintenanceMarginPercent = Math.max(...candidatePercentList);
    const liquidationPrice = estimateIsolatedLiquidationPrice({ entryPrice, leverage, direction, maintenanceMarginPercent });
    const isBeyondStop = direction === 'long' ? liquidationPrice <= limitPrice : liquidationPrice >= limitPrice;

    if (!isBeyondStop) {
      lastSkipReason = 'stop';
      hasStopFailure = true;
      continue;
    }

    return {
      isFound: true,
      leverage,
      liquidationPrice,
      maintenanceMarginPercent,
      limitedBy: leverage === topLeverage ? 'max_leverage' : lastSkipReason === 'tier' ? 'tier' : 'stop',
    };
  }

  if (hasStopFailure) {
    return { isFound: false, reason: 'stop_too_close' };
  }

  return { isFound: false, reason: lastSkipReason === 'no_maintenance_margin' ? 'no_maintenance_margin' : 'no_tier_for_size' };
}

function formatLeverage(leverage: number): string {
  return `×${Number(leverage.toFixed(2))}`;
}

/**
 * Final entry leverage: the signal's (or default) leverage, lowered so the liquidation lies beyond
 * the stop (computeMaxLeverageBeforeStop), then fitted to the exchange's tier caps (fitLeverage).
 * Each step can only LOWER the leverage, and a lower leverage moves the liquidation further away, so
 * the tier step never undoes the stop guard.
 */
function resolveEntryLeverage(args: ResolveEntryLeverageArgs): EntryLeverage {
  const { desiredLeverage } = args;
  const stopGuard = args.stopGuard === null ? null : computeMaxLeverageBeforeStop({ ...args.stopGuard, maxLeverage: desiredLeverage });

  if (stopGuard !== null && !stopGuard.isFound) {
    return {
      isResolved: false,
      reason: stopGuard.reason,
      stopGuard,
      explanation: `no leverage keeps the liquidation beyond the stop (${stopGuard.reason})`,
    };
  }

  const stopLimitedLeverage = stopGuard === null ? desiredLeverage : stopGuard.leverage;
  const isStopLimited = stopGuard !== null && stopLimitedLeverage < desiredLeverage;
  const stopNote = stopGuard === null
    ? 'no stop — liquidation guard skipped'
    : isStopLimited
      ? `lowered ${formatLeverage(desiredLeverage)} → ${formatLeverage(stopLimitedLeverage)} so the liquidation (maintenance ${formatPercent(stopGuard.maintenanceMarginPercent)}%) lies beyond the stop`
      : `${formatLeverage(stopLimitedLeverage)} keeps the liquidation beyond the stop`;
  const tierFit = args.tierFit === null ? null : fitLeverage({ ...args.tierFit, desiredLeverage: stopLimitedLeverage });
  const leverage = tierFit === null ? stopLimitedLeverage : tierFit.leverage;
  const limitedBy = tierFit !== null && tierFit.leverage < stopLimitedLeverage ? 'tier_cap' : isStopLimited ? 'stop' : 'desired';
  const explanation = tierFit === null ? stopNote : `${stopNote}; ${tierFit.explanation}`;

  return { isResolved: true, leverage, limitedBy, stopGuard, tierFit, explanation };
}

export { computeMaxLeverageBeforeStop, estimateIsolatedLiquidationPrice, resolveEntryLeverage };
