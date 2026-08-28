import { logger } from './logger';
import type {
  WithResultRetryArgs,
  WithRetryOn429Args,
} from './withRetryOn429.types';

import { sleep } from '../utils/sleep';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;

interface AxiosLikeError {
  response?: {
    status?: number;
    headers?: Record<string, unknown>;
    data?: unknown;
  };
  message?: string;
  isAxiosError?: boolean;
}

function extractStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const axiosLike = error as AxiosLikeError;
  const status = axiosLike.response?.status;
  if (typeof status === 'number') {
    return status;
  }
  return null;
}

function extractRetryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const headers = (error as AxiosLikeError).response?.headers;
  if (!headers || typeof headers !== 'object') {
    return null;
  }
  const rawValue =
    (headers as Record<string, unknown>)['retry-after'] ??
    (headers as Record<string, unknown>)['Retry-After'];
  if (rawValue === undefined || rawValue === null) {
    return null;
  }
  const stringValue = String(rawValue).trim();
  const numericSeconds = Number(stringValue);
  if (Number.isFinite(numericSeconds) && numericSeconds >= 0) {
    return Math.round(numericSeconds * 1000);
  }
  const dateValue = Date.parse(stringValue);
  if (!Number.isNaN(dateValue)) {
    const deltaMs = dateValue - Date.now();
    if (deltaMs > 0) {
      return deltaMs;
    }
  }
  return null;
}

function isRetryableStatus(status: number | null): boolean {
  if (status === null) {
    return false;
  }
  return status === 429 || status >= 500;
}

interface RetryPolicy {
  isRetryable: (error: unknown) => boolean;
  computeBackoffMs: (attempt: number, error: unknown) => number;
}

interface ExecuteWithRetryArgs<T> extends RetryPolicy {
  fn: () => Promise<T>;
  contextLabel: string;
  maxRetries: number;
}

interface ResultWithError {
  error: { message: string } | null;
}

// Thrown internally by withResultRetry so the shared throw-based core can drive result-shaped clients
// (Supabase returns `{ error }` instead of throwing). Carries the last result to hand back on exhaustion.
class RetryableResultError extends Error {
  readonly result: unknown;

  constructor(result: unknown, message: string) {
    super(message);
    this.result = result;
  }
}

// Shared backoff-retry core. The caller supplies WHAT counts as retryable and HOW long to wait, so the
// same loop serves the exchange (retry on thrown 429/5xx) and the journal (retry on a returned error).
async function executeWithRetry<T>(args: ExecuteWithRetryArgs<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= args.maxRetries; attempt += 1) {
    try {
      return await args.fn();
    } catch (error) {
      lastError = error;

      if (!args.isRetryable(error)) {
        throw error;
      }

      if (attempt === args.maxRetries) {
        logger.warn(
          { error, contextLabel: args.contextLabel, attempt, maxRetries: args.maxRetries },
          `[Retry] ${args.contextLabel} exhausted ${args.maxRetries} retries`
        );
        throw error;
      }

      const backoffMs = args.computeBackoffMs(attempt, error);

      logger.info(
        { contextLabel: args.contextLabel, attempt, maxRetries: args.maxRetries, backoffMs },
        `[Retry] ${args.contextLabel} attempt ${attempt}/${args.maxRetries} after ${backoffMs}ms`
      );

      await sleep(backoffMs);
    }
  }

  throw lastError;
}

function buildExchangeRetryPolicy(baseDelayMs: number): RetryPolicy {
  return {
    isRetryable: (error) => isRetryableStatus(extractStatus(error)),
    computeBackoffMs: (attempt, error) => extractRetryAfterMs(error) ?? baseDelayMs * Math.pow(2, attempt - 1),
  };
}

export async function withRetryOn429<T>(args: WithRetryOn429Args<T>): Promise<T> {
  return executeWithRetry({
    fn: args.fn,
    contextLabel: args.contextLabel,
    maxRetries: args.maxRetries ?? DEFAULT_MAX_RETRIES,
    ...buildExchangeRetryPolicy(args.baseDelayMs ?? DEFAULT_BASE_DELAY_MS),
  });
}

// Retry a client that RETURNS `{ error }` instead of throwing (Supabase). Retries while `error` is
// non-null; on exhaustion returns the last result (error included) rather than throwing — a journal
// write must never crash its caller. Same backoff core as the exchange retry (linear delay here).
export async function withResultRetry<T extends ResultWithError>(args: WithResultRetryArgs<T>): Promise<T> {
  const baseDelayMs = args.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  try {
    return await executeWithRetry({
      fn: async () => {
        const result = await args.fn();

        if (result.error !== null) {
          throw new RetryableResultError(result, result.error.message);
        }

        return result;
      },
      contextLabel: args.contextLabel,
      maxRetries: args.maxRetries ?? DEFAULT_MAX_RETRIES,
      isRetryable: (error) => error instanceof RetryableResultError,
      computeBackoffMs: (attempt) => baseDelayMs * attempt,
    });
  } catch (error) {
    if (error instanceof RetryableResultError) {
      return error.result as T;
    }

    throw error;
  }
}
