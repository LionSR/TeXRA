import type {
  AttachedMemoryMiss,
  RetryErrorInfo,
  RunEnd,
  RunId,
} from '@shared/schemas';

/**
 * A run's report to its lifecycle, not an end: what it answered and edited,
 * the attached-memory misses its delivery reports, and `failure`, its own
 * provider/runtime error, not yet classified. Only `runWithLifecycle`
 * classifies it, into the `run.end` row's error; a failed child's report
 * carries the normalized error its delivery reports.
 */
export type RunReport = Pick<RunEnd, 'outcome' | 'output'> & {
  readonly runId: RunId;
  readonly memoryMisses?: readonly AttachedMemoryMiss[];
  readonly failure?: RetryErrorInfo;
};
