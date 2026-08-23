/**
 * One classification of a persisted run, read from disk facts, mutating
 * nothing.
 *
 * In-memory RUNNING/WAITING means exactly "a live flow context exists in this
 * process's registry". Every other run in the shared bucket is one of these,
 * decided once here and never inferred:
 *
 * - `held_elsewhere`: its execution lease is readable and held by an owner
 *   that is alive or cannot be proven dead (another TeXRA process). Shown
 *   read-only; when the owner is unprovable the user is told so and may
 *   reclaim it explicitly.
 * - `owned_here`: its lease is held by this very process. Never a restart
 *   candidate; the caller treats reaching it as an invariant violation.
 * - `resumable`: a checkpoint (flow record) exists and nobody alive holds the
 *   lease. Continued only through the explicit Resume affordance.
 * - `finished`: no checkpoint. Its persisted outcome, when present, is the
 *   display fact.
 * - `unclassified`: the lease, metadata, or flow record could not be read.
 *   Nothing is known, so nothing is mutated; the stream is shown as
 *   unclassified with the cause, and Resume (which re-reads and re-acquires)
 *   is the retry.
 */
import {
  inspectExecutionLease,
  type ExecutionLeasePresence,
} from '@agent/storage/executionLease';
import {
  deriveResumability,
  RESUMABILITY_CAUSE,
} from '@agent/storage/resumability';
import { createLog } from '@logger/logUtils';
import type { ExecutionId, RunOutcome } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

const log = createLog('RunClassification');

export type RunClassification =
  | {
      readonly kind: 'held_elsewhere';
      /** False when the holder could not be proven alive. */
      readonly provable: boolean;
    }
  | { readonly kind: 'owned_here' }
  | { readonly kind: 'resumable'; readonly outcome?: RunOutcome }
  | { readonly kind: 'finished'; readonly outcome?: RunOutcome }
  | { readonly kind: 'unclassified'; readonly cause: string };

/** Classify one execution. Never throws: an unreadable fact is `unclassified`. */
export async function classifyRun(
  executionId: ExecutionId,
): Promise<RunClassification> {
  let lease: ExecutionLeasePresence;
  try {
    lease = await inspectExecutionLease(executionId);
  } catch (error) {
    const cause = `lease unreadable (${toErrorMessage(error)})`;
    log.warn(`Cannot classify ${executionId}: ${cause}`, { data: error });
    return { kind: 'unclassified', cause };
  }
  if (lease.status === 'owned') return { kind: 'owned_here' };
  if (lease.status === 'foreign') {
    return { kind: 'held_elsewhere', provable: lease.provable };
  }

  const resumability = await deriveResumability(executionId);
  if (resumability.resumable) {
    return { kind: 'resumable', outcome: resumability.outcome };
  }
  switch (resumability.cause) {
    case RESUMABILITY_CAUSE.UNREADABLE_META:
    case RESUMABILITY_CAUSE.INVALID_META:
    case RESUMABILITY_CAUSE.UNREADABLE_FLOW:
      log.warn(`Cannot classify ${executionId}: ${resumability.cause}`);
      return { kind: 'unclassified', cause: resumability.cause };
    case RESUMABILITY_CAUSE.MISSING_FLOW:
    case RESUMABILITY_CAUSE.INVALID_FLOW:
      return { kind: 'finished', outcome: resumability.outcome };
  }
}
