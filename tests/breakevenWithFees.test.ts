import { computeBreakevenWithFees } from '../src/utils/breakevenLadder';

// Cases ported from volume-breaker src/__tests__/unit/fibLevels.test.ts:586-620.
describe('computeBreakevenWithFees — long', () => {
  it('lifts breakeven above entry by both fees (P = entry × (1+f)/(1-f))', () => {
    // 0.02 % fee → f = 0.0002 → breakeven ≈ 100 × 1.0002 / 0.9998
    expect(computeBreakevenWithFees(100, 0.02, 'long')).toBeCloseTo((100 * 1.0002) / 0.9998, 9);
  });

  it('returns entry unchanged when fee is zero', () => {
    expect(computeBreakevenWithFees(100, 0, 'long')).toBe(100);
  });

  it('returns entry unchanged for invalid / out-of-range fee', () => {
    expect(computeBreakevenWithFees(100, Number.NaN, 'long')).toBe(100);
    expect(computeBreakevenWithFees(100, 100, 'long')).toBe(100);
    expect(computeBreakevenWithFees(100, -0.02, 'long')).toBe(100);
  });

  it('breakeven is strictly above entry for a positive fee', () => {
    expect(computeBreakevenWithFees(2500, 0.055, 'long')).toBeGreaterThan(2500);
  });
});

describe('computeBreakevenWithFees — short (mirror)', () => {
  it('lowers breakeven below entry by both fees (P = entry × (1-f)/(1+f))', () => {
    expect(computeBreakevenWithFees(100, 0.02, 'short')).toBeCloseTo((100 * 0.9998) / 1.0002, 9);
  });

  it('breakeven is strictly below entry for a positive fee', () => {
    expect(computeBreakevenWithFees(2500, 0.055, 'short')).toBeLessThan(2500);
  });

  it('returns entry unchanged when fee is zero', () => {
    expect(computeBreakevenWithFees(100, 0, 'short')).toBe(100);
  });
});
