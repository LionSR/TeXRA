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

/**
 * What the durable run facts alone say about continuing an execution:
 * a valid checkpoint exists, nothing is left to resume, or the storage
 * itself could not be read (reported with its cause, never guessed).
 */
export type ResumabilityDecision =
  | {
      readonly kind: 'checkpoint';
      readonly flowRecord: FlowRecord;
      readonly outcome?: RunOutcome;
    }
  | { readonly kind: 'none'; readonly outcome?: RunOutcome }
  | { readonly kind: 'unreadable'; readonly cause: string };

/**
 * Single storage-owned resumability decision.
 *
 * A checkpoint means exactly one thing: a valid flow record exists. The
 * terminal outcome is read and reported on the decision for display, but it
 * never blocks: a checkpoint is deleted only by the user or by a genuinely
 * completed run, so a failed run that still has one is offered as "retry
 * from the last checkpoint". Ownership is not decided here; `classifyRun`
 * (`@agent/runtime/runClassification`) combines this decision with the
 * execution lease.
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
      kind: 'unreadable',
      cause: `execution metadata could not be read (${toErrorMessage(error)})`,
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
      return { kind: 'unreadable', cause: 'execution metadata is malformed' };
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
      kind: 'unreadable',
      cause: `checkpoint could not be read (${toErrorMessage(error)})`,
    };
  }

  if (rawFlowRecord === undefined) {
    return { kind: 'none', ...metaFields };
  }

  const flowResult = ResumableFlowRecordSchema.safeParse(rawFlowRecord);
  if (!flowResult.success) {
    // A present-but-malformed checkpoint is corruption, not an absent run.
    return { kind: 'unreadable', cause: 'checkpoint is malformed' };
  }

  return { kind: 'checkpoint', flowRecord: flowResult.data, ...metaFields };
}
