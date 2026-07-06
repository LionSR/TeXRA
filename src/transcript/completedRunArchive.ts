import type { TodoEntry } from '@agent/storage';
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

async function readLegacyTodos(
  fallback: (() => Promise<readonly TodoEntry[]>) | undefined,
): Promise<CompletedRunTodosReadResult> {
  if (!fallback) return { todos: [], source: 'none' };
  return {
    todos: [...(await fallback())],
    source: 'legacyKV',
  };
}

/**
 * Read the archived task list for a completed run from the stream sidecar.
 *
 * `executions/{id}/todos.json` is still consulted only as a temporary legacy
 * fallback for runs recorded before durable work-plan sidecars existed.
 */
export async function readCompletedRunTodos(
  executionId: ExecutionId,
  options: CompletedRunTodosReaderOptions = {},
): Promise<CompletedRunTodosReadResult> {
  const snapshotStore = options.snapshotStore ?? new StreamSnapshotStore();
  const resolved = await resolvePersistedStreamIdForExecution(executionId, {
    snapshotStore,
  });

  if (resolved) {
    if (await StorageFS.exists(workPlanPath(resolved.streamId))) {
      const snapshot = await snapshotStore.read(resolved.streamId);
      return {
        todos: snapshot.todos.map(todoItemToEntry),
        source: 'streamData',
        streamId: resolved.streamId,
      };
    }

    return readLegacyTodos(options.legacyFallback);
  }

  return readLegacyTodos(options.legacyFallback);
}
