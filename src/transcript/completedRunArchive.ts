/**
 * Completed-run archive reads (#7246 Decision 1): once a run finishes, its
 * durable display/export data is owned by the transcript sidecars
 * (`streamLogs/{stream}.json` + `streamData/{stream}/*`), keyed through the
 * execution→stream mapping. The legacy `executions/{id}/conversation.json` /
 * `todos.json` KV projections are READ-ONLY fallbacks for runs recorded
 * before the sidecars existed. Each fact keeps exactly one legacy read arm,
 * here, tracked for D3 retirement in the #6981 ledger.
 */
import { getExecutionStore, type TodoEntry } from '@agent/storage';
import { mediaAttachmentKindToContentBlock } from '@agent/export/attachmentMarkerVocabulary';
import { formatToolResultAsText } from '@agent/modelHandlers/utils/toolAttachmentUtils';
import {
  formatConversationMessage,
  stringifyConversationValue,
} from '@agent/storage/conversationFormat';
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
  type TodoItem,
  type ToolUseLog,
} from '@shared/schemas';
import { ToolResultSchema } from '@shared/schemas/toolResult';
import { assertNever, generateShortId, isObject } from '@utils/core';

import {
  findPersistedStreamFallbacksForExecution,
  resolvePersistedStreamIdForExecution,
  type PersistedStreamIdResolution,
} from './executionStreamResolver';
import { StreamLogStore } from './StreamLogStore';
import { StreamSnapshotStore } from './StreamSnapshotStore';

type CompletedRunTodosSource = 'streamData' | 'legacyKV' | 'none';

export interface CompletedRunTodosReadResult {
  readonly todos: TodoEntry[];
  readonly source: CompletedRunTodosSource;
  readonly streamId?: StreamTabId;
}

function todoItemToEntry(todo: TodoItem): TodoEntry {
  return {
    content: todo.content,
    status: todo.status,
  };
}

async function readLegacyTodos(
  executionId: ExecutionId,
): Promise<CompletedRunTodosReadResult> {
  const todos = await getExecutionStore(executionId).readTodos();
  return {
    todos,
    source: todos.length > 0 ? 'legacyKV' : 'none',
  };
}

/**
 * Read the archived task list for a completed run, preferring the durable
 * stream sidecar (`streamData/{stream}/workPlan.json`), with
 * `executions/{id}/todos.json` as a read-only fallback for historical runs.
 */
export async function readCompletedRunTodos(
  executionId: ExecutionId,
): Promise<CompletedRunTodosReadResult> {
  const snapshotStore = new StreamSnapshotStore();
  const resolved = await resolvePersistedStreamIdForExecution(executionId, {
    snapshotStore,
  });

  if (
    resolved &&
    (await snapshotStore.hasPersistedWorkPlan(resolved.streamId))
  ) {
    const snapshot = await snapshotStore.read(resolved.streamId);
    return {
      todos: snapshot.todos.map(todoItemToEntry),
      source: 'streamData',
      streamId: resolved.streamId,
    };
  }
  return readLegacyTodos(executionId);
}

// ============================================================================
// Conversation
// ============================================================================

type CompletedRunConversationSource = 'streamLog' | 'legacyKV' | 'none';

export interface CompletedRunConversationReadResult {
  /** Provider-agnostic `{role, content}` messages, or `null` when neither
   *  source holds any conversation data. */
  readonly conversation: unknown[] | null;
  readonly source: CompletedRunConversationSource;
  readonly streamId?: StreamTabId;
  /** All positively associated root sidecars used for a merged archive. */
  readonly streamIds?: readonly StreamTabId[];
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

/**
 * Import a pre-sidecar persisted conversation into an otherwise
 * conversation-empty stream before a resumed reflection run appends new
 * turns. This is the one legacy-to-canonical migration boundary: subsequent
 * completed reads remain sidecar-first and never have to splice two histories.
 */
export async function seedResumedConversationSidecar(
  streamLogStore: StreamLogStore,
  streamId: StreamTabId,
  executionId: ExecutionId,
  messages: readonly unknown[],
): Promise<boolean> {
  if (messages.length === 0) return false;
  await streamLogStore.ensureLoaded(streamId);
  const existing = streamLogStore.get(streamId);
  if (
    existing &&
    streamLogEntriesToConversation(existing.toJSON()).length > 0
  ) {
    return false;
  }

  const normalized = messages
    .map((message) => formatConversationMessage(message))
    .filter(({ content }) => content.length > 0);
  if (normalized.length === 0) return false;

  const writer = streamLogStore.acquireWriter(streamId, executionId);
  try {
    for (const { role, content } of normalized) {
      writer.appendSettled({
        id: generateShortId(),
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: 'info',
        timestamp: Date.now(),
        messageType:
          role === 'assistant' || role === 'model'
            ? MESSAGE_TYPES.MODEL_RESPONSE
            : MESSAGE_TYPES.USER_MESSAGE,
        text: content,
        data: { archivedRole: role },
        verbose: false,
      });
    }
  } finally {
    writer.close();
  }
  return true;
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
 * Interleave execution-matched root sidecars by recorded time while preserving
 * each stream's authoritative local sequence. Persisted row identity removes
 * copied overlap without collapsing distinct messages with equal text.
 */
async function mergedRootConversation(
  streamLogStore: StreamLogStore,
  streamIds: readonly StreamTabId[],
): Promise<unknown[]> {
  const entriesByStream = await Promise.all(
    streamIds.map(async (streamId) => {
      await streamLogStore.ensureLoaded(streamId);
      return streamLogStore.get(streamId)?.toJSON() ?? [];
    }),
  );
  const seen = new Set<string>();
  const uniqueEntriesByStream = entriesByStream.map((entries) =>
    entries.filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    }),
  );
  const nextIndexes = uniqueEntriesByStream.map(() => 0);
  const ordered: StreamLogEntry[] = [];
  while (true) {
    let next:
      | { readonly entry: StreamLogEntry; readonly streamIndex: number }
      | undefined;
    for (const [streamIndex, entries] of uniqueEntriesByStream.entries()) {
      const entry = entries[nextIndexes[streamIndex] ?? 0];
      if (
        entry &&
        (!next ||
          entry.timestamp < next.entry.timestamp ||
          (entry.timestamp === next.entry.timestamp &&
            streamIndex < next.streamIndex))
      ) {
        next = { entry, streamIndex };
      }
    }
    if (!next) break;
    ordered.push(next.entry);
    nextIndexes[next.streamIndex] = (nextIndexes[next.streamIndex] ?? 0) + 1;
  }
  return streamLogEntriesToConversation(ordered);
}

/**
 * Sidecar arm of the non-empty rule. Current executions normally need only
 * their registered primary. If it reconstructs empty, historical candidates
 * are tried in deterministic order before the legacy projection.
 */
async function readSidecarConversation(
  executionId: ExecutionId,
  resolved: PersistedStreamIdResolution,
  snapshotStore: StreamSnapshotStore,
  streamLogStore: StreamLogStore,
): Promise<CompletedRunConversationReadResult | null> {
  // Current executions register one canonical stream at birth; a disk-backed
  // release/reopen regression proves resumed turns append there. Only
  // pre-registration resolutions can represent historical split sidecars, so
  // keep the ordinary completed-read path constant-time.
  const rootStreamIds = resolved.associatedRootStreamIds;
  if (rootStreamIds !== undefined) {
    const orderedRoots = [
      ...(rootStreamIds.includes(resolved.streamId) ? [resolved.streamId] : []),
      ...rootStreamIds.filter((streamId) => streamId !== resolved.streamId),
    ];
    const conversation = await mergedRootConversation(
      streamLogStore,
      orderedRoots,
    );
    if (conversation.length > 0) {
      return {
        conversation,
        source: 'streamLog',
        streamId: orderedRoots[0],
        ...(orderedRoots.length > 1 ? { streamIds: orderedRoots } : {}),
      };
    }
    // Exact metadata established the canonical root set. An empty root
    // conversation must fall back to the legacy execution projection, never
    // to a child or suffix-only sidecar.
    return null;
  }

  const primaryConversation = await conversationFromStream(
    streamLogStore,
    resolved.streamId,
  );
  if (primaryConversation.length > 0) {
    return {
      conversation: primaryConversation,
      source: 'streamLog',
      streamId: resolved.streamId,
    };
  }

  const fallbackStreamIds =
    resolved.fallbackStreamIds ??
    (await findPersistedStreamFallbacksForExecution(
      executionId,
      resolved.streamId,
      { snapshotStore, streamLogStore },
    ));
  for (const streamId of fallbackStreamIds) {
    const conversation = await conversationFromStream(streamLogStore, streamId);
    if (conversation.length > 0) {
      return { conversation, source: 'streamLog', streamId };
    }
  }
  return null;
}

/**
 * Read the archived conversation for a completed run from the transcript
 * sidecar (`streamLogs/{stream}.json`), reconstructed into provider-agnostic
 * messages, with the legacy `executions/{id}/conversation.json` projection
 * as the fallback arm.
 *
 * The sidecar is tried first. If it has no conversation-shaped rows, the
 * reader falls back once to the historical projection. An empty source never
 * wins over a source with content.
 */
export async function readCompletedRunConversation(
  executionId: ExecutionId,
): Promise<CompletedRunConversationReadResult> {
  const snapshotStore = new StreamSnapshotStore();
  // A call-scoped read-only store, so this reader neither reloads a live store
  // nor mutates persistence.
  const streamLogStore = await StreamLogStore.openReadOnly();

  const resolved = await resolvePersistedStreamIdForExecution(executionId, {
    snapshotStore,
    streamLogStore,
  });

  // Legacy `conversation.json`; `null` when missing or empty.
  const tryLegacy =
    async (): Promise<CompletedRunConversationReadResult | null> => {
      const conversation =
        await getExecutionStore(executionId).readConversation();
      return conversation ? { conversation, source: 'legacyKV' } : null;
    };
  const trySidecar =
    async (): Promise<CompletedRunConversationReadResult | null> =>
      resolved
        ? readSidecarConversation(
            executionId,
            resolved,
            snapshotStore,
            streamLogStore,
          )
        : null;

  for (const arm of [trySidecar, tryLegacy]) {
    const result = await arm();
    if (result) return result;
  }
  return { conversation: null, source: 'none' };
}
