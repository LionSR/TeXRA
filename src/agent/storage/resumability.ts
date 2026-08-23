import { z } from 'zod';

import {
  PersistedFlowRecordEnvelopeSchema,
  flowKey,
  type FlowRecord,
} from '@agent/node/persistedFlow';
import { createLog } from '@logger/logUtils';
import {
  ExecutionMetaCoreSchema,
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
).refine((record) => record.cursor.nextNodeId !== null, {
  // A run that ended leaves a spent cursor; only a rewound record (cancelled
  // or failed exits rewind to the start node) is a checkpoint to continue.
  message: 'A spent cursor is not a resumable checkpoint',
  path: ['cursor', 'nextNodeId'],
});

export const RESUMABILITY_CAUSE = {
  INTERRUPTED_WITH_FLOW: 'interrupted-with-flow',
  MISSING_TERMINAL_WITH_FLOW: 'missing-terminal-with-flow',
  MISSING_FLOW: 'missing-flow',
  INVALID_FLOW: 'invalid-flow',
  INVALID_META: 'invalid-meta',
  UNREADABLE_FLOW: 'unreadable-flow',
  UNREADABLE_META: 'unreadable-meta',
  /**
   * The execution's lease is still held, so it is not waiting to be resumed.
   * `inspectExecutionLease` reports `foreign` for any owner it cannot prove
   * dead, so this covers both a demonstrably live host and an owner whose
   * liveness is merely unprovable — both fail closed for the same reason.
   */
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

/**
 * Single storage-owned resumability decision.
 *
 * Resumable means exactly one thing: a valid flow record (the resume
 * checkpoint) exists. The terminal outcome is read and reported on the
 * decision for display, but it never blocks: a checkpoint is deleted only by
 * the user or by a genuinely completed run, so a failed run that still has
 * one is offered as "retry from the last checkpoint". Ownership is not
 * decided here; see {@link deriveOfferableResumability}.
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
      meta?.outcome == null
        ? RESUMABILITY_CAUSE.MISSING_TERMINAL_WITH_FLOW
        : RESUMABILITY_CAUSE.INTERRUPTED_WITH_FLOW,
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
