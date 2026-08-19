// Test-only builders for a projected CLI tool row.
//
// Since the CLI paints from `@shared/transcript`, a tool `ConversationEntry`
// is a normalized payload plus the shared fold over it — exactly what
// `projectTranscriptRow` hands the painter. Suites that hand-build tool rows
// (ToolRenderers, ConversationTranscript, SubagentListDisplay,
// StaticBandResize, TuiStateAndFocus) construct them here so the payload and
// its model can never drift apart in a fixture.

import type { ConversationEntry } from '@cli/chat/tui/state/cliState';
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
  type ToolRow,
} from '@shared/transcript';

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

export function toolRowFixture(
  id: string,
  toolUse: Partial<NormalizedToolUse> & { readonly toolName: string },
): ToolRow {
  const normalized = toolUseFixture(toolUse);
  return {
    kind: 'tool',
    id,
    timestamp: 0,
    level: 'info',
    toolUse: normalized,
    model: toolRowModel(normalized),
  };
}

export function toolConversationEntry(
  id: string,
  toolUse: Partial<NormalizedToolUse> & { readonly toolName: string },
  finalized = false,
): Extract<ConversationEntry, { role: 'tool' }> {
  const row = toolRowFixture(id, toolUse);
  return { id, role: 'tool', text: '', finalized, toolUse: row.toolUse, row };
}

/** An attachment-load row, projected the way the fold projects one so the
 *  summary line and the per-file statuses come from the real projector. */
export function fileListConversationEntry(
  id: string,
  files: readonly FileListEntry[],
  category = 'media',
): Extract<ConversationEntry, { role: 'media' }> {
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
    throw new Error('fileListConversationEntry: expected a fileList row');
  }
  return { id, role: 'media', text: row.summary, finalized: true, row };
}
