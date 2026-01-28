/**
 * Interrupt callbacks passed to flow execution.
 * Subset of InterruptManager used by BaseFlowContextInit.
 */
export interface InterruptCallbacks {
  /** Check if interruption has been requested. */
  checkInterruption: () => boolean;
  /** Set the current abort controller for cancellation. */
  setAbortController: (controller: AbortController | null) => void;
  /** Request interruption - called when user stops the agent. */
  onInterrupt: () => void;
}

/**
 * Create interrupt callbacks for a single flow execution.
 *
 * Returns callbacks directly - spread into flow inputs with `...createInterruptCallbacks()`.
 */
export function createInterruptCallbacks(): InterruptCallbacks {
  let isInterrupted = false;
  let abortController: AbortController | null = null;

  return {
    checkInterruption: () => isInterrupted,
    setAbortController: (controller) => {
      abortController = controller;
    },
    onInterrupt: () => {
      if (isInterrupted) return;
      isInterrupted = true;
      abortController?.abort();
    },
  };
}
