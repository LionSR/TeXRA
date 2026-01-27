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
export interface InterruptManager {
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

  // Cached callbacks object - stable reference for spreading into flow inputs
  const callbacks: InterruptCallbacks = {
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

  return {
    getAbortController: () => abortController,
    asFlowInput: () => callbacks,
  };
}
