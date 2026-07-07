/**
 * Completed-run archive reads (#7246 Decision 1): once a run finishes, its
 * durable display/export data is owned by the transcript sidecars
 * (`streamLogs/{stream}.json` + `streamData/{stream}/*`), keyed through the
 * execution→stream mapping. The legacy `executions/{id}/conversation.json` /
 * `todos.json` KV projections are READ-ONLY fallbacks for runs recorded
 * before the sidecars existed (or written by builds that still project them)
 * — each fact keeps exactly ONE legacy read arm, here, tracked for D3
 * retirement in the #6981 ledger.
 */
import { getExecutionStore, type TodoEntry } from '@agent/storage';
import { stringifyConversationValue } from '@agent/storage/conversationFormat';
import { isFileNotFoundError } from '@common/errors';
import { KVStore } from '@common/storage/KVStore';
import {
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  ToolUseLogSchema,
  WebFetchPayloadSchema,
  WebSearchPayloadSchema,
  type ExecutionId,
  type StreamLogEntry,
  type StreamTabId,
  type TodoItem,
  type ToolUseLog,
} from '@shared/schemas';
import { StorageFS } from '@utils/files';
import { assertNever } from '@utils/core/typeGuards';

import { resolvePersistedStreamIdForExecution } from './executionStreamResolver';
import { STREAM_DATA_KEYS, streamDataDir } from './streamDataPaths';
import { StreamLogStore, STREAM_LOGS_DIR } from './StreamLogStore';
import { StreamSnapshotStore } from './StreamSnapshotStore';

export type CompletedRunTodosSource = 'streamData' | 'legacyKV' | 'none';

export interface CompletedRunTodosReadResult {
  readonly todos: TodoEntry[];
  readonly source: CompletedRunTodosSource;
  readonly streamId?: StreamTabId;
}

export interface CompletedRunReaderOptions {
  readonly snapshotStore?: StreamSnapshotStore;
}

function todoItemToEntry(todo: TodoItem): TodoEntry {
  return {
    content: todo.content,
    status: todo.status,
  };
}

function workPlanPath(streamId: StreamTabId): string {
  return `${streamDataDir(streamId)}/${STREAM_DATA_KEYS.WORK_PLAN}.json`;
}

/** Sidecar `workPlan.json` mtime (ms since epoch), or `undefined` if absent. */
async function sidecarModifiedAt(
  streamId: StreamTabId,
): Promise<number | undefined> {
  try {
    return (await StorageFS.stat(workPlanPath(streamId))).mtime;
  } catch (err) {
    if (isFileNotFoundError(err)) return undefined;
    throw err;
  }
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
 * stream sidecar (`streamData/{stream}/workPlan.json`) but falling back to
 * `executions/{id}/todos.json` for runs recorded before sidecars existed —
 * or when the legacy write is demonstrably fresher than the sidecar (a final
 * `todo_write` can land before the snapshot store's asynchronous sidecar
 * write has flushed).
 *
 * Freshness detail: millisecond-resolution mtimes (the VS Code filesystem
 * adapter's granularity) can tie when both writes land in the same tick;
 * ties are broken toward the legacy write, since a genuinely later legacy
 * write is the more likely cause of a tie than a genuinely later sidecar
 * write racing to complete in the same millisecond.
 */
export async function readCompletedRunTodos(
  executionId: ExecutionId,
  options: CompletedRunReaderOptions = {},
): Promise<CompletedRunTodosReadResult> {
  const snapshotStore = options.snapshotStore ?? new StreamSnapshotStore();
  const resolved = await resolvePersistedStreamIdForExecution(executionId, {
    snapshotStore,
  });

  if (!resolved) return readLegacyTodos(executionId);

  const sidecarMtime = await sidecarModifiedAt(resolved.streamId);
  if (sidecarMtime === undefined) {
    return readLegacyTodos(executionId);
  }

  const legacyMtime = await getExecutionStore(executionId).todosModifiedAt();
  if (legacyMtime !== undefined && legacyMtime >= sidecarMtime) {
    return readLegacyTodos(executionId);
  }

  const snapshot = await snapshotStore.read(resolved.streamId);
  return {
    todos: snapshot.todos.map(todoItemToEntry),
    source: 'streamData',
    streamId: resolved.streamId,
  };
}

// ============================================================================
// Conversation
// ============================================================================

export type CompletedRunConversationSource = 'streamLog' | 'legacyKV' | 'none';

export interface CompletedRunConversationReadResult {
  /** Provider-agnostic `{role, content}` messages, or `null` when neither
   *  source holds any conversation data. */
  readonly conversation: unknown[] | null;
  readonly source: CompletedRunConversationSource;
  readonly streamId?: StreamTabId;
}

export interface CompletedRunConversationReaderOptions extends CompletedRunReaderOptions {
  /**
   * An already-`load()`ed store. When omitted a call-scoped instance is
   * created and loaded — never pass the shared live store un-loaded, since
   * `load()` clears a store's in-memory state (see `assembleTrace`).
   */
  readonly streamLogStore?: StreamLogStore;
}

/** `streamLogs/{stream}.json` mtime (ms since epoch), or `undefined` if absent. */
function streamLogModifiedAt(
  streamId: StreamTabId,
): Promise<number | undefined> {
  return new KVStore(STREAM_LOGS_DIR).modifiedAt(streamId);
}

function toolResultText(tool: ToolUseLog): string | undefined {
  if (tool.error !== undefined) return tool.error;
  if (typeof tool.output === 'string') return tool.output;
  if (tool.output !== undefined) return stringifyConversationValue(tool.output);
  return tool.summary;
}

function userMessageEntryToMessages(entry: StreamLogEntry): unknown[] {
  return entry.text ? [{ role: 'user', content: entry.text }] : [];
}

function modelResponseEntryToMessages(entry: StreamLogEntry): unknown[] {
  if (!entry.text?.trim()) return [];
  return [{ role: 'assistant', content: [{ type: 'text', text: entry.text }] }];
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
    case MESSAGE_TYPES.ERROR:
    case MESSAGE_TYPES.INTERNAL:
    case MESSAGE_TYPES.CONTEXT_MANAGEMENT:
    case MESSAGE_TYPES.CONTEXT_STATE:
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
export function streamLogEntriesToConversation(
  entries: readonly StreamLogEntry[],
): unknown[] {
  return entries.flatMap((entry) =>
    entry.type === STREAM_LOG_ENTRY_TYPES.LOG
      ? conversationMessagesForEntry(entry)
      : [],
  );
}

async function readLegacyConversation(
  executionId: ExecutionId,
): Promise<CompletedRunConversationReadResult> {
  const conversation = await getExecutionStore(executionId).readConversation();
  return {
    conversation,
    source: conversation ? 'legacyKV' : 'none',
  };
}

/**
 * Read the archived conversation for a completed run from the transcript
 * sidecar (`streamLogs/{stream}.json`), reconstructed into provider-agnostic
 * messages. Falls back to the legacy `executions/{id}/conversation.json`
 * projection when the run predates the sidecars, when the transcript holds
 * no conversation-shaped rows (pre-`messageType` legacy streams), or when
 * the legacy write is fresher than the sidecar — the same mtime arbitration
 * (ties toward legacy) as {@link readCompletedRunTodos}.
 */
export async function readCompletedRunConversation(
  executionId: ExecutionId,
  options: CompletedRunConversationReaderOptions = {},
): Promise<CompletedRunConversationReadResult> {
  const snapshotStore = options.snapshotStore ?? new StreamSnapshotStore();
  let streamLogStore = options.streamLogStore;
  if (!streamLogStore) {
    // Call-scoped instance, same rationale as assembleTrace: load() clears a
    // store's in-memory state, so the shared live store must never be
    // re-loaded from a read path.
    streamLogStore = new StreamLogStore();
    await streamLogStore.load();
  }

  const resolved = await resolvePersistedStreamIdForExecution(executionId, {
    snapshotStore,
    streamLogStore,
  });
  if (!resolved) return readLegacyConversation(executionId);

  const sidecarMtime = await streamLogModifiedAt(resolved.streamId);
  if (sidecarMtime === undefined) return readLegacyConversation(executionId);

  const legacyMtime =
    await getExecutionStore(executionId).conversationModifiedAt();
  if (legacyMtime !== undefined && legacyMtime >= sidecarMtime) {
    return readLegacyConversation(executionId);
  }

  await streamLogStore.ensureLoaded(resolved.streamId);
  const log = streamLogStore.get(resolved.streamId);
  const conversation = log ? streamLogEntriesToConversation(log.toJSON()) : [];
  if (conversation.length === 0) return readLegacyConversation(executionId);
  return { conversation, source: 'streamLog', streamId: resolved.streamId };
}
