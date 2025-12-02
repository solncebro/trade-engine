import { EntityWithOrderId } from '../types';

export const isOrderSuccessful = (result: EntityWithOrderId): boolean =>
  !!result.orderId;
