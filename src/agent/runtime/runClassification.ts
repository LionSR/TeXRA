/**
 * One classification of a persisted run, read from disk facts, mutating
 * nothing.
 *
 * In-memory RUNNING/WAITING means exactly "a live flow context exists in this
 * process's registry". Every other unfinished run in the shared bucket is one
 * of three things, decided once here and never inferred:
 *
 * - `held_elsewhere`: its execution lease is held by an owner that is alive or
 *   cannot be proven dead (another TeXRA process). Shown read-only; when the
 *   owner is unprovable the user is told so and may reclaim it explicitly.
 * - `resumable`: a checkpoint (flow record) exists and nobody alive holds the
 *   lease. Continued only through the explicit Resume affordance.
 * - `finished`: no checkpoint. Its persisted outcome, when present, is the
 *   display fact.
 *
 * An unreadable lease classifies as held, never as resumable: a run whose
 * ownership cannot be established must not be offered for a second owner.
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

const log = createLog('RunClassification');

export type RunClassification =
  | {
      readonly kind: 'held_elsewhere';
      /** False when the holder could not be proven alive (or read at all). */
      readonly provable: boolean;
    }
  | { readonly kind: 'resumable'; readonly outcome?: RunOutcome }
  | { readonly kind: 'finished'; readonly outcome?: RunOutcome };

/**
 * Classify one execution. Throws when the execution's own storage (metadata
 * or flow record) is unreadable: that run cannot be classified, and the
 * caller decides how loudly to say so.
 */
export async function classifyRun(
  executionId: ExecutionId,
): Promise<RunClassification> {
  let lease: ExecutionLeasePresence;
  try {
    lease = await inspectExecutionLease(executionId);
  } catch (error) {
    log.warn(
      `Cannot classify ownership of ${executionId}; treating it as held elsewhere`,
      { data: error },
    );
    return { kind: 'held_elsewhere', provable: false };
  }
  if (lease.status === 'owned' || lease.status === 'foreign') {
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
      throw new Error(
        `Cannot classify execution ${executionId}: ${resumability.cause}`,
      );
    case RESUMABILITY_CAUSE.MISSING_FLOW:
    case RESUMABILITY_CAUSE.INVALID_FLOW:
      return { kind: 'finished', outcome: resumability.outcome };
  }
}
