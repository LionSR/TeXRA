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
 * Interrupt state manager for flow execution.
 *
 * Encapsulates interrupt state with type-safe access and abort controller management.
 */
export interface InterruptManager extends InterruptCallbacks {
  /** Get the current abort controller. */
  getAbortController: () => AbortController | null;
  /** Get interrupt-related fields for flow input. */
  asFlowInput: () => InterruptCallbacks;
}

/**
 * Create an interrupt manager for a single flow execution.
 */
export function createInterruptManager(): InterruptManager {
  let isInterrupted = false;
  let abortController: AbortController | null = null;

  const checkInterruption = (): boolean => isInterrupted;

  const setAbortController = (controller: AbortController | null): void => {
    abortController = controller;
  };

  const onInterrupt = (): void => {
    if (isInterrupted) return;
    isInterrupted = true;
    abortController?.abort();
  };

  const getAbortController = (): AbortController | null => abortController;

  // Cache flow input since callbacks are stable references
  const flowInput: InterruptCallbacks = {
    checkInterruption,
    setAbortController,
    onInterrupt,
  };

  return {
    checkInterruption,
    setAbortController,
    onInterrupt,
    getAbortController,
    asFlowInput: () => flowInput,
  };
}
