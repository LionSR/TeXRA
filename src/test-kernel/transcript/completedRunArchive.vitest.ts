import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemoryStateStore } from '@platform/defaults/memoryState';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';
import { createFakePlatform } from '@test/support/FakePlatform';
import { setupPlatform } from '@test/support/setupPlatform';
import { readCompletedRunTodos, StreamSnapshotStore } from '@transcript';
import { TaskStateSchema, type TaskState } from '@agent/core/state/TaskState';
import type { ExecutionId, StreamTabId, TodoItem } from '@shared/schemas';
import { AgentCategory } from '@shared/schemas/agent';
import { StorageFS } from '@utils/files';
import type { Platform } from '@platform/platform';

const tempDirs: string[] = [];

async function buildArchivePlatform(): Promise<Platform> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'texra-archive-'));
  tempDirs.push(tempDir);
  const workspaceDir = path.join(tempDir, 'workspace');
  const storageRoot = path.join(tempDir, 'storage');
  return createFakePlatform(
    { workspacePath: workspaceDir },
    {
      fs: nodeFilesystem,
      workspace: createNodeWorkspace(() => workspaceDir),
      storage: new WorkspaceStorageProvider(storageRoot, workspaceDir),
      globalState: new MemoryStateStore(),
      workspaceState: new MemoryStateStore(),
    },
  );
}

function taskState(agent: string, model = 'deepseekproT'): TaskState {
  return TaskStateSchema.parse({
    agentConfig: { agent, model, agentCategory: AgentCategory.ToolUse },
  });
}

const SIDECAR_TODO: TodoItem = {
  content: 'Sidecar task',
  status: 'pending',
  activeForm: 'Doing sidecar task',
};

const LEGACY_TODOS = [{ content: 'Legacy task', status: 'completed' as const }];

describe('readCompletedRunTodos', () => {
  setupPlatform(buildArchivePlatform);

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('breaks a millisecond-resolution mtime tie toward the legacy write (#7404)', async () => {
    const executionId = 'abc7404' as ExecutionId;
    const streamId = 'orchestrator@deepseekproT#abc7404' as StreamTabId;

    const store = new StreamSnapshotStore();
    store.setTaskState(streamId, taskState('orchestrator'), executionId);
    store.handleProgressEvent('updateTodos', {
      streamId,
      todos: [SIDECAR_TODO],
    });
    await store.flush();

    // Real workPlan.json now exists on disk with some real mtime. Pin the
    // sidecar's observed mtime and report the legacy write as landing at
    // the exact same millisecond tick — the scenario where a final
    // `todo_write` truly lands after the sidecar flush but rounds to an
    // identical mtime.
    const tieMtime = 1_700_000_000_000;
    vi.spyOn(StorageFS, 'stat').mockResolvedValue({
      type: 1,
      ctime: tieMtime,
      mtime: tieMtime,
      size: 0,
    });

    const result = await readCompletedRunTodos(executionId, {
      snapshotStore: new StreamSnapshotStore(),
      legacyModifiedAt: async () => tieMtime,
      legacyFallback: async () => LEGACY_TODOS,
    });

    expect(result.source).toBe('legacyKV');
    expect(result.todos).toEqual(LEGACY_TODOS);
  });

  it('prefers the sidecar when it is strictly fresher than the legacy write', async () => {
    const executionId = 'abd7404' as ExecutionId;
    const streamId = 'orchestrator@deepseekproT#abd7404' as StreamTabId;

    const store = new StreamSnapshotStore();
    store.setTaskState(streamId, taskState('orchestrator'), executionId);
    store.handleProgressEvent('updateTodos', {
      streamId,
      todos: [SIDECAR_TODO],
    });
    await store.flush();

    const sidecarMtime = 1_700_000_000_000;
    vi.spyOn(StorageFS, 'stat').mockResolvedValue({
      type: 1,
      ctime: sidecarMtime,
      mtime: sidecarMtime,
      size: 0,
    });

    const result = await readCompletedRunTodos(executionId, {
      snapshotStore: new StreamSnapshotStore(),
      legacyModifiedAt: async () => sidecarMtime - 1,
      legacyFallback: async () => LEGACY_TODOS,
    });

    expect(result.source).toBe('streamData');
  });
});
