export interface RateLimitedRequestQueueArgs {
  rateLimit: number;
  intervalMs?: number;
  loggerLabel?: string;
}
