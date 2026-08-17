import { z } from 'zod';

import { RUN_OUTCOME, type RunOutcome } from './stream';

/** Status of a persisted run in the CLI history output. */
export const HISTORY_RUN_STATUS = {
  RESUMABLE: 'resumable',
  COMPLETED: RUN_OUTCOME.COMPLETED,
  CANCELLED: RUN_OUTCOME.CANCELLED,
  FAILED: RUN_OUTCOME.FAILED,
  UNKNOWN: 'unknown',
} as const;

export const HISTORY_RUN_STATUS_LABEL = {
  [HISTORY_RUN_STATUS.RESUMABLE]: 'Resumable',
  [HISTORY_RUN_STATUS.COMPLETED]: 'Completed',
  [HISTORY_RUN_STATUS.CANCELLED]: 'Cancelled',
  [HISTORY_RUN_STATUS.FAILED]: 'Failed',
  [HISTORY_RUN_STATUS.UNKNOWN]: 'Unknown',
} as const satisfies Record<
  (typeof HISTORY_RUN_STATUS)[keyof typeof HISTORY_RUN_STATUS],
  string
>;

const HistoryRunStatusSchema = z.enum(HISTORY_RUN_STATUS);
export type HistoryRunStatus = z.infer<typeof HistoryRunStatusSchema>;

/** Project persisted resumability onto the CLI history status vocabulary. */
export function resolveHistoryRunStatus(decision: {
  readonly resumable: boolean;
  readonly outcome?: RunOutcome;
}): HistoryRunStatus {
  if (decision.resumable) return HISTORY_RUN_STATUS.RESUMABLE;
  return decision.outcome ?? HISTORY_RUN_STATUS.UNKNOWN;
}
