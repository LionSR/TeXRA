// Test-only builders for stream-log projections the suites replay.
//
// The CLI paints `@shared/transcript` rows directly, so a tool row is a
// normalized payload plus the shared fold over it — exactly what
// `projectTranscriptRow` hands the painter. Suites that hand-build rows
// (ToolRenderers, ConversationTranscript, SubagentListDisplay,
// StaticBandResize, TuiStateAndFocus) construct them here so the payload and
// its model can never drift apart in a fixture. The task-group replay below
// has the same shape as one projection: entries folded through the production
// reducer.

import {
  orderedStaticTranscriptEntries,
  pendingTranscriptEntries,
} from '@cli/chat/tui/panes/transcriptEntries';
import {
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  TOOL_USE_STATUS,
  type FileListEntry,
  type NormalizedToolUse,
  type StreamLogEntry,
  type StreamPhase,
  type TaskGroup,
} from '@shared/schemas';
import {
  projectTranscriptRow,
  toolRowModel,
  transcriptText,
  type ToolRow,
  type TranscriptRow,
  type CompactionActivityRow,
  type FileListRow,
  type PhaseRow,
} from '@shared/transcript';
import { upsertTaskGroupFromStreamLog } from '@shared/streams/taskGroupProjection';
import type { CompactionActivityStatus } from '@shared/streams/compactionActivityProjection';
import { COMPACTION_ACTIVITY_LABEL } from '@shared/streams/compactionActivityProjection';

/** A normalized tool-use payload with every field a caller did not name
 *  defaulted to its empty/successful value. */
function toolUseFixture(
  toolUse: Partial<NormalizedToolUse> & { readonly toolName: string },
): NormalizedToolUse {
  return {
    errorText: '',
    outputText: '',
    userInstructionText: '',
    input: {},
    isError: false,
    isUserFeedback: false,
    headerSummary: '',
    status: TOOL_USE_STATUS.COMPLETED,
    ...toolUse,
  };
}

/** `settlementSeqNo` is the durable "this row is printable" order the recorder
 *  assigns; pass one to build a row the CLI treats as settled on arrival. */
export function toolRowFixture(
  id: string,
  toolUse: Partial<NormalizedToolUse> & { readonly toolName: string },
  settlementSeqNo?: number,
): ToolRow {
  const normalized = toolUseFixture(toolUse);
  return {
    kind: 'tool',
    id,
    timestamp: 0,
    level: 'info',
    ...(settlementSeqNo !== undefined ? { settlementSeqNo } : {}),
    toolUse: normalized,
    model: toolRowModel(normalized),
  };
}

/**
 * A text-bearing transcript row. `settlementSeqNo` is the durable order the
 * recorder assigns when a row becomes printable — the suites that want a row
 * the CLI treats as settled on arrival pass one.
 */
export function textRowFixture(
  id: string,
  kind: 'assistant' | 'error' | 'user' | 'log',
  text: string,
  settlementSeqNo?: number,
): TranscriptRow {
  const base = {
    id,
    timestamp: 0,
    ...(settlementSeqNo !== undefined ? { settlementSeqNo } : {}),
  } as const;
  const body = transcriptText(text);
  switch (kind) {
    case 'error':
      return {
        ...base,
        level: 'error',
        kind: 'error',
        summary: body,
        details: [],
        detailText: transcriptText(''),
      };
    case 'user':
      return {
        ...base,
        level: 'info',
        kind: 'user',
        text: body,
        summary: body,
      };
    case 'log':
      return { ...base, level: 'info', kind: 'log', text: body };
    case 'assistant':
      return {
        ...base,
        level: 'info',
        kind: 'assistant',
        text: body,
        streaming: false,
      };
  }
}

/** A compaction-activity row, built the way `compactionActivityRow` builds one. */
export function compactionRowFixture(
  status: CompactionActivityStatus,
  finalized = status === 'completed',
): CompactionActivityRow {
  return {
    kind: 'compactionActivity',
    id: 'compaction:operation-1',
    seqNo: 1,
    timestamp: 100,
    level: 'info',
    label: COMPACTION_ACTIVITY_LABEL[status],
    block: {
      operationId: 'operation-1',
      status,
      finalized,
      startPosition: 1,
      startedAt: 100,
      ...(status !== 'running' ? { finishedAt: 200 } : {}),
    },
  };
}

/** Test-local full replay through the production reducer (the resync path). */
export function projectTaskGroupsFromStreamLog(
  entries: Iterable<StreamLogEntry>,
): TaskGroup[] {
  const taskGroups: TaskGroup[] = [];
  const taskGroupIndex = new Map<string, number>();
  for (const entry of entries) {
    upsertTaskGroupFromStreamLog(taskGroups, taskGroupIndex, entry);
  }
  return taskGroups;
}

/** The CLI's two panes' rows for one slice: the settled `<Static>` prefix and
 *  the live rows. Production reads each half from its own pane; suites that
 *  assert on the partition read both here. */
export function splitTranscriptEntries(
  entries: readonly TranscriptRow[],
  finalizedFrontier: number,
  status: StreamPhase | undefined,
): {
  readonly finalized: readonly TranscriptRow[];
  readonly pending: readonly TranscriptRow[];
} {
  return {
    finalized: orderedStaticTranscriptEntries(
      entries,
      finalizedFrontier,
      status,
    ),
    pending: pendingTranscriptEntries(entries, finalizedFrontier, status),
  };
}
