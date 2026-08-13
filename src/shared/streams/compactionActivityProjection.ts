import {
  CompactionActivityDataSchema,
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

/** Validate a projected block at a host rendering boundary. */
export function isCompactionActivityBlock(
  value: unknown,
): value is CompactionActivityBlock {
  if (typeof value !== 'object' || value === null) return false;
  const block = value as Record<string, unknown>;
  return (
    typeof block.operationId === 'string' &&
    block.operationId.length > 0 &&
    typeof block.status === 'string' &&
    Object.hasOwn(COMPACTION_ACTIVITY_LABEL, block.status) &&
    typeof block.finalized === 'boolean' &&
    (block.settledThroughSeqNo === undefined ||
      typeof block.settledThroughSeqNo === 'number') &&
    typeof block.startPosition === 'number' &&
    typeof block.startedAt === 'number' &&
    (block.finishedAt === undefined || typeof block.finishedAt === 'number')
  );
}

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
  if (!STREAM_ADVANCING_MESSAGE_TYPES.has(entry.messageType ?? '')) return;
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

/** Apply raw stream-log entries to an existing projection in source order. */
export function applyCompactionActivityEntries(
  projection: CompactionActivityProjection,
  entries: readonly StreamLogEntry[],
): readonly number[] {
  const changedIndices = new Set<number>();

  for (const entry of entries) {
    projection.maxAppliedSeqNo = Math.max(
      projection.maxAppliedSeqNo,
      entry.seqNo,
    );
    if (entry.messageType !== MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY) {
      interruptRunningBlocks(projection, entry, changedIndices);
      continue;
    }

    const parsed = CompactionActivityDataSchema.safeParse(entry.data);
    if (!parsed.success) continue;
    const { operationId, state } = parsed.data;
    const existingIndex = projection.indexByOperationId.get(operationId);

    if (state === 'started') {
      if (existingIndex !== undefined) continue;
      const index = projection.blocks.length;
      projection.indexByOperationId.set(operationId, index);
      projection.blocks.push({
        operationId,
        status: 'running',
        finalized: false,
        startPosition: entry.seqNo,
        startedAt: entry.timestamp,
      });
      changedIndices.add(index);
      continue;
    }

    // A terminal event without its start is ambiguous and must not create a
    // phantom transcript row. An outcome queued before settlement may still
    // replace its provisional interruption; one appended afterward may not.
    if (existingIndex === undefined) continue;
    const block = projection.blocks[existingIndex];
    const withinSettlementBoundary =
      block.status === 'interrupted' &&
      block.settledThroughSeqNo !== undefined &&
      entry.seqNo <= block.settledThroughSeqNo;
    if (block.finalized && !withinSettlementBoundary) continue;
    const { settledThroughSeqNo: _settledThroughSeqNo, ...unsettledBlock } =
      block;
    projection.blocks[existingIndex] = {
      ...unsettledBlock,
      status: state,
      finalized: true,
      finishedAt: entry.timestamp,
    };
    changedIndices.add(existingIndex);
  }

  return [...changedIndices];
}

/** Finalize starts covered by one canonical source-log settlement boundary. */
export function settleCompactionActivities(
  projection: CompactionActivityProjection,
  options: {
    readonly throughSeqNo?: number;
    readonly finishedAt?: number;
  },
): readonly number[] {
  const throughSeqNo = options.throughSeqNo ?? projection.maxAppliedSeqNo;
  const changedIndices: number[] = [];
  for (const [index, block] of projection.blocks.entries()) {
    if (block.finalized || block.startPosition > throughSeqNo) continue;
    projection.blocks[index] = {
      ...block,
      status: 'interrupted',
      finalized: true,
      settledThroughSeqNo: throughSeqNo,
      ...(block.finishedAt === undefined && options.finishedAt !== undefined
        ? { finishedAt: options.finishedAt }
        : {}),
    };
    changedIndices.push(index);
  }
  return changedIndices;
}
