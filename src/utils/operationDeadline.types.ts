export interface OperationDeadlineArgs {
  /** Whole-operation budget, counted from construction: queue waits, attempts and pauses included. */
  timeoutMs: number;
  /** Names the operation in the error and the log line, e.g. `setLeverage BTCUSDT leverage=5`. */
  operationLabel: string;
}

export interface DeadlineExceededErrorArgs {
  operationLabel: string;
  timeoutMs: number;
}
