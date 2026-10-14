import type { ResultMeta, RunEnd, RunOutcome } from '@shared/schemas';

/**
 * The public value of one run's result endpoint (`readResult`): the run's
 * terminal result with the output as its delivery reported it, or a
 * background command's own record. The terminal fields are absent while the
 * run has not ended.
 */
export type RunResult =
  | Extract<ResultMeta, { producer: 'backgroundBash' }>
  | (Omit<RunEnd, 'outcome'> & { readonly outcome?: RunOutcome });
