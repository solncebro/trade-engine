import {
  configurePriceTickSnapper,
  formatPrice,
  isPriceTickSnapperConfigured,
  snapPriceToTick,
} from '../src/utils/priceFormat';

const TICK_BY_SYMBOL: Record<string, number> = {
  PROMUSDT: 0.0001,
  PEPEUSDT: 0.0000001,
};

/** Stand-in for a loaded exchange connector: snaps a known symbol, leaves an unknown one alone. */
const snapper = (symbol: string, price: number): number => {
  const tick = TICK_BY_SYMBOL[symbol];

  if (tick === undefined) {
    return price;
  }

  return Number((Math.round(price / tick) * tick).toFixed(10));
};

afterEach(() => {
  configurePriceTickSnapper(null);
});

describe('snapPriceToTick', () => {
  it('puts a price on the symbol tick grid', () => {
    configurePriceTickSnapper(snapper);

    expect(snapPriceToTick('PROMUSDT', 2.961579786096256)).toBeCloseTo(2.9616, 9);
  });

  it('keeps the value when no snapper is configured', () => {
    expect(isPriceTickSnapperConfigured()).toBe(false);
    expect(snapPriceToTick('PROMUSDT', 2.961579786096256)).toBe(2.961579786096256);
  });
});

describe('formatPrice', () => {
  it('renders a snapped price with no floating-point tail', () => {
    configurePriceTickSnapper(snapper);

    expect(formatPrice('PROMUSDT', 2.961579786096256)).toBe('2.9616');
    expect(formatPrice('PROMUSDT', 2.9048999999999996)).toBe('2.9049');
  });

  it('keeps the precision of a sub-cent coin', () => {
    configurePriceTickSnapper(snapper);

    expect(formatPrice('PEPEUSDT', 0.0000123456789)).toBe('0.0000123');
  });

  it('caps an unsnappable price instead of printing its whole tail', () => {
    configurePriceTickSnapper(snapper);

    expect(formatPrice('UNKNOWNUSDT', 2.575286770518484)).toBe('2.57528677');
  });

  it('renders an absent price as a dash', () => {
    expect(formatPrice('PROMUSDT', null)).toBe('—');
    expect(formatPrice('PROMUSDT', undefined)).toBe('—');
    expect(formatPrice('PROMUSDT', Number.NaN)).toBe('—');
  });

  it('survives a snapper that throws', () => {
    configurePriceTickSnapper(() => {
      throw new Error('filters not loaded');
    });

    expect(formatPrice('PROMUSDT', 2.9615797)).toBe('2.9615797');
  });
});
