import { describeError } from './errorFormatter.utils';
import type {
  CreateGracefulShutdownHandlerArgs,
  GracefulShutdownHandler,
  GracefulShutdownStep,
  InstallProcessErrorGuardsArgs,
  ProcessErrorKind,
} from './gracefulShutdown.types';
import { withTimeout } from './timeout';

import { logger } from '../core/logger';

const DEFAULT_SIGNAL_LIST: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
const DEFAULT_EXIT_CODE = 0;
const DEFAULT_FORCED_EXIT_CODE = 1;

async function runStep(step: GracefulShutdownStep, log: (message: string) => void): Promise<void> {
  try {
    const result = Promise.resolve().then(() => step.run());

    await (step.timeoutMs === undefined
      ? result
      : withTimeout(result, step.timeoutMs, `step "${step.label}" exceeded ${step.timeoutMs}ms — moving on`));
  } catch (error: unknown) {
    log(`[Shutdown] ${step.label} failed: ${describeError(error)}`);
  }
}

/**
 * Ordered, capped teardown. Merges kliner's handler (stop, then always exit — even when stopping threw)
 * with rubber's shutdown: a re-entry guard (a second signal must not run the teardown twice), a time cap
 * per step, and a forced-exit ceiling for a teardown that hangs as a whole.
 */
export function createGracefulShutdownHandler(args: CreateGracefulShutdownHandlerArgs): GracefulShutdownHandler {
  const exit = args.exit ?? ((code: number): void => {
    process.exit(code);
  });
  const log = args.log ?? ((message: string): void => {
    logger.info(message);
  });
  let runningShutdown: Promise<void> | null = null;

  const shutdown = async (reason: string): Promise<void> => {
    log(`[Shutdown] received ${reason}, shutting down`);

    let forcedExitTimer: NodeJS.Timeout | null = null;
    let isForcedExitDone = false;

    if (args.forcedExitTimeoutMs !== undefined) {
      forcedExitTimer = setTimeout(() => {
        log(`[Shutdown] teardown exceeded ${args.forcedExitTimeoutMs}ms — forcing exit`);
        isForcedExitDone = true;
        exit(args.forcedExitCode ?? DEFAULT_FORCED_EXIT_CODE);
      }, args.forcedExitTimeoutMs);
      forcedExitTimer.unref();
    }

    for (const step of args.stepList) {
      await runStep(step, log);
    }

    if (forcedExitTimer !== null) {
      clearTimeout(forcedExitTimer);
    }

    if (isForcedExitDone) {
      return;
    }

    exit(args.exitCode ?? DEFAULT_EXIT_CODE);
  };

  return (reason: string): Promise<void> => {
    if (runningShutdown === null) {
      runningShutdown = shutdown(reason);
    } else {
      log(`[Shutdown] ${reason} ignored — shutdown already in progress`);
    }

    return runningShutdown;
  };
}

/** Route SIGINT/SIGTERM (or the given list) to the handler, each at most once. Returns an unregister. */
export function registerShutdownSignals(handler: GracefulShutdownHandler, signalList: readonly NodeJS.Signals[] = DEFAULT_SIGNAL_LIST): () => void {
  const listenerBySignal = new Map<NodeJS.Signals, () => void>();

  for (const signal of signalList) {
    const listener = (): void => {
      void handler(signal);
    };

    listenerBySignal.set(signal, listener);
    process.once(signal, listener);
  }

  return () => {
    for (const [signal, listener] of listenerBySignal) {
      process.removeListener(signal, listener);
    }
  };
}

/** Keep a long-running bot alive on a stray rejection or exception: log it and carry on (rubber's
 *  guard). Returns an uninstall function. */
export function installProcessErrorGuards(args: InstallProcessErrorGuardsArgs = {}): () => void {
  const onError = args.onError ?? ((kind: ProcessErrorKind, error: unknown): void => {
    logger.error({ error }, `[Process] ${kind} — process stays alive`);
  });
  const rejectionListener = (reason: unknown): void => {
    onError('unhandledRejection', reason);
  };
  const exceptionListener = (error: Error): void => {
    onError('uncaughtException', error);
  };

  process.on('unhandledRejection', rejectionListener);
  process.on('uncaughtException', exceptionListener);

  return () => {
    process.removeListener('unhandledRejection', rejectionListener);
    process.removeListener('uncaughtException', exceptionListener);
  };
}
