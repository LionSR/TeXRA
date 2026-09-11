/** Completed-run display reads, keyed by run id. */
import { Effect } from 'effect';
import type { ExportNode } from '@agent/export/schemas';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { formatToolResultAsText } from '@agent/modelHandlers/utils/toolAttachmentUtils';
import { stringifyConversationValue } from '@agent/storage/conversationFormat';

import {
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  TOOL_CALL_STATUS,
  ToolResultSchema,
  type RunId,
  type StreamLogEntry,
  type StreamLogEntryOf,
  type TodoItem,
  type ToolUseLog,
} from '@shared/schemas';
import { assertNever, isObject } from '@utils/core';

/** Read completed tasks from the session's committed run fold. */
export const readCompletedRunTodos = Effect.fn('readCompletedRunTodos')(
  function* (
    runId: RunId,
    session: SessionHandle,
  ): Effect.fn.Return<readonly TodoItem[], Error> {
    const snapshot = yield* session.snapshots.read(runId);
    return snapshot.todos;
  },
);

// ============================================================================
// Conversation
// ============================================================================

type CompletedRunConversationSource = 'streamLog' | 'none';

export interface CompletedRunConversationReadResult {
  /** Typed conversation nodes, or `null` when the transcript holds no
   *  conversation data. */
  readonly conversation: ExportNode[] | null;
  readonly source: CompletedRunConversationSource;
}

/** Whether completed-run storage proves a conversation or transcript association exists. */
export function hasCompletedRunConversationEvidence(
  result: CompletedRunConversationReadResult,
): boolean {
  return (result.conversation?.length ?? 0) > 0;
}

/**
 * Deliberate non-goal (#7508): image blocks inside a tool result are not
 * reconstructed here. `ToolUseLog.output` carries either historical display
 * text or the attachment-stripped `ToolResult` fields; attachment bytes never
 * reach the transcript row, and the `tool-result` node is `{text}` only.
 */
function toolResultText(tool: ToolUseLog): string | undefined {
  if (tool.error !== undefined) return tool.error;
  if (typeof tool.output === 'string') return tool.output;
  if (isObject(tool.output)) {
    const result = ToolResultSchema.safeParse({
      ...tool.output,
      status: tool.status === TOOL_CALL_STATUS.FAILED ? 'error' : 'executed',
    });
    if (result.success) return formatToolResultAsText(result.data);
  }
  if (tool.output !== undefined) return stringifyConversationValue(tool.output);
  return tool.summary;
}

/**
 * `userMessage` rows may carry an attachment-kind list (#7508): media that
 * was sent to the model but only ever lived in the provider message. Each
 * kind becomes an attachment part (no bytes) after the text.
 */
function userMessageNodes(
  entry: StreamLogEntryOf<typeof MESSAGE_TYPES.USER_MESSAGE>,
): ExportNode[] {
  if (!entry.text) return [];
  return [
    {
      kind: 'user-message',
      parts: [
        { type: 'text', text: entry.text },
        ...(entry.data?.attachments ?? []).map((attachmentType) => ({
          type: 'attachment' as const,
          attachmentType,
        })),
      ],
    },
  ];
}

function toolUseNodes(
  entry: StreamLogEntryOf<typeof MESSAGE_TYPES.TOOL_USE>,
): ExportNode[] {
  const tool = entry.data;
  const nodes: ExportNode[] = [
    {
      kind: 'tool-call',
      name: tool.toolName ?? 'unknown',
      input: tool.input ?? {},
    },
  ];
  const text = toolResultText(tool);
  if (text !== undefined) nodes.push({ kind: 'tool-result', text });
  return nodes;
}

function webSearchNodes(
  entry: StreamLogEntryOf<typeof MESSAGE_TYPES.WEB_SEARCH>,
): ExportNode[] {
  const { query, results = [] } = entry.data;
  const hits = results.flatMap(({ title, url }) =>
    url ? [{ title: title || url, url }] : [],
  );
  return [
    ...(query ? [{ kind: 'web-search' as const, query }] : []),
    ...(hits.length > 0
      ? [{ kind: 'web-search-results' as const, results: hits }]
      : []),
  ];
}

/**
 * Map one transcript row to conversation nodes. Exhaustive over the
 * {@link MessageType} union: the transcript is the single completed-run
 * record, so every entry kind must carry an explicit map-or-skip decision
 * here; adding a new `MessageType` without deciding fails to compile
 * (`assertNever`), instead of silently dropping conversation content.
 */
function conversationNodesForEntry(entry: StreamLogEntry): ExportNode[] {
  const { messageType } = entry;
  if (messageType === undefined) return [];
  switch (messageType) {
    // ── Conversation content ────────────────────────────────────────────
    case MESSAGE_TYPES.USER_MESSAGE:
      return userMessageNodes(entry);
    case MESSAGE_TYPES.MODEL_RESPONSE:
      return entry.text?.trim()
        ? [{ kind: 'assistant-text', text: entry.text }]
        : [];
    case MESSAGE_TYPES.THINKING:
      return entry.text?.trim() ? [{ kind: 'thinking', text: entry.text }] : [];
    case MESSAGE_TYPES.TOOL_USE:
      return toolUseNodes(entry);
    case MESSAGE_TYPES.WEB_SEARCH:
      return webSearchNodes(entry);
    case MESSAGE_TYPES.WEB_FETCH: {
      // Failed fetches carry no title/content; the node keeps only the url.
      const { url, title, content } = entry.data;
      return url ? [{ kind: 'web-fetch', url, title, content }] : [];
    }
    // ── Deliberately skipped: not conversation content ──────────────────
    // scratchpad is a derived view carved from the modelResponse raw text
    // (already mapped above); the rest are run diagnostics/status rows, not
    // conversation content.
    case MESSAGE_TYPES.SCRATCHPAD:
    case MESSAGE_TYPES.FILE_LIST:
    case MESSAGE_TYPES.MISSING_OUTPUTS:
    case MESSAGE_TYPES.LATEXDIFF:
    case MESSAGE_TYPES.STATISTICS:
    case MESSAGE_TYPES.PROGRESS_STATUS:
    case MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY:
    case MESSAGE_TYPES.ERROR:
    case MESSAGE_TYPES.INTERNAL:
    case MESSAGE_TYPES.CONTEXT_MANAGEMENT:
    case MESSAGE_TYPES.CONTEXT_STATE:
    case MESSAGE_TYPES.ACTIVE_SKILLS:
    case MESSAGE_TYPES.WORKFLOW_TASK:
    case MESSAGE_TYPES.DEFAULT:
      return [];
    default:
      return assertNever(
        messageType,
        `Unmapped stream-log messageType: ${String(messageType)}`,
      );
  }
}

/**
 * Read a completed run's conversation from the canonical transcript fold as
 * the typed nodes every conversation view (chat export, the ExecutionsTool
 * endpoint, the CLI history views) renders.
 */
export const readCompletedRunConversation = Effect.fn(
  'readCompletedRunConversation',
)(function* (
  runId: RunId,
  session: SessionHandle,
): Effect.fn.Return<CompletedRunConversationReadResult, Error> {
  const conversation = (yield* session.transcripts.readEntries(runId)).flatMap(
    (entry) =>
      entry.type === STREAM_LOG_ENTRY_TYPES.LOG
        ? conversationNodesForEntry(entry)
        : [],
  );
  return conversation.length > 0
    ? { conversation, source: 'streamLog' }
    : { conversation: null, source: 'none' };
});
