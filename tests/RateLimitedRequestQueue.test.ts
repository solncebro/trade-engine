import { RateLimitedRequestQueue } from '../src/core/RateLimitedRequestQueue';

jest.mock('../src/core/logger', () => ({
  logger: {
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
  },
}));

describe('RateLimitedRequestQueue', () => {
  it('constructor throws on non-positive rateLimit', () => {
    expect(() => new RateLimitedRequestQueue({ rateLimit: 0 })).toThrow();
    expect(() => new RateLimitedRequestQueue({ rateLimit: -5 })).toThrow();
    expect(() => new RateLimitedRequestQueue({ rateLimit: NaN })).toThrow();
  });

  it('floors fractional rateLimit', () => {
    const queue = new RateLimitedRequestQueue({ rateLimit: 5.7 });
    expect(queue.getRateLimit()).toBe(5);
  });

  it('uses default intervalMs=1000 when not provided', () => {
    const queue = new RateLimitedRequestQueue({ rateLimit: 5 });
    expect(queue.getIntervalMs()).toBe(1000);
  });

  it('executes fn and returns its result', async () => {
    const queue = new RateLimitedRequestQueue({ rateLimit: 5 });
    const result = await queue.execute(async () => 42);
    expect(result).toBe(42);
  });

  it('propagates rejection from fn without breaking the chain', async () => {
    const queue = new RateLimitedRequestQueue({ rateLimit: 5 });
    await expect(queue.execute(async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    await expect(queue.execute(async () => 'ok')).resolves.toBe('ok');
  });

  it('throttles fire 50 parallel execute() at rateLimit=15 to <= 15 per 1s window', async () => {
    const queue = new RateLimitedRequestQueue({ rateLimit: 15, intervalMs: 1000 });
    const executionTimestampList: number[] = [];

    const promiseList = Array.from({ length: 50 }, () =>
      queue.execute(async () => {
        executionTimestampList.push(Date.now());
        return null;
      })
    );

    await Promise.all(promiseList);

    expect(executionTimestampList.length).toBe(50);

    const windowMs = 1000;
    for (let i = 0; i + 15 < executionTimestampList.length; i += 1) {
      const windowSpan = executionTimestampList[i + 15] - executionTimestampList[i];
      expect(windowSpan).toBeGreaterThanOrEqual(windowMs - 50);
    }
  }, 10_000);

  it('does not throttle below rate limit', async () => {
    const queue = new RateLimitedRequestQueue({ rateLimit: 100, intervalMs: 1000 });
    const start = Date.now();
    const promiseList = Array.from({ length: 5 }, () => queue.execute(async () => null));
    await Promise.all(promiseList);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(200);
  });
});
