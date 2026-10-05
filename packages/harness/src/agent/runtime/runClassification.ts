/**
 * One classification of a persisted run, read from disk facts, mutating
 * nothing.
 *
 * In-memory RUNNING/WAITING means exactly "a running loop exists in this
 * process's registry". Every other run in the shared bucket is one of these,
 * decided once here and never inferred:
 *
 * - `held_elsewhere`: its aggregate claim is held by an owner that is alive
 *   or cannot be proven dead (another TeXRA process). Shown read-only.
 * - `owned_here`: the claim is held by this very process, yet no loop runs
 *   for it here: a registry/claim disagreement. Shown read-only.
 * - `resumable`: nobody alive holds the claim and `deriveResumability`
 *   finds a point to continue from.
 * - `finished`: nobody holds it and there is nothing to continue from.
 * - `unclassified`: the claim or metadata could not be read or is malformed.
 *   Nothing is known, so nothing is mutated.
 *
 * The first, second, and last kinds are all shown as one unavailable state
 * whose detail is the text of the fact; Delete is the user's only action.
 */
import { Effect } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { deriveResumability } from '@agent/storage/resumability';
import { withLogChannel } from '@logger/effectLog';
import type { OwnerId, RunId } from '@shared/schemas';
import { claimStanding } from '@shared/session/database';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'RunClassification';

export type RunClassification =
  | { readonly kind: 'held_elsewhere'; readonly owner: OwnerId }
  | { readonly kind: 'owned_here' }
  | { readonly kind: 'resumable' }
  | { readonly kind: 'finished' }
  | { readonly kind: 'unclassified'; readonly cause: string };

/** Classify one run. Never throws: an unreadable fact is `unclassified`. */
export const classifyRun = Effect.fn('classifyRun')(function* (
  runId: RunId,
  session: SessionHandle,
): Effect.fn.Return<RunClassification> {
  const claimResult = yield* Effect.result(session.claimOwner(runId));
  if (claimResult._tag === 'Failure') {
    const error = claimResult.failure;
    const cause = `claim unreadable (${toErrorMessage(error)})`;
    yield* Effect.logWarning(`Cannot classify ${runId}: ${cause}`).pipe(
      Effect.annotateLogs({ data: error }),
      withLogChannel(CHANNEL),
    );
    return { kind: 'unclassified', cause };
  }
  const standing = claimStanding(claimResult.success);
  if (standing.kind === 'self') return { kind: 'owned_here' };
  if (standing.kind === 'held')
    return { kind: 'held_elsewhere', owner: standing.owner };
  const facts = yield* deriveResumability(runId, session);
  if (facts.kind === 'checkpoint' || facts.kind === 'unopened')
    return { kind: 'resumable' };
  if (facts.kind === 'none') return { kind: 'finished' };
  return { kind: 'unclassified', cause: facts.cause };
});
