/**
 * Whether a run is still going, decided from facts that outlive this process.
 *
 * "No handle in this process" is not liveness. A run this shell never
 * launched, one another TeXRA process owns, and one whose owner crashed all
 * look identical from the registry, so a missing handle (or a missing
 * `meta.outcome`) can never on its own justify telling a model that a run
 * finished — or that it is still running. The order below asks the durable
 * owners first and only falls back to the persisted reading once nothing
 * alive claims the run:
 *
 * 1. a handle in this process — the registry's phase is the live truth;
 * 2. `classifyRun` names a live foreign owner, or cannot read the run's
 *    facts at all — nothing terminal may be claimed, and the reason is shown;
 * 3. `classifyRun` finds a resumable checkpoint and no outcome was recorded —
 *    the run was interrupted (a crash, or a host that quit);
 * 4. otherwise the persisted outcome, or "unknown" when there is none.
 *
 * Ownership and checkpoint validity are not re-derived here: `classifyRun`
 * is the one classifier of those durable facts, and it is deliberately
 * stricter than a file-presence stat — a spent cursor, a malformed record,
 * or one written by a newer TeXRA is `unclassified`, never a checkpoint to
 * promise the caller.
 */

import { currentSession } from '@agent/runtime/SessionHandle';
import type { ExecutionStatusInfo } from '@agent/runtime/ExecutionHandle';
import { classifyRun } from '@agent/runtime/runClassification';
import type { LeaseOwnerRecord } from '@agent/storage/leaseOwnerLiveness';
import type { ExecutionId, RunOutcome } from '@shared/schemas';

/**
 * What may be said about a run right now. `unsettled` carries a mid-sentence
 * clause naming the fact that forbids a terminal reading, so each surface can
 * word it in its own voice.
 */
export type ExecutionLiveness =
  | { readonly kind: 'live'; readonly info: ExecutionStatusInfo }
  | { readonly kind: 'unsettled'; readonly reason: string }
  | { readonly kind: 'interrupted' }
  | { readonly kind: 'settled' };

/** `executionHeldMessage`'s copy, as a clause a sentence can continue with. */
function heldElsewhereReason(owner: LeaseOwnerRecord): string {
  return `held by another TeXRA process (pid ${owner.pid} on ${owner.hostname})`;
}

export async function resolveExecutionLiveness(
  executionId: ExecutionId,
  outcome: RunOutcome | undefined,
): Promise<ExecutionLiveness> {
  const { executions } = currentSession();
  const handle = executions.getHandle(executionId);
  if (handle) return { kind: 'live', info: executions.getStatus(handle) };

  // `classifyRun` never throws: an unreadable lease, metadata, or checkpoint
  // arrives as `unclassified` with its cause.
  const classification = await classifyRun(executionId);
  switch (classification.kind) {
    case 'held_elsewhere':
      return {
        kind: 'unsettled',
        reason: heldElsewhereReason(classification.owner),
      };
    case 'unclassified':
      return {
        kind: 'unsettled',
        reason: `in a state this process cannot read (${classification.cause})`,
      };
    case 'resumable':
      // A valid checkpoint with no outcome and no live owner is a run that
      // stopped without finishing.
      return outcome === undefined
        ? { kind: 'interrupted' }
        : { kind: 'settled' };
    case 'owned_here':
    case 'finished':
      return { kind: 'settled' };
  }
}
