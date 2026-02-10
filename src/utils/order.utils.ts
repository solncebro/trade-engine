import { EntityWithOrderId, MarketType } from '../types';

export const isOrderSuccessful = (result: EntityWithOrderId): boolean =>
  !!result.orderId;

export const isSpot = (marketType?: MarketType): boolean =>
  marketType === MarketType.Spot;
