import type { BaseFlowContextInit } from '@agent/implementations/flows/common/BaseFlowServices';

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
