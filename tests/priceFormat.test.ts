import {
  configurePriceTickSizeReader,
  configurePriceTickSnapper,
  formatPrice,
  readPriceTickSize,
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
    expect(snapPriceToTick('PROMUSDT', 2.961579786096256)).toBe(2.961579786096256);
  });
});

describe('snapPriceToTick rounding direction', () => {
  it('passes the requested rounding to the snapper', () => {
    const calledWith: string[] = [];

    configurePriceTickSnapper((_symbol, price, rounding) => {
      calledWith.push(rounding);

      return price;
    });

    snapPriceToTick('PROMUSDT', 2.96151);
    snapPriceToTick('PROMUSDT', 2.96151, 'up');
    snapPriceToTick('PROMUSDT', 2.96151, 'down');

    expect(calledWith).toEqual(['nearest', 'up', 'down']);
  });

  it('formatPrice always snaps to the nearest tick', () => {
    const calledWith: string[] = [];

    configurePriceTickSnapper((_symbol, price, rounding) => {
      calledWith.push(rounding);

      return price;
    });

    formatPrice('PROMUSDT', 2.96151);

    expect(calledWith).toEqual(['nearest']);
  });

  it('returns the input for every mode when nothing is configured', () => {
    expect(snapPriceToTick('PROMUSDT', 2.96151, 'up')).toBe(2.96151);
    expect(snapPriceToTick('PROMUSDT', 2.96151, 'down')).toBe(2.96151);
    expect(snapPriceToTick('PROMUSDT', 2.96151, 'nearest')).toBe(2.96151);
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

  it('prints a sub-micro price as a plain decimal, never in exponent notation', () => {
    expect(formatPrice('UNKNOWNUSDT', 3.4e-7)).toBe('0.00000034');
    expect(formatPrice('UNKNOWNUSDT', 1e-8)).toBe('0.00000001');
    expect(formatPrice('UNKNOWNUSDT', 0.00000034)).toBe('0.00000034');
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

describe('readPriceTickSize', () => {
  const readTickSize = (symbol: string): number | null => TICK_BY_SYMBOL[symbol] ?? null;

  it('returns null when nothing is installed', () => {
    expect(readPriceTickSize('PROMUSDT')).toBeNull();
  });

  it('returns null when a reader is set but no snapper is installed', () => {
    configurePriceTickSizeReader(readTickSize);

    expect(readPriceTickSize('PROMUSDT')).toBeNull();
  });

  it('returns the tick of a known symbol and null for an unknown one', () => {
    configurePriceTickSnapper(snapper);
    configurePriceTickSizeReader(readTickSize);

    expect(readPriceTickSize('PROMUSDT')).toBe(0.0001);
    expect(readPriceTickSize('NOPEUSDT')).toBeNull();
  });

  it('installing or clearing the snapper clears the reader', () => {
    configurePriceTickSnapper(snapper);
    configurePriceTickSizeReader(readTickSize);
    configurePriceTickSnapper(snapper);

    expect(readPriceTickSize('PROMUSDT')).toBeNull();

    configurePriceTickSizeReader(readTickSize);
    configurePriceTickSnapper(null);

    expect(readPriceTickSize('PROMUSDT')).toBeNull();
  });

  it('treats a non-positive, non-finite or throwing reading as unknown', () => {
    configurePriceTickSnapper(snapper);

    configurePriceTickSizeReader(() => 0);
    expect(readPriceTickSize('PROMUSDT')).toBeNull();

    configurePriceTickSizeReader(() => Number.NaN);
    expect(readPriceTickSize('PROMUSDT')).toBeNull();

    configurePriceTickSizeReader(() => {
      throw new Error('boom');
    });
    expect(readPriceTickSize('PROMUSDT')).toBeNull();
  });
});
