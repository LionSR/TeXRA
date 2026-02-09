/**
 * Shared transition identifiers that flow nodes emit to describe how control should
 * move through a flow graph once a node finishes running.
 */
export const FlowTransition = {
  /** Follow the default next() successor - the standard forward transition. */
  DEFAULT: 'default',
  /** The current flow branch has completed and should hand control back to the caller. */
  COMPLETE: 'complete',
  /** Continue execution by looping back to the flow's entry point. */
  CONTINUE: 'continue',
  /** Exit the flow entirely after running any finalisation hooks. */
  FINALIZE: 'finalize',
} as const;

export type FlowTransition =
  (typeof FlowTransition)[keyof typeof FlowTransition];
