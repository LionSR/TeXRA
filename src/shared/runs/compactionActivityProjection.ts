import {
  CompactionActivityDataSchema,
  ContextManagementDataSchema,
  MESSAGE_TYPES,
  type CompactionActivityOutcome,
  type TranscriptEvent,
} from '@shared/schemas';

export type CompactionActivityStatus =
  'running' | CompactionActivityOutcome | 'interrupted';

/** One stable transcript block projected from a correlated activity lifecycle. */
export interface CompactionActivityBlock {
  readonly operationId: string;
  readonly status: CompactionActivityStatus;
  /** Whether the block may move into finalized transcript output. */
  readonly finalized: boolean;
  /** Source-log boundary that finalized an otherwise unmatched start. */
  readonly settledThroughSeqNo?: number;
  readonly startPosition: number;
  readonly startedAt: number;
  readonly finishedAt?: number;
  /** What the compaction freed, from the `compaction` context-management
   *  entry the run writes just before the activity completes. */
  readonly freed?: {
    readonly tokens: number;
    readonly utilizationBefore: number;
    readonly utilizationAfter: number;
  };
}

export const COMPACTION_ACTIVITY_LABEL: Record<
  CompactionActivityStatus,
  string
> = {
  running: 'Compacting context…',
  completed: 'Context compacted',
  failed: 'Context compaction failed',
  cancelled: 'Context compaction cancelled',
  skipped: 'Context compaction was not needed',
  interrupted: 'Context compaction interrupted',
};

export interface CompactionActivityProjection {
  readonly blocks: CompactionActivityBlock[];
  readonly indexByOperationId: Map<string, number>;
  maxAppliedSeqNo: number;
}

/** Fresh mutable working state for incremental activity projection. */
export function createCompactionActivityProjection(): CompactionActivityProjection {
  return { blocks: [], indexByOperationId: new Map(), maxAppliedSeqNo: 0 };
}

/** A later row that moves the stream past a compaction still running. */
function interruptRunningBlocks(
  projection: CompactionActivityProjection,
  position: number,
  at: number,
): readonly number[] {
  const changedIndices: number[] = [];
  for (const [index, block] of projection.blocks.entries()) {
    if (block.status !== 'running' || position <= block.startPosition) {
      continue;
    }
    projection.blocks[index] = {
      ...block,
      status: 'interrupted',
      finishedAt: at,
    };
    changedIndices.push(index);
  }
  return changedIndices;
}

/** The figures a `compaction` context-management payload freed, carried by
 *  the one activity row: the latest running block. */
function applyFreed(
  projection: CompactionActivityProjection,
  payload: unknown,
): readonly number[] {
  // A payload its schema rejects moves nothing here; the transcript fold
  // writes it as an error row (`traceFold`).
  const parsed = ContextManagementDataSchema.safeParse(payload);
  if (!parsed.success || parsed.data.action !== 'compaction') return [];
  const index = projection.blocks.findLastIndex(
    (block) => block.status === 'running',
  );
  if (index === -1) return [];
  const { data } = parsed;
  projection.blocks[index] = {
    ...projection.blocks[index],
    freed: {
      tokens: data.tokensBefore - data.tokensAfter,
      utilizationBefore: data.utilizationBefore,
      utilizationAfter: data.utilizationAfter,
    },
  };
  return [index];
}

/**
 * Apply one transcript event to the projection, in source order. `position`
 * is the seqNo of the row the event wrote: a tool event's is the tool row's
 * first-seen position, so a tool that started before a compaction and ended
 * after it never interrupts it. `at` is the event's clock.
 */
export function applyCompactionActivityEvent(
  projection: CompactionActivityProjection,
  event: TranscriptEvent,
  position: number,
  at: number,
): readonly number[] {
  projection.maxAppliedSeqNo = Math.max(projection.maxAppliedSeqNo, position);
  if (event.type === 'tool.start' || event.type === 'tool.end') {
    return interruptRunningBlocks(projection, position, at);
  }
  if (event.type === 'domain') {
    return event.key === 'contextManagement'
      ? applyFreed(projection, event.data)
      : [];
  }
  if (event.type !== 'log') return [];
  switch (event.messageType) {
    case MESSAGE_TYPES.USER_MESSAGE:
    case MESSAGE_TYPES.ERROR:
      return interruptRunningBlocks(projection, position, at);
    case MESSAGE_TYPES.CONTEXT_MANAGEMENT:
      return applyFreed(projection, event.data);
    case MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY:
      break;
    default:
      return [];
  }
  const activity = CompactionActivityDataSchema.safeParse(event.data);
  if (!activity.success) return []; // an error row, like applyFreed
  const { operationId, state } = activity.data;
  const existingIndex = projection.indexByOperationId.get(operationId);

  if (state === 'started') {
    if (existingIndex !== undefined) return [];
    const index = projection.blocks.length;
    projection.indexByOperationId.set(operationId, index);
    projection.blocks.push({
      operationId,
      status: 'running',
      finalized: false,
      startPosition: position,
      startedAt: at,
    });
    return [index];
  }

  // A terminal event without its start is ambiguous and must not create a
  // phantom transcript row. An outcome queued before settlement may still
  // replace its provisional interruption; one appended afterward may not.
  if (existingIndex === undefined) return [];
  const block = projection.blocks[existingIndex];
  const withinSettlementBoundary =
    block.status === 'interrupted' &&
    block.settledThroughSeqNo !== undefined &&
    position <= block.settledThroughSeqNo;
  if (block.finalized && !withinSettlementBoundary) return [];
  const { settledThroughSeqNo: _settledThroughSeqNo, ...unsettledBlock } =
    block;
  projection.blocks[existingIndex] = {
    ...unsettledBlock,
    status: state,
    finalized: true,
    finishedAt: at,
  };
  return [existingIndex];
}

/**
 * Finalize every start the projection has seen, at the settlement boundary the
 * events themselves drew: `maxAppliedSeqNo`, the newest row position applied.
 */
export function settleCompactionActivities(
  projection: CompactionActivityProjection,
  finishedAt: number,
): readonly number[] {
  const throughSeqNo = projection.maxAppliedSeqNo;
  const changedIndices: number[] = [];
  for (const [index, block] of projection.blocks.entries()) {
    if (block.finalized || block.startPosition > throughSeqNo) continue;
    projection.blocks[index] = {
      ...block,
      status: 'interrupted',
      finalized: true,
      settledThroughSeqNo: throughSeqNo,
      ...(block.finishedAt === undefined ? { finishedAt } : {}),
    };
    changedIndices.push(index);
  }
  return changedIndices;
}
