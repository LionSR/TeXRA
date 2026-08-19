// Test-only builders for a projected CLI transcript row.
//
// The CLI paints `@shared/transcript` rows directly, so a tool row is a
// normalized payload plus the shared fold over it — exactly what
// `projectTranscriptRow` hands the painter. Suites that hand-build rows
// (ToolRenderers, ConversationTranscript, SubagentListDisplay,
// StaticBandResize, TuiStateAndFocus) construct them here so the payload and
// its model can never drift apart in a fixture.

import {
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  TOOL_USE_STATUS,
  type FileListEntry,
  type NormalizedToolUse,
} from '@shared/schemas';
import {
  projectTranscriptRow,
  toolRowModel,
  transcriptText,
  type ToolRow,
  type TranscriptRow,
  type TranscriptRowOf,
} from '@shared/transcript';
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
): TranscriptRowOf<'compactionActivity'> {
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

/** An attachment-load row, projected the way the fold projects one so the
 *  summary line and the per-file statuses come from the real projector. */
export function fileListRowFixture(
  id: string,
  files: readonly FileListEntry[],
  category = 'media',
): TranscriptRowOf<'fileList'> {
  const row = projectTranscriptRow({
    id,
    type: STREAM_LOG_ENTRY_TYPES.LOG,
    messageType: MESSAGE_TYPES.FILE_LIST,
    seqNo: 0,
    timestamp: 0,
    level: 'info',
    text: category,
    data: [...files],
  });
  if (row?.kind !== 'fileList') {
    throw new Error('fileListRowFixture: expected a fileList row');
  }
  return row;
}
