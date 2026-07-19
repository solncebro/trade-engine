import { withReadRetry, withRetryOn429 } from '../src/core/withRetryOn429';

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

function makeAxiosError(status: number, headers?: Record<string, unknown>): Error & { response: { status: number; headers?: Record<string, unknown> } } {
  const error = new Error(`Request failed with status ${status}`) as Error & { response: { status: number; headers?: Record<string, unknown> } };
  error.response = { status, headers };
  return error;
}

describe('withRetryOn429', () => {
  it('returns result on first success without retries', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await withRetryOn429({ fn, contextLabel: 'test' });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 with Retry-After header and succeeds on second attempt', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(makeAxiosError(429, { 'retry-after': '1' }))
      .mockResolvedValueOnce('ok');

    const start = Date.now();
    const result = await withRetryOn429({ fn, contextLabel: 'test-429', maxRetries: 3, baseDelayMs: 50 });
    const elapsed = Date.now() - start;

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(elapsed).toBeGreaterThanOrEqual(950);
  }, 5_000);

  it('retries on 500 with exponential backoff', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(makeAxiosError(500))
      .mockRejectedValueOnce(makeAxiosError(500))
      .mockResolvedValueOnce('ok');

    const start = Date.now();
    const result = await withRetryOn429({ fn, contextLabel: 'test-500', maxRetries: 3, baseDelayMs: 50 });
    const elapsed = Date.now() - start;

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(elapsed).toBeGreaterThanOrEqual(50 + 100 - 20);
  }, 5_000);

  it('honors Retry-After on 5xx (maintenance window), not just 429', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(makeAxiosError(503, { 'retry-after': '1' }))
      .mockResolvedValueOnce('ok');

    const start = Date.now();
    const result = await withRetryOn429({ fn, contextLabel: 'test-503', maxRetries: 3, baseDelayMs: 50 });
    const elapsed = Date.now() - start;

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(elapsed).toBeGreaterThanOrEqual(950);
  }, 5_000);

  it('throws without retry on non-retryable error (status 400)', async () => {
    const fn = jest.fn().mockRejectedValue(makeAxiosError(400));
    await expect(withRetryOn429({ fn, contextLabel: 'test-400' })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws without retry on error without response status', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('network down'));
    await expect(withRetryOn429({ fn, contextLabel: 'test-network' })).rejects.toThrow('network down');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('exhausts maxRetries and throws last error', async () => {
    const fn = jest.fn().mockRejectedValue(makeAxiosError(503));
    await expect(
      withRetryOn429({ fn, contextLabel: 'test-exhaust', maxRetries: 2, baseDelayMs: 20 })
    ).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(2);
  }, 5_000);
});

describe('withReadRetry', () => {
  it('retries 429 the same way as withRetryOn429', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(makeAxiosError(429, { 'retry-after': '0' }))
      .mockResolvedValueOnce('ok');

    const result = await withReadRetry({ fn, contextLabel: 'read-test', maxRetries: 3, baseDelayMs: 20 });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws on non-retryable status (400)', async () => {
    const fn = jest.fn().mockRejectedValue(makeAxiosError(400));
    await expect(withReadRetry({ fn, contextLabel: 'read-400' })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
