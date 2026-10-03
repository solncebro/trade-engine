import {
  configureAmountStepSnapper,
  formatAmount,
  formatPercent,
  formatUsdAmount,
  roundPercent,
  roundUsdAmount,
  snapAmountToStep,
} from '../src/utils/numberFormat';

const STEP_BY_SYMBOL: Record<string, number> = {
  BTCUSDT: 0.001,
  EPICUSDT: 1,
};

const snapper = (symbol: string, amount: number): number => {
  const step = STEP_BY_SYMBOL[symbol];

  if (step === undefined) {
    return amount;
  }

  return Number((Math.round(amount / step) * step).toFixed(10));
};

afterEach(() => {
  configureAmountStepSnapper(null);
});

describe('snapAmountToStep', () => {
  it('puts an amount on the symbol lot step', () => {
    configureAmountStepSnapper(snapper);

    expect(snapAmountToStep('BTCUSDT', 0.1 + 0.2)).toBeCloseTo(0.3, 9);
    expect(snapAmountToStep('EPICUSDT', 1000 / 0.436)).toBe(2294);
  });

  it('keeps the value when no snapper is configured', () => {
    expect(snapAmountToStep('BTCUSDT', 0.30000000000000004)).toBe(0.30000000000000004);
  });
});

describe('snapAmountToStep rounding direction', () => {
  it('passes the requested rounding to the snapper, nearest by default', () => {
    const calledWith: string[] = [];

    configureAmountStepSnapper((_symbol, amount, rounding) => {
      calledWith.push(rounding);

      return amount;
    });

    snapAmountToStep('BTCUSDT', 1.234);
    snapAmountToStep('BTCUSDT', 1.234, 'up');
    snapAmountToStep('BTCUSDT', 1.234, 'down');

    expect(calledWith).toEqual(['nearest', 'up', 'down']);
  });

  it('returns the input for every mode when nothing is configured', () => {
    expect(snapAmountToStep('BTCUSDT', 1.234, 'up')).toBe(1.234);
    expect(snapAmountToStep('BTCUSDT', 1.234, 'down')).toBe(1.234);
  });
});

describe('formatAmount', () => {
  it('renders a snapped amount with no floating-point tail', () => {
    configureAmountStepSnapper(snapper);

    expect(formatAmount('BTCUSDT', 0.1 + 0.2)).toBe('0.3');
    expect(formatAmount('EPICUSDT', 1000 / 0.436)).toBe('2294');
  });

  it('caps an unsnappable amount instead of printing its whole tail', () => {
    expect(formatAmount('UNKNOWNUSDT', 0.1 + 0.2)).toBe('0.3');
    expect(formatAmount('UNKNOWNUSDT', 1 / 3)).toBe('0.33333333');
  });

  it('renders an absent amount as a dash', () => {
    expect(formatAmount('BTCUSDT', null)).toBe('—');
    expect(formatAmount('BTCUSDT', Number.NaN)).toBe('—');
  });
});

describe('formatUsdAmount', () => {
  it('shows at most cents and drops the tail', () => {
    expect(formatUsdAmount(1250 - 333.3333333333333)).toBe('916.67');
    expect(formatUsdAmount(0.1 + 0.2)).toBe('0.3');
    expect(formatUsdAmount(1000)).toBe('1000');
  });

  it('renders an absent sum as a dash', () => {
    expect(formatUsdAmount(undefined)).toBe('—');
  });
});

describe('formatPercent', () => {
  it('drops the tail of a computed ratio', () => {
    expect(formatPercent((0.443208 / 0.436 - 1) * 100)).toBe('1.65');
    expect(formatPercent(0.1 + 0.2, 1)).toBe('0.3');
    expect(formatPercent(5)).toBe('5');
  });
});

describe('round helpers for structured logs', () => {
  it('round to cents and to percent digits', () => {
    expect(roundUsdAmount(916.6666666666666)).toBe(916.67);
    expect(roundPercent(1.6533333333333333)).toBe(1.65);
    expect(roundPercent(1.6533333333333333, 3)).toBe(1.653);
  });
});
