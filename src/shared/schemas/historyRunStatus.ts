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

const HistoryRunStatusSchema = z.enum(HISTORY_RUN_STATUS);
export type HistoryRunStatus = z.infer<typeof HistoryRunStatusSchema>;

export const HISTORY_RUN_STATUS_LABEL = {
  [HISTORY_RUN_STATUS.RESUMABLE]: 'Resumable',
  [HISTORY_RUN_STATUS.COMPLETED]: 'Completed',
  [HISTORY_RUN_STATUS.CANCELLED]: 'Cancelled',
  [HISTORY_RUN_STATUS.FAILED]: 'Failed',
  [HISTORY_RUN_STATUS.UNKNOWN]: 'Unknown',
} as const satisfies Record<HistoryRunStatus, string>;

/**
 * Project persisted resumability onto the CLI history status vocabulary.
 *
 * `status` is a frozen contract (the NDJSON stream is consumed by
 * texra-action): a checkpoint promotes only an interrupted or outcome-less
 * run to `resumable`. A failed run that kept its checkpoint still reports
 * `failed`; whether it can be resumed is the sibling `resumable` boolean on
 * the history entry.
 *
 * `unknown` is what an interrupted run that kept no checkpoint reports: no
 * durable outcome is written for a run whose owner died, because nothing
 * classifies every historical run at startup any more (the boot repair pass
 * that used to write CANCELLED for it was O(history) on the ready path). Such
 * a run's stream still derives CANCELLED at read time from the run tuple; only
 * the durable-outcome readers — this vocabulary and the agent-facing
 * `executions` tool — say `unknown`. Restoring the durable outcome needs a
 * liveness check off the ready path, not a guess here: a run another process
 * is executing right now is equally outcome-less.
 */
export function resolveHistoryRunStatus(decision: {
  readonly resumable: boolean;
  readonly outcome?: RunOutcome;
}): HistoryRunStatus {
  if (
    decision.resumable &&
    (decision.outcome == null || decision.outcome === RUN_OUTCOME.CANCELLED)
  ) {
    return HISTORY_RUN_STATUS.RESUMABLE;
  }
  return decision.outcome ?? HISTORY_RUN_STATUS.UNKNOWN;
}
