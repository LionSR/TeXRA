import { Effect } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { withLogChannel } from '@logger/effectLog';
import { recipeBlockOf, type OwnerId, type RunId } from '@shared/schemas';
import { claimStanding, DatabaseRowEarlier } from '@shared/session/database';
import { continuesFromRows } from '@shared/session/runActions';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'Resumability';

/** Why this process cannot resume a run. Each kind is also a follow-up
 *  failure reason, so a sender's result names it as is. */
export type RunRejection =
  /** A live owner, or one not provably dead, holds its claim. */
  | { readonly kind: 'owned_elsewhere'; readonly owner: OwnerId }
  /** Its rows hold no point to continue from. */
  | { readonly kind: 'finished' }
  /** An earlier build wrote its rows. */
  | { readonly kind: 'earlier_build'; readonly cause: string };

/** Where a run continues from: a point its loop opened, none, rows an
 *  earlier build wrote, or unknown because they could not be read. */
type ResumabilityDecision =
  | { readonly kind: 'checkpoint' }
  | { readonly kind: 'unreadable'; readonly cause: string }
  | Exclude<RunRejection, { readonly kind: 'owned_elsewhere' }>;

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
 * settled, so it runs again instead.
 */
export const deriveResumability = Effect.fn('deriveResumability')(function* (
  runId: RunId,
  session: SessionHandle,
): Effect.fn.Return<ResumabilityDecision> {
  const read = yield* session.log.facts(runId).pipe(Effect.result);
  // An earlier build's row: this build cannot open the run, and says so.
  const refusal =
    read._tag === 'Failure' ? earlierRefusal(read.failure) : undefined;
  if (refusal !== undefined)
    return { kind: 'earlier_build', cause: refusal.message };
  if (read._tag === 'Failure') {
    const cause = `run state could not be read (${toErrorMessage(read.failure)})`;
    yield* Effect.logWarning(`Run ${runId}: ${cause}`).pipe(
      withLogChannel(CHANNEL),
    );
    return { kind: 'unreadable', cause };
  }
  const facts = read.success;
  return facts?.start != null &&
    continuesFromRows({
      ended: facts.end !== null,
      recipe: facts.config === null ? null : recipeBlockOf(facts.config),
      identity: facts.start.identity,
    })
    ? { kind: 'checkpoint' }
    : { kind: 'finished' };
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
  session: SessionHandle,
): Effect.fn.Return<RunRejection | null, Error> {
  const standing = claimStanding(yield* session.log.owner(runId));
  if (standing.kind === 'held')
    return { kind: 'owned_elsewhere', owner: standing.owner };
  const decision = yield* deriveResumability(runId, session);
  if (decision.kind === 'unreadable')
    return yield* Effect.fail(
      new Error(`Could not read the state of run ${runId}: ${decision.cause}`),
    );
  return decision.kind === 'checkpoint' ? null : decision;
});
