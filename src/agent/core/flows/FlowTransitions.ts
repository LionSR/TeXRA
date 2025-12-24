/**
 * Shared transition identifiers that flow nodes emit to describe how control should
 * move through a flow graph once a node finishes running.
 */
export const FlowTransition = {
  /** The current flow branch has completed and should hand control back to the caller. */
  COMPLETE: 'complete',
  /** Continue execution by looping back to the flow's entry point. */
  CONTINUE: 'continue',
  /** Exit the flow entirely after running any finalisation hooks. */
  FINALIZE: 'finalize',
  /** Begin a new round iteration (used by reflection flows). */
  ROUND: 'round',
  /** Skip the current node's work but remain in the flow. */
  SKIP: 'skip',
  /** Execute the next actionable node immediately. */
  EXECUTE: 'execute',
} as const;

export type FlowTransition =
  (typeof FlowTransition)[keyof typeof FlowTransition];
