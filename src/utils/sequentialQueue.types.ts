export interface SequentialQueueLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface SequentialQueueArgs {
  /** Queue name for the log lines. */
  label: string;
  /** Defaults to the library logger. */
  logger?: SequentialQueueLogger;
  /** Awaited before EVERY task — the yield hook. A delivery queue hands in "wait until no hot entry is
   *  running", so a CPU-heavy task (a chart render) never starts while orders are being placed. Errors
   *  in the hook are logged and the task still runs — a broken hook must not stall the queue forever. */
  beforeTask?: () => Promise<void>;
  /** Tasks slower than this are logged with their duration (default 500ms) — the measurement that tells
   *  which deliveries are actually expensive instead of guessing. */
  slowTaskLogMs?: number;
}

export interface SequentialQueue {
  /** Fire-and-forget: the task joins the tail and the caller returns immediately. Order of enqueue =
   *  order of execution, so chat messages keep their sequence. Task errors are logged, never thrown —
   *  one failed delivery must not kill the queue. */
  enqueue: (taskLabel: string, task: () => Promise<void>) => void;
  /** Resolves when everything enqueued SO FAR has finished — the shutdown hook. */
  drain: () => Promise<void>;
  size: () => number;
}
