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
 * 2. the execution lease names a live foreign owner, or cannot be read at
 *    all — nothing terminal may be claimed, and the reason is shown;
 * 3. the lease is free, no outcome was recorded, and a resume checkpoint is
 *    still on disk — the run was interrupted (a crash, or a host that quit);
 * 4. otherwise the persisted outcome, or "unknown" when there is none.
 */

import { currentSession } from '@agent/runtime/SessionHandle';
import type { ExecutionStatusInfo } from '@agent/runtime/ExecutionHandle';
import { flowKey } from '@agent/node/persistedFlow';
import { getExecutionStore } from '@agent/storage/ExecutionKVStore';
import { inspectExecutionLease } from '@agent/storage/executionLease';
import type { LeaseOwnerRecord } from '@agent/storage/leaseOwnerLiveness';
import { createLog } from '@logger/logUtils';
import type { ExecutionId, RunOutcome } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

const log = createLog('ExecutionLiveness');

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

  try {
    const lease = await inspectExecutionLease(executionId);
    if (lease.status === 'held') {
      return { kind: 'unsettled', reason: heldElsewhereReason(lease.owner) };
    }
    if (lease.status === 'free' && outcome === undefined) {
      // A checkpoint with no outcome and no owner is a run that stopped
      // without finishing: the same reading restart repair used to write.
      const checkpointPresent = await getExecutionStore(executionId).exists(
        flowKey(executionId),
      );
      if (checkpointPresent) return { kind: 'interrupted' };
    }
  } catch (error) {
    const cause = toErrorMessage(error);
    log.warn(
      `Execution ${executionId}: ownership could not be read (${cause}); reporting it as unsettled rather than finished`,
      { data: error },
    );
    return {
      kind: 'unsettled',
      reason: `owned by a process this one cannot identify (${cause})`,
    };
  }

  return { kind: 'settled' };
}
