/**
 * Completed-run archive reads (#7246 Decision 1): once a run finishes, its
 * durable display/export data is owned by the transcript sidecars
 * (`streamLogs/{stream}.json` + `streamData/{stream}/*`), keyed through the
 * execution→stream mapping.
 */
import { getExecutionStore, type TodoEntry } from '@agent/storage';
import { mediaAttachmentKindToContentBlock } from '@agent/export/attachmentMarkerVocabulary';
import { formatToolResultAsText } from '@agent/modelHandlers/utils/toolAttachmentUtils';
import { stringifyConversationValue } from '@agent/storage/conversationFormat';
import {
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  ToolUseLogSchema,
  UserMessagePayloadSchema,
  WebFetchPayloadSchema,
  WebSearchPayloadSchema,
  type ExecutionId,
  type StreamLogEntry,
  type StreamTabId,
  type ToolUseLog,
} from '@shared/schemas';
import { ToolResultSchema } from '@shared/schemas/toolResult';
import { assertNever, isObject } from '@utils/core';

import { StreamLogStore } from './StreamLogStore';
import { StreamSnapshotStore } from './StreamSnapshotStore';

type CompletedRunTodosSource = 'streamData' | 'none';

export interface CompletedRunTodosReadResult {
  readonly todos: TodoEntry[];
  readonly source: CompletedRunTodosSource;
  readonly streamId?: StreamTabId;
}

/**
 * Read the archived task list for a completed run from the durable stream
 * sidecar (`streamData/{stream}/workPlan.json`). The execution→stream
 * mapping is the `streamId` stamped on execution metadata at registration —
 * a row without one has no persisted stream.
 */
export async function readCompletedRunTodos(
  executionId: ExecutionId,
): Promise<CompletedRunTodosReadResult> {
  const snapshotStore = new StreamSnapshotStore();
  const streamId = (await getExecutionStore(executionId).readMeta())?.streamId;

  if (streamId && (await snapshotStore.hasPersistedWorkPlan(streamId))) {
    const snapshot = await snapshotStore.read(streamId);
    return {
      todos: snapshot.todos.map((todo): TodoEntry => ({
        content: todo.content,
        status: todo.status,
      })),
      source: 'streamData',
      streamId,
    };
  }
  return { todos: [], source: 'none' };
}

// ============================================================================
// Conversation
// ============================================================================

type CompletedRunConversationSource = 'streamLog' | 'none';

export interface CompletedRunConversationReadResult {
  /** Provider-agnostic `{role, content}` messages, or `null` when the
   *  transcript sidecar holds no conversation data. */
  readonly conversation: unknown[] | null;
  readonly source: CompletedRunConversationSource;
  readonly streamId?: StreamTabId;
}

/** Whether completed-run storage proves a conversation or transcript association exists. */
export function hasCompletedRunConversationEvidence(
  result: CompletedRunConversationReadResult,
): boolean {
  return (
    (result.conversation?.length ?? 0) > 0 || result.streamId !== undefined
  );
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
 * bytes) via the attachment-marker vocabulary constructor, so
 * `normalizeConversationForExport` renders them as `[image attachment]` or
 * `[document attachment]`; otherwise keep the plain-string
 * `content` shape every other conversation consumer already expects. This
 * module holds no independent opinion on what those blocks look like.
 */
function userMessageEntryToMessages(entry: StreamLogEntry): unknown[] {
  if (!entry.text) return [];
  const parsed = UserMessagePayloadSchema.safeParse(entry.data);
  const attachments = parsed.success ? (parsed.data.attachments ?? []) : [];
  const role = archivedConversationRole(entry, 'user');
  if (attachments.length === 0) {
    return [{ role, content: entry.text }];
  }
  return [
    {
      role,
      content: [
        { type: 'text', text: entry.text },
        ...attachments.map(mediaAttachmentKindToContentBlock),
      ],
    },
  ];
}

function modelResponseEntryToMessages(entry: StreamLogEntry): unknown[] {
  if (!entry.text?.trim()) return [];
  return [
    {
      role: archivedConversationRole(entry, 'assistant'),
      content: [{ type: 'text', text: entry.text }],
    },
  ];
}

function archivedConversationRole(
  entry: StreamLogEntry,
  fallback: string,
): string {
  const data = isObject(entry.data) ? entry.data : {};
  return typeof data.archivedRole === 'string' ? data.archivedRole : fallback;
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

function toolUseEntryToMessages(entry: StreamLogEntry): unknown[] {
  const parsed = ToolUseLogSchema.safeParse(entry.data);
  if (!parsed.success) return [];
  const tool = parsed.data;
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
function webSearchEntryToMessages(entry: StreamLogEntry): unknown[] {
  const parsed = WebSearchPayloadSchema.safeParse(entry.data);
  if (!parsed.success) return [];
  const blocks: unknown[] = [];
  if (parsed.data.query) {
    blocks.push({
      type: 'server_tool_use',
      name: 'web_search',
      input: { query: parsed.data.query },
    });
  }
  const results = (parsed.data.results ?? [])
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

function webFetchEntryToMessages(entry: StreamLogEntry): unknown[] {
  const parsed = WebFetchPayloadSchema.safeParse(entry.data);
  if (!parsed.success || !parsed.data.url) return [];
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'web_fetch_tool_result',
          url: parsed.data.url,
          ...(parsed.data.title !== undefined && { title: parsed.data.title }),
          // `page_content` is the field name normalizeConversationForExport's
          // ContentBlockSchema already recognizes for this block type (#7508).
          ...(parsed.data.content !== undefined && {
            page_content: parsed.data.content,
          }),
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
    // (already mapped above); the rest are run diagnostics/status rows that
    // the legacy conversation.json projection never contained either.
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

/** Reconstruct one stream's conversation; `[]` when the log is absent/empty. */
async function conversationFromStream(
  streamLogStore: StreamLogStore,
  streamId: StreamTabId,
): Promise<unknown[]> {
  await streamLogStore.ensureLoaded(streamId);
  const log = streamLogStore.get(streamId);
  return log ? streamLogEntriesToConversation(log.toJSON()) : [];
}

/**
 * Read the archived conversation for a completed run from the transcript
 * sidecar (`streamLogs/{stream}.json`), reconstructed into provider-agnostic
 * messages.
 */
export async function readCompletedRunConversation(
  executionId: ExecutionId,
): Promise<CompletedRunConversationReadResult> {
  // A call-scoped read-only store, so this reader neither reloads a live store
  // nor mutates persistence.
  const streamLogStore = await StreamLogStore.openReadOnly();
  const streamId = (await getExecutionStore(executionId).readMeta())?.streamId;
  if (!streamId) return { conversation: null, source: 'none' };

  const conversation = await conversationFromStream(streamLogStore, streamId);
  return conversation.length > 0
    ? { conversation, source: 'streamLog', streamId }
    : { conversation: null, source: 'none', streamId };
}
