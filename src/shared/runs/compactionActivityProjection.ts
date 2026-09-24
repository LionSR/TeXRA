import {
  MESSAGE_TYPES,
  type CompactionActivityOutcome,
  type StreamLogEntry,
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

const STREAM_ADVANCING_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  MESSAGE_TYPES.USER_MESSAGE,
  MESSAGE_TYPES.TOOL_USE,
  MESSAGE_TYPES.ERROR,
]);

function interruptRunningBlocks(
  projection: CompactionActivityProjection,
  entry: StreamLogEntry,
  changedIndices: Set<number>,
): void {
  if (!STREAM_ADVANCING_MESSAGE_TYPES.has(entry.messageType)) return;
  for (const [index, block] of projection.blocks.entries()) {
    if (block.status !== 'running' || entry.seqNo <= block.startPosition) {
      continue;
    }
    projection.blocks[index] = {
      ...block,
      status: 'interrupted',
      finishedAt: entry.timestamp,
    };
    changedIndices.add(index);
  }
}

/** Apply one raw stream-log entry to an existing projection, in source order. */
export function applyCompactionActivityEntry(
  projection: CompactionActivityProjection,
  entry: StreamLogEntry,
): readonly number[] {
  const changedIndices = new Set<number>();
  projection.maxAppliedSeqNo = Math.max(
    projection.maxAppliedSeqNo,
    entry.seqNo,
  );
  if (
    entry.messageType === MESSAGE_TYPES.CONTEXT_MANAGEMENT &&
    entry.data.action === 'compaction'
  ) {
    // The figures belong to the one activity row: the latest running block.
    const index = projection.blocks.findLastIndex(
      (block) => block.status === 'running',
    );
    if (index === -1) return [];
    const { data } = entry;
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
  if (entry.messageType !== MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY) {
    interruptRunningBlocks(projection, entry, changedIndices);
    return [...changedIndices];
  }

  const { operationId, state } = entry.data;
  const existingIndex = projection.indexByOperationId.get(operationId);

  if (state === 'started') {
    if (existingIndex !== undefined) return [];
    const index = projection.blocks.length;
    projection.indexByOperationId.set(operationId, index);
    projection.blocks.push({
      operationId,
      status: 'running',
      finalized: false,
      startPosition: entry.seqNo,
      startedAt: entry.timestamp,
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
    entry.seqNo <= block.settledThroughSeqNo;
  if (block.finalized && !withinSettlementBoundary) return [];
  const { settledThroughSeqNo: _settledThroughSeqNo, ...unsettledBlock } =
    block;
  projection.blocks[existingIndex] = {
    ...unsettledBlock,
    status: state,
    finalized: true,
    finishedAt: entry.timestamp,
  };
  return [existingIndex];
}

/**
 * Finalize every start the projection has seen, at the settlement boundary the
 * entries themselves drew: `maxAppliedSeqNo`, the last entry applied.
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
