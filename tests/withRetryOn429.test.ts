import { withRetryOn429 } from '../src/core/withRetryOn429';

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

  describe('with a signal', () => {
    beforeEach(() => {
      jest.useFakeTimers({ now: 1000 });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('makes no attempt once the signal already fired', async () => {
      const controller = new AbortController();
      const reason = new Error('deadline');
      controller.abort(reason);
      const fn = jest.fn().mockResolvedValue('ok');

      await expect(withRetryOn429({ fn, contextLabel: 'test-aborted', signal: controller.signal })).rejects.toBe(reason);
      expect(fn).not.toHaveBeenCalled();
    });

    it('ends a Retry-After pause when the signal fires and starts no further attempt', async () => {
      const controller = new AbortController();
      const reason = new Error('deadline');
      const fn = jest.fn().mockRejectedValue(makeAxiosError(429, { 'retry-after': '60' }));
      let settledAtMs: number | null = null;
      const outcome = withRetryOn429({ fn, contextLabel: 'test-pause', signal: controller.signal })
        .catch((error: unknown) => error)
        .finally(() => { settledAtMs = Date.now(); });

      await jest.advanceTimersByTimeAsync(5000);
      controller.abort(reason);

      expect(await outcome).toBe(reason);
      expect(settledAtMs).toBe(6000);
      await jest.advanceTimersByTimeAsync(300_000);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('does not retry an attempt that failed after the signal fired', async () => {
      const controller = new AbortController();
      const reason = new Error('deadline');
      const fn = jest.fn().mockImplementationOnce(async () => {
        controller.abort(reason);
        throw makeAxiosError(503);
      });

      await expect(withRetryOn429({ fn, contextLabel: 'test-late-failure', signal: controller.signal })).rejects.toBe(reason);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries exactly as without a signal while it has not fired', async () => {
      const controller = new AbortController();
      const fn = jest.fn().mockRejectedValueOnce(makeAxiosError(500)).mockResolvedValueOnce('ok');
      const outcome = withRetryOn429({ fn, contextLabel: 'test-live-signal', baseDelayMs: 50, signal: controller.signal });

      await jest.advanceTimersByTimeAsync(50);

      expect(await outcome).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });
});
