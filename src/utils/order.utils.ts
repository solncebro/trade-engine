import { EntityWithOrderId, MarketTypeEnum } from '../types';

export const isOrderSuccessful = (result: EntityWithOrderId): boolean =>
  !!result.orderId;

export const isSpot = (marketType?: MarketTypeEnum): boolean =>
  marketType === MarketTypeEnum.Spot;
