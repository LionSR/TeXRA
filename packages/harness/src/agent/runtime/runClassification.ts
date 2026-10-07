/**
 * Why a persisted run with no loop in this process cannot be resumed here,
 * read from disk facts and mutating nothing. In-memory RUNNING/WAITING means
 * exactly "a running loop exists in this process's registry"; for every
 * other run the refusal is one of:
 *
 * - `held_elsewhere`: its claim is held by an owner that is alive or cannot
 *   be proven dead (another TeXRA process);
 * - `finished`: `deriveResumability` finds no point to continue from.
 *
 * Null when a resume may proceed: nobody alive holds the claim, or this
 * process does with no loop behind it, which the resume takes over. The
 * refusal is shown where the user acted; nothing about it is kept. A fact
 * that cannot be read fails.
 */
import { Effect } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { deriveResumability } from '@agent/storage/resumability';
import type { OwnerId, RunId } from '@shared/schemas';
import { claimStanding } from '@shared/session/database';

/** Why this process cannot resume a run (see the module note). */
export type RunRefusal =
  | { readonly kind: 'held_elsewhere'; readonly owner: OwnerId }
  | { readonly kind: 'finished' };

/** The refusal a resume of `runId` here meets, or null when none. */
export const runRefusal = Effect.fn('runRefusal')(function* (
  runId: RunId,
  session: SessionHandle,
): Effect.fn.Return<RunRefusal | null, Error> {
  const standing = claimStanding(yield* session.log.owner(runId));
  if (standing.kind === 'held')
    return { kind: 'held_elsewhere', owner: standing.owner };
  const facts = yield* deriveResumability(runId, session);
  if (facts.kind === 'unreadable')
    return yield* Effect.fail(
      new Error(`Could not read the state of run ${runId}: ${facts.cause}`),
    );
  return facts.kind === 'none' ? { kind: 'finished' } : null;
});
