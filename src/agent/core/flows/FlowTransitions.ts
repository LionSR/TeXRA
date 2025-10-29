export const FlowTransition = {
  COMPLETE: 'complete',
  CONTINUE: 'continue',
  FINALIZE: 'finalize',
  ROUND: 'round',
  SKIP: 'skip',
  EXECUTE: 'execute',
} as const;

export type FlowTransition =
  (typeof FlowTransition)[keyof typeof FlowTransition];
