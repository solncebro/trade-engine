interface DeriveOrderPlanArgs {
  totalNotional: number;
  requestedSize: number;
  minCount: number;
}

interface OrderPlan {
  count: number;
  actualSize: number;
}

export type { DeriveOrderPlanArgs, OrderPlan };
