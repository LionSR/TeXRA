/**
 * Which status a run reads as, and which section of a run list it sits in:
 * the classification every host and the service's task list share. The
 * words, tones and glyphs for each key are copy (`@ui/copy/runStatus`).
 */
import { Schema } from 'effect';

import {
  isInterrupted,
  isPlainAgentIdentity,
  RunOutcomeSchema,
  RunPositionSchema,
  type RunStanding,
  type RunView,
} from '@texra-ai/harness/schemas';

/**
 * Each way a run's status reads: the outcome it ended on, where its loop
 * stands, or one of the readings that refine or outrank both: `interrupted`
 * (nobody drives a run that has not ended), `waitingOnUser` (a request of its
 * own waits here), and `starting` / `resuming`, an agent's activation before
 * its first loop step (a first one, or one after a turn has ended).
 */
export const RunStatusKeySchema = Schema.Union([
  RunPositionSchema,
  RunOutcomeSchema,
  Schema.Literals(['starting', 'resuming', 'interrupted', 'waitingOnUser']),
]);

/** How a run's status reads: one member of {@link RunStatusKeySchema}. */
export type RunStatusKey = typeof RunStatusKeySchema.Type;

/** The section a run list puts a run in. */
export type RunSection = 'running' | 'waiting' | 'interrupted' | 'recent';

/** The facts a run's status is read from: where it stands, and what
 *  outranks or refines that. */
export type RunStatusFacts = RunStanding &
  Pick<RunView, 'holder' | 'approval' | 'turn' | 'identity' | 'forkPoint'>;

/**
 * The one reading of a run's status: an interrupted run outranks one
 * waiting on the user, which outranks its outcome and then its position.
 */
export function runStatusKey(run: RunStatusFacts): RunStatusKey {
  if (isInterrupted(run)) return 'interrupted';
  if (run.approval === 'own') return 'waitingOnUser';
  if (run.outcome !== null) return run.outcome;
  if (
    run.position === 'running' &&
    run.turn === null &&
    isPlainAgentIdentity(run.identity)
  )
    return run.forkPoint === null ? 'starting' : 'resuming';
  return run.position;
}

/** The section a run list puts `run` in, by the same precedence. */
export function runSection(run: RunStatusFacts): RunSection {
  if (isInterrupted(run)) return 'interrupted';
  if (run.approval === 'own') return 'waiting';
  return run.holder === 'here' && run.position !== 'ready'
    ? 'running'
    : 'recent';
}
