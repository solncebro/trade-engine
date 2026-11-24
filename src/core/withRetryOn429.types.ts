export interface WithRetryOn429Args<T> {
  fn: () => Promise<T>;
  contextLabel: string;
  maxRetries?: number;
  baseDelayMs?: number;
  /** Once it fires, no attempt and no pause starts and a running pause ends: the loop throws `signal.reason`. */
  signal?: AbortSignal;
}

export interface WithResultRetryArgs<T> {
  fn: () => Promise<T>;
  contextLabel: string;
  maxRetries?: number;
  baseDelayMs?: number;
}
