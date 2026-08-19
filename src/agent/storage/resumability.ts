import { z } from 'zod';

import {
  PersistedFlowRecordEnvelopeSchema,
  flowKey,
  type FlowRecord,
} from '@agent/node/persistedFlow';
import { createLog } from '@logger/logUtils';
import {
  ExecutionMetaCoreSchema,
  RUN_OUTCOME,
  type ExecutionId,
  type ExecutionMeta,
  type RunOutcome,
} from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { getExecutionStore } from './ExecutionKVStore';
import {
  inspectExecutionLease,
  type ExecutionLeasePresence,
} from './executionLease';

const log = createLog('Resumability');

const ResumableSharedSchema = z.record(z.string(), z.unknown());
const ResumableFlowRecordSchema = PersistedFlowRecordEnvelopeSchema.refine(
  (record) => ResumableSharedSchema.safeParse(record.shared).success,
  {
    message: 'Resumable flow shared state must be an object',
    path: ['shared'],
  },
);

export const RESUMABILITY_CAUSE = {
  INTERRUPTED_WITH_FLOW: 'interrupted-with-flow',
  MISSING_TERMINAL_WITH_FLOW: 'missing-terminal-with-flow',
  TERMINAL_COMPLETED: 'terminal-completed',
  TERMINAL_FAILED: 'terminal-failed',
  MISSING_FLOW: 'missing-flow',
  INVALID_FLOW: 'invalid-flow',
  INVALID_META: 'invalid-meta',
  UNREADABLE_FLOW: 'unreadable-flow',
  UNREADABLE_META: 'unreadable-meta',
  /** A host still holds the execution's lease — it is running, not waiting. */
  ACTIVE_LEASE: 'active-lease',
  /** Ownership could not be classified, so liveness is unproven. */
  UNREADABLE_LEASE: 'unreadable-lease',
} as const;

type ResumabilityCause =
  (typeof RESUMABILITY_CAUSE)[keyof typeof RESUMABILITY_CAUSE];
type ResumableCause =
  | typeof RESUMABILITY_CAUSE.INTERRUPTED_WITH_FLOW
  | typeof RESUMABILITY_CAUSE.MISSING_TERMINAL_WITH_FLOW;
type NonResumableCause = Exclude<ResumabilityCause, ResumableCause>;

export type ResumabilityDecision =
  | {
      readonly resumable: true;
      readonly cause: ResumableCause;
      readonly flowRecord: FlowRecord;
      readonly outcome?: RunOutcome;
    }
  | {
      readonly resumable: false;
      readonly cause: NonResumableCause;
      readonly outcome?: RunOutcome;
    };

function terminalBlockCause(
  meta: ExecutionMeta | null,
): NonResumableCause | undefined {
  if (meta?.outcome === RUN_OUTCOME.COMPLETED) {
    return RESUMABILITY_CAUSE.TERMINAL_COMPLETED;
  }
  if (meta?.outcome === RUN_OUTCOME.FAILED) {
    return RESUMABILITY_CAUSE.TERMINAL_FAILED;
  }
  return undefined;
}

/**
 * Single storage-owned resumability decision.
 *
 * Terminal metadata is authoritative for completed/failed runs so stale flow
 * files cannot resurrect old executions. Cancelled or crash-interrupted runs
 * require a valid flow record before they are resumable.
 */
export async function deriveResumability(
  executionId: ExecutionId,
): Promise<ResumabilityDecision> {
  const store = getExecutionStore(executionId);
  let rawMeta: unknown;
  try {
    rawMeta = await store.read('meta');
  } catch (error) {
    log.debug(
      `Failed to read execution metadata for ${executionId}: ${toErrorMessage(
        error,
      )}`,
    );
    return {
      resumable: false,
      cause: RESUMABILITY_CAUSE.UNREADABLE_META,
    };
  }

  let meta: ExecutionMeta | null = null;
  if (rawMeta != null) {
    const metaResult = ExecutionMetaCoreSchema.safeParse(rawMeta);
    if (!metaResult.success) {
      log.debug(
        `Invalid execution metadata for ${executionId}: ${toErrorMessage(
          metaResult.error,
        )}`,
        { data: metaResult.error },
      );
      return {
        resumable: false,
        cause: RESUMABILITY_CAUSE.INVALID_META,
      };
    }
    meta = metaResult.data;
  }

  const metaFields = { outcome: meta?.outcome };

  const terminalCause = terminalBlockCause(meta);
  if (terminalCause !== undefined) {
    return { resumable: false, cause: terminalCause, ...metaFields };
  }

  let rawFlowRecord: unknown;
  try {
    rawFlowRecord = await store.read(flowKey(executionId));
  } catch (error) {
    log.debug(
      `Failed to read flow record for ${executionId}: ${toErrorMessage(error)}`,
    );
    return {
      resumable: false,
      cause: RESUMABILITY_CAUSE.UNREADABLE_FLOW,
      ...metaFields,
    };
  }

  if (rawFlowRecord === undefined) {
    return {
      resumable: false,
      cause: RESUMABILITY_CAUSE.MISSING_FLOW,
      ...metaFields,
    };
  }

  const flowResult = ResumableFlowRecordSchema.safeParse(rawFlowRecord);
  if (!flowResult.success) {
    return {
      resumable: false,
      cause: RESUMABILITY_CAUSE.INVALID_FLOW,
      ...metaFields,
    };
  }

  return {
    resumable: true,
    cause:
      meta?.outcome === RUN_OUTCOME.CANCELLED
        ? RESUMABILITY_CAUSE.INTERRUPTED_WITH_FLOW
        : RESUMABILITY_CAUSE.MISSING_TERMINAL_WITH_FLOW,
    flowRecord: flowResult.data,
    ...metaFields,
  };
}

/**
 * Resumability as offered to a person.
 *
 * `deriveResumability` reads durable state only, and durable state cannot
 * distinguish "interrupted with a checkpoint" from "running right now": the
 * flow record is written at flow start and removed only in `runToolUseFlow`'s
 * finally block, while `meta.outcome` is stamped at finalization. A live run
 * therefore has a flow record and no outcome — exactly the resumable shape —
 * so every listing that showed the durable decision advertised running work as
 * resumable.
 *
 * Liveness is asked here, once, through `inspectExecutionLease` (the kernel
 * proof — no second probe path). An unclassifiable lease fails closed and
 * loudly: without proof that nobody owns the run, offering it would invite a
 * double resume.
 *
 * Admission is unchanged and stays the caller's: `texra resume` already
 * refuses an owned or foreign lease before loading resume state, and the
 * in-process resume paths (`retrieveSessionResumeData`, restart repair,
 * shutdown checkpoint detection) run while the current host legitimately owns
 * the lease, so they keep using `deriveResumability` directly.
 */
export async function deriveOfferableResumability(
  executionId: ExecutionId,
): Promise<ResumabilityDecision> {
  const decision = await deriveResumability(executionId);
  if (!decision.resumable) return decision;

  let lease: ExecutionLeasePresence;
  try {
    lease = await inspectExecutionLease(executionId);
  } catch (error) {
    log.warn(
      `Cannot classify ownership of ${executionId}; not offering it as resumable`,
      { data: error },
    );
    return {
      resumable: false,
      cause: RESUMABILITY_CAUSE.UNREADABLE_LEASE,
      outcome: decision.outcome,
    };
  }

  if (lease.status === 'owned' || lease.status === 'foreign') {
    return {
      resumable: false,
      cause: RESUMABILITY_CAUSE.ACTIVE_LEASE,
      outcome: decision.outcome,
    };
  }
  return decision;
}
