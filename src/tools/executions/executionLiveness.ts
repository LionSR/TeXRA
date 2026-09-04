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
 * 2. `classifyRun` names a live foreign owner, names this process's own lease
 *    with no run behind it and no outcome written, or cannot read the run's
 *    facts at all — nothing terminal may be claimed, and the reason is shown;
 * 3. `classifyRun` finds a resumable checkpoint and read no outcome — the run
 *    was interrupted (a crash, or a host that quit);
 * 4. otherwise the outcome `classifyRun` read, or "unknown" when there is none.
 *
 * The terminal readings (3 and 4) come from the classifier's own fresh read of
 * the durable facts, never from an outcome snapshot the caller took earlier,
 * and each re-checks the lease once before it is returned (see
 * {@link leaseTakenSince}).
 *
 * Ownership and checkpoint validity are not re-derived here: `classifyRun`
 * is the one classifier of those durable facts, and it is deliberately
 * stricter than a file-presence stat — a spent cursor, a malformed record,
 * or one written by a newer TeXRA is `unclassified`, never a checkpoint to
 * promise the caller.
 */

import { currentSession } from '@agent/runtime/SessionHandle';
import type { ExecutionStatusInfo } from '@agent/runtime/ExecutionHandle';
import {
  classifyRun,
  classifyRunFacts,
} from '@agent/runtime/runClassification';
import {
  inspectExecutionLease,
  type ExecutionLeasePresence,
} from '@agent/storage/executionLease';
import type { LeaseOwnerRecord } from '@agent/storage/leaseOwnerLiveness';
import { createLog } from '@logger/logUtils';
import type { ExecutionId, RunOutcome, StreamPhase } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

const log = createLog('ExecutionLiveness');

/**
 * What may be said about a run right now. `unsettled` carries a mid-sentence
 * clause naming the fact that forbids a terminal reading, so each surface can
 * word it in its own voice. `settled` carries the outcome the classifier read,
 * so every surface renders the same durable value.
 */
export type ExecutionLiveness =
  | { readonly kind: 'live'; readonly info: LiveExecutionStatusInfo }
  | { readonly kind: 'unsettled'; readonly reason: string }
  | { readonly kind: 'interrupted' }
  | { readonly kind: 'settled'; readonly outcome?: RunOutcome };

/**
 * A tracked run's status line. Its phase is a real one — the registry answers
 * with the stream's phase, never the `unknown` the persisted arms fall back to
 * — so a reader may ask whether it is still in flight.
 */
type LiveExecutionStatusInfo = ExecutionStatusInfo & { status: StreamPhase };

/** `executionHeldMessage`'s copy, as a clause a sentence can continue with. */
function heldElsewhereReason(owner: LeaseOwnerRecord): string {
  return `held by another TeXRA process (pid ${owner.pid} on ${owner.hostname})`;
}

/**
 * This process holds the lease, tracks no run for it, and no outcome was ever
 * written: the registry and the lease disagree with nothing durable to fall
 * back on, which is a leak to report, never a run to call settled.
 */
const OWNED_HERE_REASON = "held by this process's lease with no live run";

function unreadableReason(cause: string): string {
  return `in a state this process cannot read (${cause})`;
}

/** The unsettled arm a non-free lease forces, or undefined when it is free. */
function unsettledFromLease(
  lease: ExecutionLeasePresence,
): ExecutionLiveness | undefined {
  if (lease.status === 'held') {
    return { kind: 'unsettled', reason: heldElsewhereReason(lease.owner) };
  }
  if (lease.status === 'owned') {
    return { kind: 'unsettled', reason: OWNED_HERE_REASON };
  }
  return undefined;
}

/**
 * Whether an owner took the lease while the classification was being read.
 *
 * `classifyRun` reads the lease, then the metadata, then the checkpoint; a
 * process that started (or resumed) the run across those awaits would leave a
 * terminal reading that is already stale. Costs one extra lease read per row
 * that reaches a terminal claim — the listing's other rows never pay it.
 */
async function leaseTakenSince(
  executionId: ExecutionId,
): Promise<ExecutionLiveness | undefined> {
  try {
    return unsettledFromLease(await inspectExecutionLease(executionId));
  } catch (error) {
    const cause = `lease unreadable (${toErrorMessage(error)})`;
    log.warn(`Cannot re-check the lease for ${executionId}: ${cause}`, {
      data: error,
    });
    return { kind: 'unsettled', reason: unreadableReason(cause) };
  }
}

export async function resolveExecutionLiveness(
  executionId: ExecutionId,
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
    case 'owned_here': {
      // The lease outlives the run it guarded: `finalizeRunTerminal` writes
      // the outcome and untracks the handle, while the child loop releases
      // the lease only after the wake it hands the parent returns — a window
      // that can span the resumed parent's whole turn (#8093), i.e. exactly
      // the turn in which the parent is told the run finished and reads its
      // output. An outcome already on disk is the run's own fact, not the
      // lease's, so it still settles; only a lease with nothing durable
      // behind it is the registry/lease leak this arm reports.
      const facts = await classifyRunFacts(executionId);
      if (facts.kind !== 'unclassified' && facts.outcome !== undefined) {
        return { kind: 'settled', outcome: facts.outcome };
      }
      log.warn(
        `Execution ${executionId} holds this process's lease with no tracked run and no recorded outcome; reporting it as unsettled rather than finished`,
      );
      return { kind: 'unsettled', reason: OWNED_HERE_REASON };
    }
    case 'unclassified':
      return {
        kind: 'unsettled',
        reason: unreadableReason(classification.cause),
      };
    case 'resumable':
    case 'finished': {
      const taken = await leaseTakenSince(executionId);
      if (taken) return taken;
      // A valid checkpoint with no outcome and no live owner is a run that
      // stopped without finishing.
      return classification.kind === 'resumable' &&
        classification.outcome === undefined
        ? { kind: 'interrupted' }
        : { kind: 'settled', outcome: classification.outcome };
    }
  }
}
