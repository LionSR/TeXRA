import {
  HISTORY_RUN_STATUS,
  RUN_OUTCOME,
  type HistoryRunStatus,
  type RunLifecycleStatus,
} from '@shared/schemas';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';

/** What a run's history standing is decided from: the view's folded facts
 *  and `deriveResumability`'s answer. */
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
