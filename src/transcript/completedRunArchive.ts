/** Completed-run display reads, keyed by run id. */
import { Effect } from 'effect';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { formatToolResultAsText } from '@agent/modelHandlers/utils/toolAttachmentUtils';
import { stringifyConversationValue } from '@agent/storage/conversationFormat';

import {
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
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
  /** Provider-agnostic `{role, content}` messages, or `null` when the
   *  transcript sidecar holds no conversation data. */
  readonly conversation: unknown[] | null;
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
 * reach the transcript row. Unlike the web-fetch page-content case, there's
 * no existing size-capped/marker-only slot for this in the export pipeline
 * (`ExportNode`'s `tool-result` kind is `{text}` only), and reconstructing one
 * would mean threading attachment bytes through `tool.end` just to summarize
 * them — out of scope here.
 */
function toolResultText(tool: ToolUseLog): string | undefined {
  if (tool.error !== undefined) return tool.error;
  if (typeof tool.output === 'string') return tool.output;
  if (isObject(tool.output)) {
    const result = ToolResultSchema.safeParse({
      ...tool.output,
      status: tool.isError ? 'error' : 'executed',
    });
    if (result.success) return formatToolResultAsText(result.data);
  }
  if (tool.output !== undefined) return stringifyConversationValue(tool.output);
  return tool.summary;
}

/**
 * `userMessage` rows may carry an attachment-kind/count payload (#7508) —
 * media that was sent to the model but only ever lived in the provider
 * message. When present, render `content` as Anthropic-shaped blocks (no
 * bytes) — one `{ type: kind }` marker per attachment — so
 * `normalizeConversationForExport` renders them as `[image attachment]` or
 * `[document attachment]`; otherwise keep the plain-string
 * `content` shape every other conversation consumer already expects.
 */
function userMessageEntryToMessages(
  entry: StreamLogEntryOf<typeof MESSAGE_TYPES.USER_MESSAGE>,
): unknown[] {
  if (!entry.text) return [];
  const attachments = entry.data?.attachments ?? [];
  const role = 'user';
  if (attachments.length === 0) {
    return [{ role, content: entry.text }];
  }
  return [
    {
      role,
      content: [
        { type: 'text', text: entry.text },
        ...attachments.map((kind) => ({ type: kind })),
      ],
    },
  ];
}

function modelResponseEntryToMessages(entry: StreamLogEntry): unknown[] {
  if (!entry.text?.trim()) return [];
  return [
    {
      role: 'assistant',
      content: [{ type: 'text', text: entry.text }],
    },
  ];
}

function thinkingEntryToMessages(entry: StreamLogEntry): unknown[] {
  if (!entry.text?.trim()) return [];
  return [
    {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: entry.text }],
    },
  ];
}

function toolUseEntryToMessages(
  entry: StreamLogEntryOf<typeof MESSAGE_TYPES.TOOL_USE>,
): unknown[] {
  const tool = entry.data;
  const messages: unknown[] = [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          name: tool.toolName ?? 'unknown',
          input: tool.input ?? {},
        },
      ],
    },
  ];
  const resultText = toolResultText(tool);
  if (resultText !== undefined) {
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', content: resultText }],
    });
  }
  return messages;
}

/** Anthropic-shaped `server_tool_use` + `web_search_tool_result` blocks. */
function webSearchEntryToMessages(
  entry: StreamLogEntryOf<typeof MESSAGE_TYPES.WEB_SEARCH>,
): unknown[] {
  const data = entry.data;
  const blocks: unknown[] = [];
  if (data.query) {
    blocks.push({
      type: 'server_tool_use',
      name: 'web_search',
      input: { query: data.query },
    });
  }
  const results = (data.results ?? [])
    .filter((result) => result.url)
    .map((result) => ({
      type: 'web_search_result',
      url: result.url,
      title: result.title ?? result.url,
    }));
  if (results.length > 0) {
    blocks.push({ type: 'web_search_tool_result', content: results });
  }
  return blocks.length > 0 ? [{ role: 'assistant', content: blocks }] : [];
}

function webFetchEntryToMessages(
  entry: StreamLogEntryOf<typeof MESSAGE_TYPES.WEB_FETCH>,
): unknown[] {
  const data = entry.data;
  if (!data.url) return [];
  // Emit the same nested `web_fetch_result` shape a live Anthropic response
  // carries, so every conversation consumer reads exactly one shape (#7508).
  // Failed fetches omit title/source rather than reconstructing the error
  // block, which keeps marker rendering identical to the live error path.
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'web_fetch_tool_result',
          content: {
            type: 'web_fetch_result',
            url: data.url,
            retrieved_at: null,
            content: {
              type: 'document',
              ...(data.title !== undefined && { title: data.title }),
              ...(data.content !== undefined && {
                source: { type: 'text', data: data.content },
              }),
            },
          },
        },
      ],
    },
  ];
}

/**
 * Map one transcript row to conversation messages. Exhaustive over the
 * {@link MessageType} union — the transcript is the single completed-run
 * record, so every entry kind must carry an explicit map-or-skip decision
 * here; adding a new `MessageType` without deciding fails to compile
 * (`assertNever`), instead of silently dropping conversation content.
 */
function conversationMessagesForEntry(entry: StreamLogEntry): unknown[] {
  const { messageType } = entry;
  if (messageType === undefined) return [];
  switch (messageType) {
    // ── Conversation content ────────────────────────────────────────────
    case MESSAGE_TYPES.USER_MESSAGE:
      return userMessageEntryToMessages(entry);
    case MESSAGE_TYPES.MODEL_RESPONSE:
      return modelResponseEntryToMessages(entry);
    case MESSAGE_TYPES.THINKING:
      return thinkingEntryToMessages(entry);
    case MESSAGE_TYPES.TOOL_USE:
      return toolUseEntryToMessages(entry);
    case MESSAGE_TYPES.WEB_SEARCH:
      return webSearchEntryToMessages(entry);
    case MESSAGE_TYPES.WEB_FETCH:
      return webFetchEntryToMessages(entry);
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
 * Reconstruct a provider-agnostic conversation from persisted transcript
 * rows. Uses the Anthropic-style content-block vocabulary (`text`,
 * `thinking`, `tool_use`/`tool_result`, `server_tool_use`,
 * `web_search_tool_result`, `web_fetch_tool_result`) that every existing
 * conversation consumer (`@agent/storage/conversationFormat`, the
 * chat-export normalizer, the CLI workspace-file extractor) already
 * recognizes, so downstream rendering code needs no new shape.
 */
function streamLogEntriesToConversation(
  entries: readonly StreamLogEntry[],
): unknown[] {
  return entries.flatMap((entry) =>
    entry.type === STREAM_LOG_ENTRY_TYPES.LOG
      ? conversationMessagesForEntry(entry)
      : [],
  );
}

/** Read completed-run display messages from the canonical transcript fold. */
export const readCompletedRunConversation = Effect.fn(
  'readCompletedRunConversation',
)(function* (
  runId: RunId,
  session: SessionHandle,
): Effect.fn.Return<CompletedRunConversationReadResult, Error> {
  const conversation = streamLogEntriesToConversation(
    yield* session.transcripts.readEntries(runId),
  );
  return conversation.length > 0
    ? { conversation, source: 'streamLog' }
    : { conversation: null, source: 'none' };
});
