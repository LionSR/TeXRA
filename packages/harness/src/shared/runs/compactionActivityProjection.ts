import { Result, Schema } from 'effect';

import {
  CompactionActivityDataSchema,
  MESSAGE_TYPES,
  type CompactionActivityData,
  type CompactionActivityOutcome,
  type TraceRowFields,
} from '@shared/schemas';

export type CompactionActivityStatus =
  | 'running'
  | CompactionActivityOutcome
  | 'interrupted';

/** One stable transcript block projected from a correlated activity
 *  lifecycle; its status says what else it carries. */
export type CompactionActivityBlock = {
  readonly operationId: string;
  readonly startPosition: number;
  readonly startedAt: number;
} & (
  | { readonly status: 'running' }
  | {
      readonly status: 'interrupted';
      /** The result boundary that finalized an unmatched start; absent
       *  while a later row only moved past it, when its outcome may still
       *  replace the interruption. */
      readonly finalThroughSeqNo?: number;
    }
  | {
      readonly status: 'completed';
      /** What the compaction freed. */
      readonly freed: Extract<
        CompactionActivityData,
        { state: 'completed' }
      >['freed'];
      /** How many messages an edit the agent asked for replaced; absent
       *  for a summary. */
      readonly replaced?: number;
    }
  | { readonly status: 'failed' | 'cancelled' | 'skipped' }
);

/** Whether the block may move into finalized transcript output: it reached
 *  an outcome, or the result boundary interrupted it. */
export function isCompactionActivityFinal(
  block: CompactionActivityBlock,
): boolean {
  switch (block.status) {
    case 'running':
      return false;
    case 'interrupted':
      return block.finalThroughSeqNo !== undefined;
    default:
      return true;
  }
}

export const COMPACTION_ACTIVITY_LABEL: Record<
  CompactionActivityStatus,
  string
> = Object.freeze({
  running: 'Compacting context…',
  completed: 'Context compacted',
  failed: 'Context compaction failed',
  cancelled: 'Context compaction cancelled',
  skipped: 'Context compaction was not needed',
  interrupted: 'Context compaction interrupted',
});

export interface CompactionActivityProjection {
  readonly blocks: CompactionActivityBlock[];
  readonly indexByOperationId: Map<string, number>;
  maxAppliedSeqNo: number;
}

/** A later row that moves the stream past a compaction still running. */
function interruptRunningBlocks(
  projection: CompactionActivityProjection,
  position: number,
): readonly number[] {
  const changedIndices: number[] = [];
  for (const [index, block] of projection.blocks.entries()) {
    if (block.status !== 'running' || position <= block.startPosition) {
      continue;
    }
    projection.blocks[index] = { ...block, status: 'interrupted' };
    changedIndices.push(index);
  }
  return changedIndices;
}

/**
 * Apply one transcript event to the projection, in source order. `position`
 * is the seqNo of the row the event wrote: a tool event's is the tool row's
 * first-seen position, so a tool that started before a compaction and ended
 * after it never interrupts it. `at` is the event's clock.
 */
export function applyCompactionActivityEvent(
  projection: CompactionActivityProjection,
  event: TraceRowFields,
  position: number,
  at: number,
): readonly number[] {
  projection.maxAppliedSeqNo = Math.max(projection.maxAppliedSeqNo, position);
  if (event.type === 'tool.start' || event.type === 'tool.end') {
    return interruptRunningBlocks(projection, position);
  }
  if (event.type !== 'log') return [];
  switch (event.messageType) {
    case MESSAGE_TYPES.USER_MESSAGE:
    case MESSAGE_TYPES.ERROR:
      return interruptRunningBlocks(projection, position);
    case MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY:
      break;
    default:
      return [];
  }
  const activity = Schema.decodeUnknownResult(CompactionActivityDataSchema)(
    event.data,
  );
  // A payload its schema rejects moves nothing here; the transcript fold
  // writes it as an error row (`transcriptLogRows.ts`).
  if (!Result.isSuccess(activity)) return [];
  const outcome = activity.success;
  const { operationId } = outcome;
  const existingIndex = projection.indexByOperationId.get(operationId);

  if (outcome.state === 'started') {
    if (existingIndex !== undefined) return [];
    const index = projection.blocks.length;
    projection.indexByOperationId.set(operationId, index);
    projection.blocks.push({
      operationId,
      status: 'running',
      startPosition: position,
      startedAt: at,
    });
    return [index];
  }

  // A terminal event without its start is ambiguous and must not create a
  // phantom transcript row. An outcome queued before result may still
  // replace its provisional interruption; one appended afterward may not.
  if (existingIndex === undefined) return [];
  const block = projection.blocks[existingIndex];
  const replaceable =
    block.status === 'running' ||
    (block.status === 'interrupted' &&
      (block.finalThroughSeqNo === undefined ||
        position <= block.finalThroughSeqNo));
  if (!replaceable) return [];
  const start = {
    operationId,
    startPosition: block.startPosition,
    startedAt: block.startedAt,
  };
  projection.blocks[existingIndex] =
    outcome.state === 'completed'
      ? {
          ...start,
          status: 'completed',
          freed: outcome.freed,
          ...(outcome.replaced !== undefined && {
            replaced: outcome.replaced,
          }),
        }
      : { ...start, status: outcome.state };
  return [existingIndex];
}

/**
 * Finalize every start the projection has seen, at the result boundary the
 * events themselves drew: `maxAppliedSeqNo`, the newest row position applied.
 */
export function finalizeCompactionActivities(
  projection: CompactionActivityProjection,
): readonly number[] {
  const throughSeqNo = projection.maxAppliedSeqNo;
  const changedIndices: number[] = [];
  for (const [index, block] of projection.blocks.entries()) {
    if (isCompactionActivityFinal(block) || block.startPosition > throughSeqNo)
      continue;
    projection.blocks[index] = {
      operationId: block.operationId,
      startPosition: block.startPosition,
      startedAt: block.startedAt,
      status: 'interrupted',
      finalThroughSeqNo: throughSeqNo,
    };
    changedIndices.push(index);
  }
  return changedIndices;
}
