import type { BaseFlowContextInit } from '@agent/core/flows/BaseFlowServices';

/**
 * Interrupt callbacks passed to flow execution — the subset of
 * `BaseFlowContextInit` that controls cancellation. Derived from that one
 * source of truth rather than re-declared.
 */
type InterruptCallbacks = Pick<
  BaseFlowContextInit,
  'checkInterruption' | 'abortSignal' | 'onInterrupt'
>;

/**
 * Create the interrupt controller for a single flow execution.
 *
 * One controller owns cancellation for the whole run: nodes read its signal
 * instead of registering controllers of their own, so an interrupt is
 * delivered once and stays delivered. There is no empty slot to miss and no
 * later registration to stomp.
 *
 * Returns callbacks directly - spread into flow inputs with `...createInterruptCallbacks()`.
 */
export function createInterruptCallbacks(): InterruptCallbacks {
  const controller = new AbortController();

  return {
    checkInterruption: () => controller.signal.aborted,
    abortSignal: controller.signal,
    onInterrupt: () => controller.abort(),
  };
}
