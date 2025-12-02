import { EntiryWithOrderId } from '../types';

export const isOrderSuccessful = (result: EntiryWithOrderId): boolean =>
  !!result.orderId;

