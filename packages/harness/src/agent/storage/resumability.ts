import { Effect } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import { recipeBlockOf, type ResumeRefusal, type RunId } from '@shared/schemas';
import { claimStanding } from '@shared/session/database';
import { continuesFromRows } from '@shared/session/runActions';
import { runReadRefusal, SessionLog } from '@shared/session/runHistory';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'Resumability';

/** Where a run continues from: a point its loop opened, none, rows an
 *  earlier build wrote, rows that are damaged or cannot be continued, a
 *  point whose plugin facts this process cannot interpret, or unknown
 *  because they could not be read. */
type ResumabilityDecision =
  | { readonly kind: 'checkpoint' }
  | { readonly kind: 'unreadable'; readonly cause: string }
  | { readonly kind: 'unusableCheckpoint'; readonly cause: string }
  | Extract<
      ResumeRefusal,
      { readonly kind: 'finished' | 'earlierBuild' | 'pluginUnavailable' }
    >;

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
    const refused = runReadRefusal(read.failure);
    const message = toErrorMessage(read.failure);
    // An earlier build's row: this build cannot open the run, and says so.
    if (refused === 'earlierBuild')
      return { kind: 'earlierBuild', cause: message };
    // A damaged or unusable row reads the same way every time: no retry
    // helps, unlike a read that failed.
    const decision: ResumabilityDecision =
      refused === undefined
        ? {
            kind: 'unreadable',
            cause: `run state could not be read (${message})`,
          }
        : {
            kind: 'unusableCheckpoint',
            cause: `run state cannot be used (${message})`,
          };
    yield* Effect.logWarning(`Run ${runId}: ${decision.cause}`).pipe(
      withLogChannel(CHANNEL),
    );
    return decision;
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
 * {@link deriveResumability} as a refusal, or null when the run may
 * continue; facts that could not be read right now fail. Ownership is the
 * caller's: a resume reads this under the claim it already holds.
 */
export const checkpointRefusal = Effect.fn('checkpointRefusal')(function* (
  runId: RunId,
): Effect.fn.Return<ResumeRefusal | null, Error, SessionLog> {
  const decision = yield* deriveResumability(runId);
  if (decision.kind === 'checkpoint') return null;
  if (decision.kind === 'unreadable')
    return yield* Effect.fail(
      new Error(`Could not read the state of run ${runId}: ${decision.cause}`),
    );
  if (decision.kind === 'unusableCheckpoint')
    return { kind: 'unusableCheckpoint' };
  return decision;
});

/**
 * Why a resume of `runId` here is rejected, read from disk without changing
 * anything, or null when it may go ahead: nobody alive holds the claim, or
 * this process does with no loop behind it, which the resume takes over.
 * The one decider for a run with no loop here and no claim taken: a
 * message's admission, a recovered child and a host's run record all ask
 * it. The rejection is not stored. A fact that cannot be read fails.
 */
export const runRejection = Effect.fn('runRejection')(function* (
  runId: RunId,
): Effect.fn.Return<ResumeRefusal | null, Error, SessionLog> {
  const standing = claimStanding(yield* (yield* SessionLog).owner(runId));
  if (standing.kind === 'held')
    return { kind: 'ownedElsewhere', owner: standing.owner };
  return yield* checkpointRefusal(runId);
});
