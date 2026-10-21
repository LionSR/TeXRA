import { isTerminalOutcomePhase } from '@texra-ai/harness/schemas';
import { RUN_OUTCOME, type RunLifecycleStatus } from '@shared/schemas';

/** Status of a persisted run in the CLI history output. */
export const HISTORY_RUN_STATUS = {
  RESUMABLE: 'resumable',
  /** A child a stop rested (`RunView.substate` paused): its parent's model
   *  continues it by calling it again. */
  PAUSED: 'paused',
  COMPLETED: RUN_OUTCOME.COMPLETED,
  CANCELLED: RUN_OUTCOME.CANCELLED,
  FAILED: RUN_OUTCOME.FAILED,
  UNKNOWN: 'unknown',
} as const;

export type HistoryRunStatus =
  (typeof HISTORY_RUN_STATUS)[keyof typeof HISTORY_RUN_STATUS];

export const HISTORY_RUN_STATUS_LABEL = {
  [HISTORY_RUN_STATUS.RESUMABLE]: 'Resumable',
  [HISTORY_RUN_STATUS.PAUSED]: 'Paused',
  [HISTORY_RUN_STATUS.COMPLETED]: 'Completed',
  [HISTORY_RUN_STATUS.CANCELLED]: 'Cancelled',
  [HISTORY_RUN_STATUS.FAILED]: 'Failed',
  [HISTORY_RUN_STATUS.UNKNOWN]: 'Unknown',
} as const satisfies Record<HistoryRunStatus, string>;

/** What a run's history standing is decided from: the view's folded facts
 *  and `records(id).readResumable()`'s answer. */
export interface CliRunFacts {
  readonly resumable: boolean;
  /** The run's folded status; a terminal outcome phase is its durable
   *  outcome, anything else means no outcome has landed. */
  readonly phase?: RunLifecycleStatus;
  /** A stop rested the run instead of ending it (a paused child). */
  readonly paused?: boolean;
}

/** A run's CLI history standing: the frozen `status` and the `resumable`
 *  boolean beside it. */
export interface CliRunStanding {
  readonly status: HistoryRunStatus;
  readonly resumable: boolean;
}

/**
 * The history standing of a run. `status` is a frozen contract (texra-action
 * reads the NDJSON stream): resumability promotes only an interrupted or
 * outcome-less run to `resumable`, so a failed run that can continue still
 * reports `failed` beside `resumable: true`. An outcome-less run that cannot
 * continue reports `unknown`.
 */
export function cliRunStanding(facts: CliRunFacts): CliRunStanding {
  // A paused child is continued by its parent's model, never by `resume`.
  if (facts.paused)
    return { status: HISTORY_RUN_STATUS.PAUSED, resumable: false };
  const outcome = isTerminalOutcomePhase(facts.phase) ? facts.phase : undefined;
  const status =
    facts.resumable &&
    (outcome === undefined || outcome === RUN_OUTCOME.CANCELLED)
      ? HISTORY_RUN_STATUS.RESUMABLE
      : (outcome ?? HISTORY_RUN_STATUS.UNKNOWN);
  return { status, resumable: facts.resumable };
}
