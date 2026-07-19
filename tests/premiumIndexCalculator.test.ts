import { PremiumIndexCalculator } from '../src/services/premiumIndexCalculator';

describe('PremiumIndexCalculator', () => {
  test('returns undefined for an unknown symbol', () => {
    const calculator = new PremiumIndexCalculator();

    expect(calculator.getPremiumAvg('AAAUSDT')).toBeUndefined();
  });

  test('initialises EMA with the very first delta', () => {
    const calculator = new PremiumIndexCalculator();

    calculator.feed({
      symbol: 'AAAUSDT',
      bidPrice: 99,
      askPrice: 101,
      markPrice: 95,
      timestamp: 1000,
    });

    expect(calculator.getPremiumAvg('AAAUSDT')).toBeCloseTo(5, 10);
  });

  test('converges to a constant delta with repeated updates', () => {
    const calculator = new PremiumIndexCalculator();
    let timestamp = 1000;

    for (let step = 0; step < 200; step += 1) {
      timestamp += 100;
      calculator.feed({
        symbol: 'AAAUSDT',
        bidPrice: 100,
        askPrice: 100,
        markPrice: 90,
        timestamp,
      });
    }

    expect(calculator.getPremiumAvg('AAAUSDT')).toBeCloseTo(10, 6);
  });

  test('moves slowly when the time step is small relative to the 30s window', () => {
    const calculator = new PremiumIndexCalculator();

    calculator.feed({
      symbol: 'AAAUSDT',
      bidPrice: 99,
      askPrice: 101,
      markPrice: 100,
      timestamp: 1000,
    });
    expect(calculator.getPremiumAvg('AAAUSDT')).toBeCloseTo(0, 10);

    calculator.feed({
      symbol: 'AAAUSDT',
      bidPrice: 105,
      askPrice: 115,
      markPrice: 100,
      timestamp: 1100,
    });

    const ema = calculator.getPremiumAvg('AAAUSDT')!;
    expect(ema).toBeGreaterThan(0);
    expect(ema).toBeLessThan(0.1);
  });

  test('reaches roughly (1 - 1/e) of the step after one full window (30 seconds)', () => {
    const calculator = new PremiumIndexCalculator();

    calculator.feed({
      symbol: 'AAAUSDT',
      bidPrice: 100,
      askPrice: 100,
      markPrice: 100,
      timestamp: 0,
    });

    calculator.feed({
      symbol: 'AAAUSDT',
      bidPrice: 100,
      askPrice: 100,
      markPrice: 90,
      timestamp: 30_000,
    });

    expect(calculator.getPremiumAvg('AAAUSDT')).toBeCloseTo(10 * (1 - Math.exp(-1)), 4);
  });

  test('isolates state per symbol', () => {
    const calculator = new PremiumIndexCalculator();

    calculator.feed({
      symbol: 'AAAUSDT',
      bidPrice: 100,
      askPrice: 100,
      markPrice: 90,
      timestamp: 1000,
    });
    calculator.feed({
      symbol: 'BBBUSDT',
      bidPrice: 50,
      askPrice: 50,
      markPrice: 60,
      timestamp: 1000,
    });

    expect(calculator.getPremiumAvg('AAAUSDT')).toBeCloseTo(10, 10);
    expect(calculator.getPremiumAvg('BBBUSDT')).toBeCloseTo(-10, 10);
  });

  test('ignores feeds with non-positive or non-finite prices', () => {
    const calculator = new PremiumIndexCalculator();

    calculator.feed({
      symbol: 'AAAUSDT',
      bidPrice: 0,
      askPrice: 100,
      markPrice: 90,
      timestamp: 1000,
    });
    calculator.feed({
      symbol: 'AAAUSDT',
      bidPrice: 100,
      askPrice: Number.NaN,
      markPrice: 90,
      timestamp: 1000,
    });
    calculator.feed({
      symbol: 'AAAUSDT',
      bidPrice: 100,
      askPrice: 100,
      markPrice: 0,
      timestamp: 1000,
    });

    expect(calculator.getPremiumAvg('AAAUSDT')).toBeUndefined();
  });

  test('ignores out-of-order timestamps', () => {
    const calculator = new PremiumIndexCalculator();

    calculator.feed({
      symbol: 'AAAUSDT',
      bidPrice: 100,
      askPrice: 100,
      markPrice: 90,
      timestamp: 5000,
    });
    const initialEma = calculator.getPremiumAvg('AAAUSDT');

    calculator.feed({
      symbol: 'AAAUSDT',
      bidPrice: 200,
      askPrice: 200,
      markPrice: 90,
      timestamp: 4000,
    });
    calculator.feed({
      symbol: 'AAAUSDT',
      bidPrice: 200,
      askPrice: 200,
      markPrice: 90,
      timestamp: 5000,
    });

    expect(calculator.getPremiumAvg('AAAUSDT')).toBeCloseTo(initialEma!, 10);
  });

  test('clear() drops all symbol state', () => {
    const calculator = new PremiumIndexCalculator();

    calculator.feed({
      symbol: 'AAAUSDT',
      bidPrice: 100,
      askPrice: 100,
      markPrice: 90,
      timestamp: 1000,
    });
    expect(calculator.getPremiumAvg('AAAUSDT')).toBeDefined();

    calculator.clear();

    expect(calculator.getPremiumAvg('AAAUSDT')).toBeUndefined();
  });
});
