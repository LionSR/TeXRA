import type { RunEnd, RunEndError } from '@shared/schemas';

/**
 * A run's report to its lifecycle, not an end: what it answered and edited,
 * and `failure`, the model failure its turn ended on. The run's terminal (`endRun`) records it as the
 * `run.end` row's error, and a failed child's report carries that error,
 * which its delivery words.
 */
export type RunReport = Pick<RunEnd, 'outcome' | 'output'> & {
  readonly failure?: RunEndError;
};
