export interface GracefulShutdownStep {
  /** Name for the log line. */
  label: string;
  run: () => void | Promise<void>;
  /** Cap for this step. Past it the teardown moves on (the step keeps running in the background and
   *  dies with the process) — a hung write must never hold the shutdown hostage. Omitted: no cap. */
  timeoutMs?: number;
}

export interface CreateGracefulShutdownHandlerArgs {
  /** Run strictly in this order; a failing or timed-out step is logged and the next one still runs. */
  stepList: GracefulShutdownStep[];
  /** Defaults to `process.exit`. */
  exit?: (code: number) => void;
  /** Defaults to the library logger. */
  log?: (message: string) => void;
  /** Exit code after the steps. Default 0 — PM2 brings the process back on any exit. */
  exitCode?: number;
  /** Hard ceiling for the whole teardown: past it the process exits with `forcedExitCode` whatever the
   *  steps are doing. Omitted: no ceiling beyond the per-step caps. */
  forcedExitTimeoutMs?: number;
  /** Default 1 — tells a forced exit apart from a clean one in the process manager's log. */
  forcedExitCode?: number;
}

/** Call with the reason (a signal name or "the operator's Restart button"). A second call while the
 *  first is running returns the same promise — steps never run twice. */
export type GracefulShutdownHandler = (reason: string) => Promise<void>;

export interface InstallProcessErrorGuardsArgs {
  /** Defaults to logging through the library logger; the process stays alive either way. */
  onError?: (kind: ProcessErrorKind, error: unknown) => void;
}

export type ProcessErrorKind = 'unhandledRejection' | 'uncaughtException';
