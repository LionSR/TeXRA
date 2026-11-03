import { Effect } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import { recipeBlockOf, type ResumeRefusal, type RunId } from '@shared/schemas';
import { claimStanding, DatabaseRowEarlier } from '@shared/session/database';
import { continuesFromRows } from '@shared/session/runActions';
import { SessionLog } from '@shared/session/runHistory';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'Resumability';

/** Where a run continues from: a point its loop opened, none, rows an
 *  earlier build wrote, a point whose plugin facts this process cannot
 *  interpret, or unknown because they could not be read. */
type ResumabilityDecision =
  | { readonly kind: 'checkpoint' }
  | { readonly kind: 'unreadable'; readonly cause: string }
  | Extract<
      ResumeRefusal,
      { readonly kind: 'finished' | 'earlierBuild' | 'pluginUnavailable' }
    >;

/** The earlier-build refusal a failed read carries, if any. */
const earlierRefusal = (error: unknown): DatabaseRowEarlier | undefined =>
  [error, error instanceof Error ? error.cause : undefined].find(
    (e): e is DatabaseRowEarlier => e instanceof DatabaseRowEarlier,
  );

/**
 * The one answer to "can this run resume?", before ownership (`runRejection`
 * adds the claim). An opened run continues whatever its outcome: rows live
 * until deletion, so a failed or cancelled run continues from where they
 * left it. A task that ended does not: its recipe's result is
 * settled, so it runs again instead. One holding a fact of a plugin this
 * process does not load waits for it: the plugin's state is part of where
 * it continues from.
 */
export const deriveResumability = Effect.fn('deriveResumability')(function* (
  runId: RunId,
): Effect.fn.Return<ResumabilityDecision, never, SessionLog> {
  const read = yield* (yield* SessionLog).facts(runId).pipe(Effect.result);
  if (read._tag === 'Failure') {
    // An earlier build's row: this build cannot open the run, and says so.
    const refusal = earlierRefusal(read.failure);
    if (refusal !== undefined)
      return { kind: 'earlierBuild', cause: refusal.message };
    const cause = `run state could not be read (${toErrorMessage(read.failure)})`;
    yield* Effect.logWarning(`Run ${runId}: ${cause}`).pipe(
      withLogChannel(CHANNEL),
    );
    return { kind: 'unreadable', cause };
  }
  const facts = read.success;
  if (
    facts?.start == null ||
    !continuesFromRows({
      ended: facts.end !== null,
      recipe: facts.config === null ? null : recipeBlockOf(facts.config),
      identity: facts.start.identity,
    })
  )
    return { kind: 'finished' };
  for (const { plugin, unavailable } of Object.values(facts.facts))
    if (unavailable !== undefined)
      return { kind: 'pluginUnavailable', plugin, cause: unavailable };
  return { kind: 'checkpoint' };
});

/**
 * Why a resume of `runId` here is rejected, read from disk without changing
 * anything, or null when it may go ahead: nobody alive holds the claim, or
 * this process does with no loop behind it, which the resume takes over.
 * The one decider for a run with no loop here: a message's admission, the
 * resume under the run's claim, a recovered child and a host's run record
 * all ask it. The rejection is not stored. A fact that cannot be read fails.
 */
export const runRejection = Effect.fn('runRejection')(function* (
  runId: RunId,
): Effect.fn.Return<ResumeRefusal | null, Error, SessionLog> {
  const standing = claimStanding(yield* (yield* SessionLog).owner(runId));
  if (standing.kind === 'held')
    return { kind: 'ownedElsewhere', owner: standing.owner };
  const decision = yield* deriveResumability(runId);
  if (decision.kind === 'unreadable')
    return yield* Effect.fail(
      new Error(`Could not read the state of run ${runId}: ${decision.cause}`),
    );
  return decision.kind === 'checkpoint' ? null : decision;
});
