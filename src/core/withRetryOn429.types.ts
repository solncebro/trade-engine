export interface WithRetryOn429Args<T> {
  fn: () => Promise<T>;
  contextLabel: string;
  maxRetries?: number;
  baseDelayMs?: number;
}

export interface WithReadRetryArgs<T> {
  fn: () => Promise<T>;
  contextLabel: string;
  maxRetries?: number;
  baseDelayMs?: number;
}

export interface WithResultRetryArgs<T> {
  fn: () => Promise<T>;
  contextLabel: string;
  maxRetries?: number;
  baseDelayMs?: number;
}
