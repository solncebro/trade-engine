import { logger } from './logger';
import type {
  WithReadRetryArgs,
  WithRetryOn429Args,
} from './withRetryOn429.types';

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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

interface ExecuteWithRetryArgs<T> {
  fn: () => Promise<T>;
  contextLabel: string;
  maxRetries: number;
  baseDelayMs: number;
}

async function executeWithRetry<T>(args: ExecuteWithRetryArgs<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= args.maxRetries; attempt += 1) {
    try {
      return await args.fn();
    } catch (error) {
      lastError = error;
      const status = extractStatus(error);

      if (!isRetryableStatus(status)) {
        throw error;
      }

      if (attempt === args.maxRetries) {
        logger.warn(
          { error, contextLabel: args.contextLabel, attempt, maxRetries: args.maxRetries, status },
          `[Retry] ${args.contextLabel} exhausted ${args.maxRetries} retries on status=${status}`
        );
        throw error;
      }

      const retryAfterMs = extractRetryAfterMs(error);
      const backoffMs = retryAfterMs ?? args.baseDelayMs * Math.pow(2, attempt - 1);

      logger.info(
        { contextLabel: args.contextLabel, attempt, maxRetries: args.maxRetries, status, backoffMs },
        `[Retry] ${args.contextLabel} attempt ${attempt}/${args.maxRetries} after ${backoffMs}ms (status=${status})`
      );

      await sleep(backoffMs);
    }
  }

  throw lastError;
}

export async function withRetryOn429<T>(args: WithRetryOn429Args<T>): Promise<T> {
  return executeWithRetry({
    fn: args.fn,
    contextLabel: args.contextLabel,
    maxRetries: args.maxRetries ?? DEFAULT_MAX_RETRIES,
    baseDelayMs: args.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
  });
}

export async function withReadRetry<T>(args: WithReadRetryArgs<T>): Promise<T> {
  return executeWithRetry({
    fn: args.fn,
    contextLabel: args.contextLabel,
    maxRetries: args.maxRetries ?? DEFAULT_MAX_RETRIES,
    baseDelayMs: args.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
  });
}
