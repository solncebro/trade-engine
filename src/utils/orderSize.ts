import type { DeriveOrderPlanArgs, OrderPlan } from './orderSize.types';

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function deriveOrderPlan({ totalNotional, requestedSize, minCount }: DeriveOrderPlanArgs): OrderPlan {
  if (!Number.isInteger(minCount) || minCount < 1) {
    return { count: 1, actualSize: 0 };
  }

  if (!isPositiveFinite(totalNotional) || !isPositiveFinite(requestedSize)) {
    return { count: minCount, actualSize: 0 };
  }

  const count = Math.max(minCount, Math.round(totalNotional / requestedSize));
  const actualSize = Math.floor(totalNotional / count);

  return { count, actualSize };
}

export { deriveOrderPlan };
