import type { TodoEntry } from '@agent/storage';
import { isFileNotFoundError } from '@common/errors';
import type { ExecutionId, StreamTabId, TodoItem } from '@shared/schemas';
import { StorageFS } from '@utils/files';

import { resolvePersistedStreamIdForExecution } from './executionStreamResolver';
import { STREAM_DATA_KEYS, streamDataDir } from './streamDataPaths';
import { StreamSnapshotStore } from './StreamSnapshotStore';

export type CompletedRunTodosSource = 'streamData' | 'legacyKV' | 'none';

export interface CompletedRunTodosReadResult {
  readonly todos: TodoEntry[];
  readonly source: CompletedRunTodosSource;
  readonly streamId?: StreamTabId;
}

export interface CompletedRunTodosReaderOptions {
  readonly snapshotStore?: StreamSnapshotStore;
  readonly legacyFallback?: () => Promise<readonly TodoEntry[]>;
  /**
   * Last-modified time (ms since epoch) of the legacy `todos.json`, if it
   * exists. Used to detect a final `todo_write` that landed after the
   * sidecar's own (asynchronous) write flushed, so the fresher source wins
   * regardless of which one happens to exist.
   */
  readonly legacyModifiedAt?: () => Promise<number | undefined>;
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
  fallback: (() => Promise<readonly TodoEntry[]>) | undefined,
): Promise<CompletedRunTodosReadResult> {
  if (!fallback) return { todos: [], source: 'none' };
  return {
    todos: [...(await fallback())],
    source: 'legacyKV',
  };
}

async function readSidecarTodos(
  snapshotStore: StreamSnapshotStore,
  streamId: StreamTabId,
): Promise<CompletedRunTodosReadResult> {
  const snapshot = await snapshotStore.read(streamId);
  return {
    todos: snapshot.todos.map(todoItemToEntry),
    source: 'streamData',
    streamId,
  };
}

/**
 * Read the archived task list for a completed run, preferring the durable
 * stream sidecar (`streamData/{stream}/workPlan.json`) but falling back to
 * `executions/{id}/todos.json` for runs recorded before sidecars existed —
 * or when the legacy write is demonstrably fresher than the sidecar (a final
 * `todo_write` can land before the snapshot store's asynchronous sidecar
 * write has flushed).
 */
export async function readCompletedRunTodos(
  executionId: ExecutionId,
  options: CompletedRunTodosReaderOptions = {},
): Promise<CompletedRunTodosReadResult> {
  const snapshotStore = options.snapshotStore ?? new StreamSnapshotStore();
  const resolved = await resolvePersistedStreamIdForExecution(executionId, {
    snapshotStore,
  });

  if (!resolved) return readLegacyTodos(options.legacyFallback);

  const sidecarMtime = await sidecarModifiedAt(resolved.streamId);
  if (sidecarMtime === undefined) {
    return readLegacyTodos(options.legacyFallback);
  }

  const legacyMtime = await options.legacyModifiedAt?.();
  if (legacyMtime !== undefined && legacyMtime > sidecarMtime) {
    return readLegacyTodos(options.legacyFallback);
  }

  return readSidecarTodos(snapshotStore, resolved.streamId);
}
