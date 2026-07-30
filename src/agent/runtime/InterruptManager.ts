import type { BaseFlowContextInit } from '@agent/core/flows/BaseFlowServices';

/**
 * Interrupt callbacks passed to flow execution — the subset of
 * `BaseFlowContextInit` that controls cancellation. Derived from that one
 * source of truth rather than re-declared.
 */
type InterruptCallbacks = Pick<
  BaseFlowContextInit,
  'checkInterruption' | 'setAbortController' | 'onInterrupt'
>;

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
    // Nodes null the slot in their `finally`, so an interrupt can land while
    // it is empty. Delivery is therefore level-triggered on both edges: the
    // latch aborts whatever registers next, and `onInterrupt` stays callable
    // so a second press still reaches a controller registered after the first.
    setAbortController: (controller) => {
      abortController = controller;
      if (isInterrupted) controller?.abort();
    },
    onInterrupt: () => {
      isInterrupted = true;
      abortController?.abort();
    },
  };
}
