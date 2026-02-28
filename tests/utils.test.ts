import { MarketType } from '../src/types';
import { isOrderSuccessful, isSpot } from '../src/utils/order.utils';
import { normalizeSymbol } from '../src/utils/symbol.utils';
import {
  createDate,
  formatTimestamp,
  createHumanTimestamp,
} from '../src/utils/date.utils';
import { logger } from '../src/core/logger';

describe('order.utils', () => {
  test('isOrderSuccessful() returns true when orderId is present', () => {
    expect(isOrderSuccessful({ orderId: 'abc123' })).toBe(true);
  });

  test('isOrderSuccessful() returns false when orderId is missing', () => {
    expect(isOrderSuccessful({})).toBe(false);
  });

  test('isSpot() returns true for MarketType.Spot', () => {
    expect(isSpot(MarketType.Spot)).toBe(true);
  });

  test('isSpot() returns false for MarketType.Futures', () => {
    expect(isSpot(MarketType.Futures)).toBe(false);
  });

  test('isSpot() returns false for undefined', () => {
    expect(isSpot(undefined)).toBe(false);
  });
});

describe('symbol.utils', () => {
  test('normalizeSymbol() strips ccxt suffixes', () => {
    expect(normalizeSymbol('BTC/USDT:USDT')).toBe('BTCUSDT');
  });

  test('normalizeSymbol() keeps plain symbols as-is', () => {
    expect(normalizeSymbol('BTCUSDT')).toBe('BTCUSDT');
  });
});

describe('date.utils', () => {
  test('createDate() returns a Date instance', () => {
    expect(createDate()).toBeInstanceOf(Date);
  });

  test('formatTimestamp() returns HH:mm:ss.SSS format', () => {
    expect(formatTimestamp(Date.now())).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}/);
  });

  test('formatTimestamp() with isNeedDate returns full format', () => {
    expect(formatTimestamp(Date.now(), true)).toMatch(
      /\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2}\.\d{3}/
    );
  });

  test('createHumanTimestamp() returns HH:mm:ss.SSS format', () => {
    expect(createHumanTimestamp()).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}/);
  });
});

describe('logger', () => {
  test('logger exports expected methods', () => {
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });
});
