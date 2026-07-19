import { ExchangeClient } from '../src/types';
import {
  MAX_ORDER_SPLIT_PIECES,
  parseFilterValue,
  sizeLegList,
  sizeOrder,
  splitOrderQty,
} from '../src/utils/sizeOrder';

const SYMBOL = 'TESTUSDT';

interface MockOpts {
  stepSize?: number;
  minQty?: number;
  minNotional?: number;
  marketMaxQty?: number;
  maxQty?: number;
  loaded?: boolean;
}

const makeClient = (opts: MockOpts = {}): ExchangeClient => {
  const stepSize = opts.stepSize ?? 0;
  const tradeSymbols = new Map<string, unknown>();

  if (opts.loaded !== false) {
    tradeSymbols.set(SYMBOL, { filter: { stepSize: String(stepSize) } });
  }

  const roundToStep = (amount: number): number =>
    stepSize > 0 ? Math.round(amount / stepSize) * stepSize : Math.floor(amount);

  return {
    tradeSymbols,
    amountToPrecision: jest.fn((_symbol: string, amount: number) =>
      roundToStep(amount)
    ),
    getMinOrderQty: jest.fn(() => opts.minQty ?? 0),
    getMinNotional: jest.fn(() => opts.minNotional ?? 0),
    getMaxOrderQty: jest.fn(() => opts.maxQty ?? 0),
    getMarketMaxOrderQty: jest.fn(() => opts.marketMaxQty ?? opts.maxQty ?? 0),
  } as unknown as ExchangeClient;
};

describe('parseFilterValue', () => {
  test('parses positive finite, rejects empty/zero/negative', () => {
    expect(parseFilterValue('100')).toBe(100);
    expect(parseFilterValue(undefined)).toBeUndefined();
    expect(parseFilterValue('')).toBeUndefined();
    expect(parseFilterValue('0')).toBeUndefined();
    expect(parseFilterValue('-5')).toBeUndefined();
  });
});

describe('splitOrderQty', () => {
  test('no split when fullQty <= cap', () => {
    const client = makeClient({ maxQty: 5, stepSize: 1 });
    expect(
      splitOrderQty({ exchangeClient: client, symbol: SYMBOL, fullQty: 3, orderKind: 'limit' })
    ).toEqual([3]);
  });

  test('no usable cap → single unsplit piece', () => {
    const client = makeClient({ maxQty: 0, marketMaxQty: 0 });
    expect(
      splitOrderQty({ exchangeClient: client, symbol: SYMBOL, fullQty: 1234, orderKind: 'market' })
    ).toEqual([1234]);
  });

  test('even split', () => {
    const client = makeClient({ maxQty: 5, stepSize: 1 });
    expect(
      splitOrderQty({ exchangeClient: client, symbol: SYMBOL, fullQty: 15, orderKind: 'limit' })
    ).toEqual([5, 5, 5]);
  });

  test('drop residual tail below minQty', () => {
    const client = makeClient({ maxQty: 5, stepSize: 1, minQty: 3 });
    // 12 → [5,5], residual 2 < minQty 3 → dropped
    expect(
      splitOrderQty({ exchangeClient: client, symbol: SYMBOL, fullQty: 12, orderKind: 'limit' })
    ).toEqual([5, 5]);
  });

  test('drop chunk below minQty (minQty > cap) → empty', () => {
    const client = makeClient({ maxQty: 5, stepSize: 1, minQty: 6 });
    expect(
      splitOrderQty({ exchangeClient: client, symbol: SYMBOL, fullQty: 10, orderKind: 'limit' })
    ).toEqual([]);
  });

  test('round-up-past-cap is floored back within the cap', () => {
    // cap 5, step 2 → round(5/2)*2 = 6 (> cap) → floored to floor(5/2)*2 = 4
    const client = makeClient({ maxQty: 5, stepSize: 2 });
    const result = splitOrderQty({
      exchangeClient: client,
      symbol: SYMBOL,
      fullQty: 10,
      orderKind: 'limit',
    });
    expect(result.every((piece) => piece <= 5)).toBe(true);
    expect(result).toEqual([4, 4, 2]);
  });

  test('caps piece count at MAX_ORDER_SPLIT_PIECES', () => {
    const client = makeClient({ maxQty: 1, stepSize: 1, minQty: 0 });
    const result = splitOrderQty({
      exchangeClient: client,
      symbol: SYMBOL,
      fullQty: MAX_ORDER_SPLIT_PIECES + 500,
      orderKind: 'limit',
    });
    expect(result.length).toBe(MAX_ORDER_SPLIT_PIECES);
  });

  test('invalid fullQty → []', () => {
    const client = makeClient({ maxQty: 5 });
    expect(splitOrderQty({ exchangeClient: client, symbol: SYMBOL, fullQty: 0, orderKind: 'limit' })).toEqual([]);
    expect(splitOrderQty({ exchangeClient: client, symbol: SYMBOL, fullQty: -1, orderKind: 'limit' })).toEqual([]);
    expect(splitOrderQty({ exchangeClient: client, symbol: SYMBOL, fullQty: NaN, orderKind: 'limit' })).toEqual([]);
  });

  test('market vs limit selects the matching cap', () => {
    const client = makeClient({ maxQty: 100, marketMaxQty: 5, stepSize: 1 });
    expect(
      splitOrderQty({ exchangeClient: client, symbol: SYMBOL, fullQty: 10, orderKind: 'market' })
    ).toEqual([5, 5]);
    expect(
      splitOrderQty({ exchangeClient: client, symbol: SYMBOL, fullQty: 10, orderKind: 'limit' })
    ).toEqual([10]);
  });

  test('rebalanceTail grows a sub-minQty tail to minQty at the last piece expense', () => {
    const client = makeClient({ maxQty: 5, stepSize: 1, minQty: 3 });
    const base = { exchangeClient: client, symbol: SYMBOL, fullQty: 12, orderKind: 'limit' as const };
    expect(splitOrderQty(base)).toEqual([5, 5]);
    expect(splitOrderQty({ ...base, rebalanceTail: true })).toEqual([5, 4, 3]);
  });

  test('a float-epsilon remainder is not rebalanced into a dust piece (the SOXLUSDT 0.01 shape)', () => {
    const client = makeClient({ marketMaxQty: 167, stepSize: 0.01, minQty: 0.01 });
    // 192.34 - 167 leaves 25.340000000000003 in doubles; the 4e-15 phantom tail must not become
    // a manufactured [.., 25.33, 0.01] split.
    expect(
      splitOrderQty({ exchangeClient: client, symbol: SYMBOL, fullQty: 192.34, orderKind: 'market', rebalanceTail: true })
    ).toEqual([167, 25.34]);
  });

  test('rebalanceTail falls back to drop-tail when the shrunk last piece would fall below minQty', () => {
    const client = makeClient({ maxQty: 3, stepSize: 1, minQty: 3 });
    // 7 → [3,3], tail 1; rebalance would need last = 7 - 3 - 3 = 1 < minQty → dropped as before
    expect(
      splitOrderQty({ exchangeClient: client, symbol: SYMBOL, fullQty: 7, orderKind: 'limit', rebalanceTail: true })
    ).toEqual([3, 3]);
  });

  test('rebalanceTail leaves a tail at or above minQty untouched', () => {
    const client = makeClient({ maxQty: 5, stepSize: 1, minQty: 2 });
    expect(
      splitOrderQty({ exchangeClient: client, symbol: SYMBOL, fullQty: 12, orderKind: 'limit', rebalanceTail: true })
    ).toEqual([5, 5, 2]);
  });

  test('rebalanceTail with no produced pieces (minQty > cap) stays empty', () => {
    const client = makeClient({ maxQty: 2, stepSize: 1, minQty: 3 });
    expect(
      splitOrderQty({ exchangeClient: client, symbol: SYMBOL, fullQty: 5, orderKind: 'limit', rebalanceTail: true })
    ).toEqual([]);
  });

  test('rebalanceTail keeps the total within fullQty when minQty is not step-aligned', () => {
    // step 2 rounds minQty 3 up to tail 4; last = floor((6 + 1 - 4) / 2) * 2 = 2 < minQty → fallback
    const client = makeClient({ maxQty: 6, stepSize: 2, minQty: 3 });
    expect(
      splitOrderQty({ exchangeClient: client, symbol: SYMBOL, fullQty: 13, orderKind: 'limit', rebalanceTail: true })
    ).toEqual([6, 6]);
  });

  test('rebalanceTail is float-drift safe on fractional steps', () => {
    const client = makeClient({ maxQty: 0.005, stepSize: 0.001, minQty: 0.003 });
    const pieceList = splitOrderQty({
      exchangeClient: client,
      symbol: SYMBOL,
      fullQty: 0.012,
      orderKind: 'limit',
      rebalanceTail: true,
    });
    expect(pieceList).toHaveLength(3);
    expect(pieceList.reduce((sum, piece) => sum + piece, 0)).toBeCloseTo(0.012, 9);
    expect(pieceList[1]).toBeCloseTo(0.004, 9);
    expect(pieceList[2]).toBeCloseTo(0.003, 9);
    expect(pieceList.every((piece) => piece <= 0.005 + 1e-9)).toBe(true);
  });

  test('rebalanceTail does not affect a single-piece split', () => {
    const client = makeClient({ maxQty: 5, stepSize: 1, minQty: 3 });
    expect(
      splitOrderQty({ exchangeClient: client, symbol: SYMBOL, fullQty: 4, orderKind: 'limit', rebalanceTail: true })
    ).toEqual([4]);
  });
});

describe('sizeOrder', () => {
  test('notional → contracts → split', () => {
    const client = makeClient({ maxQty: 5, stepSize: 1 });
    const result = sizeOrder({
      exchangeClient: client,
      symbol: SYMBOL,
      notionalUsd: 1000,
      price: 100,
      orderKind: 'limit',
    });
    expect(result.pieceList).toEqual([5, 5]); // 1000/100 = 10, split by 5
    expect(result.totalContracts).toBe(10);
    expect(result.guardError).toBeUndefined();
  });

  test('unbounded guard when symbol not loaded', () => {
    const client = makeClient({ maxQty: 5, loaded: false });
    const result = sizeOrder({
      exchangeClient: client,
      symbol: SYMBOL,
      notionalUsd: 1000,
      price: 100,
      orderKind: 'market',
      requireLoadedSymbol: true,
    });
    expect(result.pieceList).toEqual([]);
    expect(result.guardError).toContain('refusing to send unbounded market order');
  });

  test('drops single piece below minQty → empty', () => {
    const client = makeClient({ maxQty: 100, stepSize: 1, minQty: 2 });
    const result = sizeOrder({
      exchangeClient: client,
      symbol: SYMBOL,
      notionalUsd: 100,
      price: 100, // → 1 contract, below minQty 2
      orderKind: 'limit',
    });
    expect(result.pieceList).toEqual([]);
    expect(result.totalContracts).toBe(0);
  });

  test('invalid notional/price → empty, no guardError', () => {
    const client = makeClient({ maxQty: 5 });
    expect(
      sizeOrder({ exchangeClient: client, symbol: SYMBOL, notionalUsd: 0, price: 100, orderKind: 'limit' }).pieceList
    ).toEqual([]);
    expect(
      sizeOrder({ exchangeClient: client, symbol: SYMBOL, notionalUsd: 100, price: 0, orderKind: 'limit' }).pieceList
    ).toEqual([]);
  });

  test('minNotional enforced only when opted in', () => {
    const client = makeClient({ maxQty: 100, stepSize: 1, minNotional: 600 });
    const base = {
      exchangeClient: client,
      symbol: SYMBOL,
      notionalUsd: 500,
      price: 100, // → 5 contracts, notional 500 < 600
      orderKind: 'limit' as const,
    };
    expect(sizeOrder(base).pieceList).toEqual([5]);
    expect(sizeOrder({ ...base, enforceMinNotional: true }).pieceList).toEqual([]);
  });
});

describe('sizeLegList', () => {
  test('sizes each leg to a part, sums contracts', () => {
    const client = makeClient({ maxQty: 100, stepSize: 1 });
    const result = sizeLegList({
      exchangeClient: client,
      symbol: SYMBOL,
      legList: [
        { notionalUsd: 500, price: 100 }, // → 5
        { notionalUsd: 300, price: 100 }, // → 3
      ],
    });
    expect(result.partList).toEqual([
      { amount: 5, price: 100 },
      { amount: 3, price: 100 },
    ]);
    expect(result.totalContracts).toBe(8);
    expect(result.droppedCount).toBe(0);
  });

  test('drops a leg below minQty', () => {
    const client = makeClient({ maxQty: 100, stepSize: 1, minQty: 4 });
    const result = sizeLegList({
      exchangeClient: client,
      symbol: SYMBOL,
      legList: [
        { notionalUsd: 500, price: 100 }, // → 5 (kept)
        { notionalUsd: 300, price: 100 }, // → 3 (< 4, dropped)
      ],
    });
    expect(result.partList).toEqual([{ amount: 5, price: 100 }]);
    expect(result.droppedCount).toBe(1);
  });

  test('double-volume leg yields ~2x contracts at equal price', () => {
    const client = makeClient({ maxQty: 100, stepSize: 1 });
    const result = sizeLegList({
      exchangeClient: client,
      symbol: SYMBOL,
      legList: [
        { notionalUsd: 100, price: 100 }, // → 1
        { notionalUsd: 200, price: 100 }, // → 2 (the ×2 last level)
      ],
    });
    expect(result.partList).toEqual([
      { amount: 1, price: 100 },
      { amount: 2, price: 100 },
    ]);
  });
});
