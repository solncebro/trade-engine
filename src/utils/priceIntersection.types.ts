import type { Kline } from '../types/index';

interface HasPriceCrossedOrderPriceArgs {
  klineList: readonly Kline[];
  fromOpenTimestamp: number;
  orderPrice: number;
  direction: 'long' | 'short';
}

export type { HasPriceCrossedOrderPriceArgs };
