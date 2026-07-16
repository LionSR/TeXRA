import {
  abandonOwnedExecutionLease,
  completeOwnedExecutionLease,
  runWithOwnedExecutionLease,
} from '@agent/storage/executionLease';
import type { ExecutionId } from '@shared/schemas';

import type { SessionHandle } from './SessionHandle';

/** Persist session artifacts without allowing a former lease owner to write. */
export async function flushOwnedExecutionArtifacts(
  session: SessionHandle,
  executionId: ExecutionId,
): Promise<void> {
  await runWithOwnedExecutionLease(executionId, () => session.flushArtifacts());
}

/** End ownership only after every session-owned durable writer has drained. */
export async function releaseExecutionLeaseAfterArtifacts(
  session: SessionHandle,
  executionId: ExecutionId,
): Promise<void> {
  try {
    await flushOwnedExecutionArtifacts(session, executionId);
  } catch (error) {
    abandonOwnedExecutionLease(executionId);
    throw error;
  }
  await completeOwnedExecutionLease(executionId);
}
