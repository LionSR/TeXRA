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
  type ExecutionId,
  type StreamLogEntry,
  type StreamTabId,
  type TodoItem,
  type ToolUseLog,
} from '@shared/schemas';
import { StorageFS } from '@utils/files';

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

/**
 * Reconstruct a provider-agnostic conversation from persisted transcript
 * rows. Uses the Anthropic-style content-block vocabulary
 * (`text`/`tool_use`/`tool_result`) that every existing conversation
 * consumer (`@agent/storage/conversationFormat`, the chat-export
 * normalizer, the CLI workspace-file extractor) already recognizes, so
 * downstream rendering code needs no new shape.
 */
export function streamLogEntriesToConversation(
  entries: readonly StreamLogEntry[],
): unknown[] {
  const messages: unknown[] = [];
  for (const entry of entries) {
    if (entry.type !== STREAM_LOG_ENTRY_TYPES.LOG) continue;
    switch (entry.messageType) {
      case MESSAGE_TYPES.USER_MESSAGE: {
        if (entry.text) messages.push({ role: 'user', content: entry.text });
        break;
      }
      case MESSAGE_TYPES.MODEL_RESPONSE: {
        if (entry.text?.trim()) {
          messages.push({
            role: 'assistant',
            content: [{ type: 'text', text: entry.text }],
          });
        }
        break;
      }
      case MESSAGE_TYPES.TOOL_USE: {
        const parsed = ToolUseLogSchema.safeParse(entry.data);
        if (!parsed.success) break;
        const tool = parsed.data;
        messages.push({
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: tool.toolName ?? 'unknown',
              input: tool.input ?? {},
            },
          ],
        });
        const resultText = toolResultText(tool);
        if (resultText !== undefined) {
          messages.push({
            role: 'user',
            content: [{ type: 'tool_result', content: resultText }],
          });
        }
        break;
      }
      default:
        break;
    }
  }
  return messages;
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
