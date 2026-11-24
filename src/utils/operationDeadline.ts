import type { DeadlineExceededErrorArgs, OperationDeadlineArgs } from './operationDeadline.types';

/**
 * The operation's own time limit ran out before it finished. The outcome is UNKNOWN: a request may
 * already have reached the exchange and been applied there, or not. The caller treats the change as
 * neither done nor refused and asks the exchange again before relying on it.
 */
class DeadlineExceededError extends Error {
  readonly operationLabel: string;
  readonly timeoutMs: number;

  constructor(args: DeadlineExceededErrorArgs) {
    super(`${args.operationLabel}: deadline of ${args.timeoutMs}ms exceeded, outcome unknown`);
    this.name = 'DeadlineExceededError';
    this.operationLabel = args.operationLabel;
    this.timeoutMs = args.timeoutMs;
  }
}

/**
 * One time limit shared by every step of an operation. `race` cuts a step at the limit, so whatever
 * waits on it moves on; `signal` reaches the transport, so a request still in flight is aborted
 * instead of holding its socket after nobody waits for the answer.
 */
class OperationDeadline {
  private readonly controller = new AbortController();
  private readonly expiry: Promise<never>;
  private readonly timer: NodeJS.Timeout;

  constructor(args: OperationDeadlineArgs) {
    if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 0) {
      throw new Error(`${args.operationLabel}: timeoutMs must be a non-negative finite number, got ${args.timeoutMs}`);
    }

    const error = new DeadlineExceededError(args);
    let rejectExpiry: (reason: DeadlineExceededError) => void = () => undefined;

    this.expiry = new Promise<never>((_resolve, reject) => {
      rejectExpiry = reject;
    });
    // Nothing may be racing at the moment the limit fires; that must not surface as an unhandled rejection.
    this.expiry.catch(() => undefined);
    this.timer = setTimeout(() => {
      this.controller.abort(error);
      rejectExpiry(error);
    }, args.timeoutMs);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isExpired(): boolean {
    return this.controller.signal.aborted;
  }

  throwIfExpired(): void {
    this.controller.signal.throwIfAborted();
  }

  race<T>(promise: Promise<T>): Promise<T> {
    // The cut step may still settle later; its late outcome is dropped, never reported as unhandled.
    promise.catch(() => undefined);

    return Promise.race([promise, this.expiry]);
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}

export { DeadlineExceededError, OperationDeadline };
