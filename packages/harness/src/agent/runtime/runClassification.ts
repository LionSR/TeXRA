/**
 * Why a persisted run with no loop in this process cannot be resumed here,
 * read from disk without changing anything. In-memory RUNNING/WAITING means
 * exactly "a running loop exists in this process's registry"; for every
 * other run the rejection is one of:
 *
 * - `owned_elsewhere`: another owner holds its claim and is alive or cannot
 *   be proven dead (another process);
 * - `finished`: `deriveResumability` finds no point to continue from;
 * - `earlier_build`: its rows were written by an earlier build.
 *
 * Each kind is also a follow-up failure reason, so a sender's result names
 * it as is. Null when a resume may go ahead: nobody alive holds the claim,
 * or this process does with no loop behind it, which the resume takes over.
 * The one decider: the admission of a message asks it before the row
 * commits, the resume asks it under the run's claim, a host's run record
 * reads it. The rejection is shown where the user acted and is not stored.
 * A fact that cannot be read fails.
 */
import { Effect } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { deriveResumability } from '@agent/storage/resumability';
import type { OwnerId, RunId } from '@shared/schemas';
import { claimStanding } from '@shared/session/database';

/** Why this process cannot resume a run (see the module note). */
export type RunRejection =
  | { readonly kind: 'owned_elsewhere'; readonly owner: OwnerId }
  | { readonly kind: 'finished' }
  | { readonly kind: 'earlier_build' };

/** Why a resume of `runId` here is rejected, or null when it may go ahead. */
export const runRejection = Effect.fn('runRejection')(function* (
  runId: RunId,
  session: SessionHandle,
): Effect.fn.Return<RunRejection | null, Error> {
  const standing = claimStanding(yield* session.log.owner(runId));
  if (standing.kind === 'held')
    return { kind: 'owned_elsewhere', owner: standing.owner };
  const facts = yield* deriveResumability(runId, session);
  if (facts.kind === 'unreadable')
    return yield* Effect.fail(
      new Error(`Could not read the state of run ${runId}: ${facts.cause}`),
    );
  if (facts.kind === 'earlierBuild') return { kind: 'earlier_build' };
  return facts.kind === 'none' ? { kind: 'finished' } : null;
});
