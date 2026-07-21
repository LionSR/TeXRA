import {
  abandonOwnedExecutionLease,
  completeOwnedExecutionLease,
  renewOwnedExecutionLease,
} from '@agent/storage/executionLease';
import type { ExecutionId } from '@shared/schemas';

import type { SessionHandle } from './SessionHandle';

/**
 * Persist session artifacts between two short owner-token validations.
 * The durable lease remains fresh while the session drains, so no file lock
 * needs to cover unrelated transcript and snapshot I/O.
 */
export async function flushOwnedExecutionArtifacts(
  session: SessionHandle,
  executionId: ExecutionId,
): Promise<void> {
  await renewOwnedExecutionLease(executionId);
  await session.flushArtifacts(executionId);
  await renewOwnedExecutionLease(executionId);
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
