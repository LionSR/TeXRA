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
);

export const RESUMABILITY_CAUSE = {
  INTERRUPTED_WITH_FLOW: 'interrupted-with-flow',
  MISSING_TERMINAL_WITH_FLOW: 'missing-terminal-with-flow',
  MISSING_FLOW: 'missing-flow',
  INVALID_FLOW: 'invalid-flow',
  INVALID_META: 'invalid-meta',
  UNREADABLE_FLOW: 'unreadable-flow',
  UNREADABLE_META: 'unreadable-meta',
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
 * decided here; `classifyRun` (`@agent/runtime/runClassification`) combines
 * this decision with the execution lease.
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
