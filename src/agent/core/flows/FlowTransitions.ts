export const FlowTransition = {
  DEFAULT: 'default',
  COMPLETE: 'complete',
  CONTINUE: 'continue',
  FINALIZE: 'finalize',
  WAITING: 'waiting',
} as const;

export type FlowTransition =
  (typeof FlowTransition)[keyof typeof FlowTransition];
