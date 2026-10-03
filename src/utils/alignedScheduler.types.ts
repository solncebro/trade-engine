export interface AlignedSchedulerHandle {
  stop: () => void;
}

export interface AlignedSchedulerArgs {
  tickHandler: () => void | Promise<void>;
  /** Length of the repeating window, e.g. half an hour. */
  periodMs: number;
  /** How long BEFORE the end of each window the tick fires. NEGATIVE means after it: a period report
   *  lets midnight pass by a minute before it starts reading. */
  leadMs: number;
  /** Defaults to logging through the library logger under `contextLabel`. */
  errorHandler?: (error: unknown) => void;
  contextLabel?: string;
}

export interface NextAlignedTickArgs {
  nowMs: number;
  periodMs: number;
  leadMs: number;
  /** A mark closer than this counts as already served — see REARM_GUARD_MS. Default 0: none is. */
  guardMs?: number;
}
