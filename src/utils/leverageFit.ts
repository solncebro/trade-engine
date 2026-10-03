import type { FitLeverageArgs, LeverageFit, TierCap } from './leverageFit.types';
import { formatUsdAmount } from './numberFormat';

/** The exchange measures the position by MARK price, and a short's mark drifts above the fill price
 *  right after the entry — a plan sized exactly to the cap would be pushed over it by that drift and
 *  the next order refused (the very refusal this module exists to prevent). */
export const LEVERAGE_TIER_HEADROOM_PERCENT = 3;

function formatLeverage(leverage: number): string {
  return `×${Number(leverage.toFixed(2))}`;
}

function money(value: number): string {
  return `$${formatUsdAmount(Math.round(value))}`;
}

function toTierCapList(args: FitLeverageArgs): TierCap[] {
  return args.tierList
    .flatMap((tier) => {
      const capUsd = tier.maxNotional ?? (tier.maxBaseAmount === null ? null : tier.maxBaseAmount * args.price);

      return capUsd === null || !(capUsd > 0) ? [] : [{ tier, capUsd }];
    })
    .sort((left, right) => left.capUsd - right.capUsd);
}

/** The tier that rules at leverage L: the widest cap among tiers still allowing L. */
function tierAt(tierCapList: ReadonlyArray<TierCap>, leverage: number): TierCap | null {
  const allowedList = tierCapList.filter((item) => item.tier.maxLeverage >= leverage);

  return allowedList.length === 0 ? null : allowedList[allowedList.length - 1];
}

function initialMarginRateAt(tierCapList: ReadonlyArray<TierCap>, leverage: number): number {
  return tierAt(tierCapList, leverage)?.tier.initialMarginRate ?? 1 / leverage;
}

function withHeadroom(usd: number): number {
  return usd * (1 + LEVERAGE_TIER_HEADROOM_PERCENT / 100);
}

function withoutHeadroom(usd: number): number {
  return usd / (1 + LEVERAGE_TIER_HEADROOM_PERCENT / 100);
}

/**
 * Picks the leverage an entry must run on so that the exchange's position cap (risk tier / leverage
 * bracket) admits the whole plan — and, when the free margin cannot pay for that, the lowest leverage
 * the margin still allows with as much of the plan as fits there (owner's rule, 17.09.2026, AVAUSDT).
 * Pure: the caller reads the tier table, the balance and the plan; this only judges. The leverage
 * never goes UP on a busy symbol — raising it under a position moves the liquidation point.
 */
export function fitLeverage(args: FitLeverageArgs): LeverageFit {
  const { planUsd, committedUsd, freeMarginUsd, isSymbolBusy, currentLeverage } = args;
  const tierCapList = toTierCapList(args);
  const frozenLeverage = isSymbolBusy && currentLeverage !== null ? currentLeverage : null;
  const busyDesired = frozenLeverage === null ? args.desiredLeverage : Math.min(args.desiredLeverage, frozenLeverage);

  if (tierCapList.length === 0) {
    return {
      verdict: 'no_tiers',
      leverage: busyDesired,
      desiredLeverage: busyDesired,
      isClampedToSymbolMax: false,
      allowedUsd: planUsd,
      capAtDesiredUsd: null,
      extraMarginUsd: null,
      explanation: `no tier table for the symbol — ${formatLeverage(busyDesired)} kept, the plan is not checked against a cap`,
    };
  }

  const symbolMaxLeverage = Math.max(...tierCapList.map((item) => item.tier.maxLeverage));
  const isClampedToSymbolMax = busyDesired > symbolMaxLeverage;
  const desiredLeverage = Math.min(busyDesired, symbolMaxLeverage);
  const capAtDesiredUsd = tierAt(tierCapList, desiredLeverage)?.capUsd ?? 0;
  const neededUsd = withHeadroom(planUsd);
  const cappedAllowedUsd = Math.max(committedUsd, withoutHeadroom(capAtDesiredUsd));
  const clampNote = isClampedToSymbolMax ? ` (setting ${formatLeverage(args.desiredLeverage)} is above the symbol's maximum ${formatLeverage(symbolMaxLeverage)})` : '';
  const base = { desiredLeverage, isClampedToSymbolMax, capAtDesiredUsd };

  if (capAtDesiredUsd >= neededUsd) {
    return {
      ...base,
      verdict: 'fits',
      leverage: desiredLeverage,
      allowedUsd: planUsd,
      extraMarginUsd: null,
      explanation: `${formatLeverage(desiredLeverage)} fits: tier cap ${money(capAtDesiredUsd)} ≥ plan ${money(planUsd)}${clampNote}`,
    };
  }

  const capNote = `tier cap ${money(capAtDesiredUsd)} at ${formatLeverage(desiredLeverage)} < plan ${money(planUsd)}`;

  if (isSymbolBusy && currentLeverage === null) {
    return {
      ...base,
      verdict: 'capped',
      leverage: desiredLeverage,
      allowedUsd: cappedAllowedUsd,
      extraMarginUsd: null,
      explanation: `${formatLeverage(desiredLeverage)} kept: ${capNote}, and the symbol's current leverage is unknown — it is not changed under a live position`,
    };
  }

  if (freeMarginUsd === null) {
    return {
      ...base,
      verdict: 'capped',
      leverage: desiredLeverage,
      allowedUsd: cappedAllowedUsd,
      extraMarginUsd: null,
      explanation: `${formatLeverage(desiredLeverage)} kept: ${capNote}, and the free margin could not be read — nothing is lowered blindly`,
    };
  }

  const frozenMarginUsd = committedUsd * initialMarginRateAt(tierCapList, currentLeverage ?? desiredLeverage);
  const extraMarginFor = (leverage: number, notionalUsd: number): number => notionalUsd * initialMarginRateAt(tierCapList, leverage) - frozenMarginUsd;
  // Candidates are the tiers below the desired leverage, widest cap last; the first one whose cap admits
  // the whole plan is the highest leverage that does.
  const lowerTierList = tierCapList.filter((item) => item.tier.maxLeverage < desiredLeverage);
  const fullTier = lowerTierList.find((item) => item.capUsd >= neededUsd) ?? null;

  if (fullTier !== null) {
    const extraMarginUsd = extraMarginFor(fullTier.tier.maxLeverage, planUsd);

    if (extraMarginUsd <= freeMarginUsd) {
      return {
        ...base,
        verdict: 'lowered',
        leverage: fullTier.tier.maxLeverage,
        allowedUsd: planUsd,
        extraMarginUsd,
        explanation: `lowered ${formatLeverage(desiredLeverage)} → ${formatLeverage(fullTier.tier.maxLeverage)}: ${capNote}; extra margin ${money(extraMarginUsd)} of free ${money(freeMarginUsd)}${clampNote}`,
      };
    }
  }

  // Walk from the widest cap the margin cannot pay for towards the desired leverage: the first tier the
  // free margin covers admits the most of the plan among those it can pay for.
  const partialTierList = lowerTierList.filter((item) => item.capUsd < neededUsd).reverse();

  for (const item of partialTierList) {
    const notionalUsd = Math.max(committedUsd, withoutHeadroom(item.capUsd));
    const extraMarginUsd = extraMarginFor(item.tier.maxLeverage, notionalUsd);

    if (extraMarginUsd <= freeMarginUsd) {
      return {
        ...base,
        verdict: 'lowered_partially',
        leverage: item.tier.maxLeverage,
        allowedUsd: notionalUsd,
        extraMarginUsd,
        explanation: `lowered ${formatLeverage(desiredLeverage)} → ${formatLeverage(item.tier.maxLeverage)} as far as the margin allows: ${capNote}; ${money(notionalUsd)} fits at ${formatLeverage(item.tier.maxLeverage)}, extra margin ${money(extraMarginUsd)} of free ${money(freeMarginUsd)}${clampNote}`,
      };
    }
  }

  const fullNote = fullTier === null ? 'no tier admits the whole plan' : `lowering to ${formatLeverage(fullTier.tier.maxLeverage)} needs ${money(extraMarginFor(fullTier.tier.maxLeverage, planUsd))} more margin`;

  return {
    ...base,
    verdict: 'capped',
    leverage: desiredLeverage,
    allowedUsd: cappedAllowedUsd,
    extraMarginUsd: null,
    explanation: `${formatLeverage(desiredLeverage)} kept: ${capNote}; ${fullNote}, free ${money(freeMarginUsd)}${clampNote}`,
  };
}
