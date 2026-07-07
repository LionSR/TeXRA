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
import {
  resolvePersistedStreamIdForExecution,
  StreamLogStore,
  StreamSnapshotStore,
} from '@transcript';
import { TaskStateSchema, type TaskState } from '@agent/core/state/TaskState';
import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type ExecutionId,
  type StreamTabId,
  type TodoItem,
} from '@shared/schemas';
import { AgentCategory } from '@shared/schemas/agent';
import type { Platform } from '@platform/platform';

const tempDirs: string[] = [];

async function buildResolverPlatform(): Promise<Platform> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'texra-resolver-'));
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

const TODO: TodoItem = {
  content: 'Fix the bug',
  status: 'pending',
  activeForm: 'Fixing the bug',
};

describe('resolvePersistedStreamIdForExecution', () => {
  setupPlatform(buildResolverPlatform);

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('resolves the sole meta-matched stream without needing a data-presence check', async () => {
    const executionId = 'abc111' as ExecutionId;
    const streamId = 'orchestrator@deepseekproT#abc111' as StreamTabId;

    const store = new StreamSnapshotStore();
    store.setTaskState(streamId, taskState('orchestrator'), executionId);
    await store.flush();

    const resolved = await resolvePersistedStreamIdForExecution(executionId, {
      snapshotStore: new StreamSnapshotStore(),
    });

    expect(resolved).toEqual({ streamId, source: 'streamDataMeta' });
  });

  it(
    'prefers the meta-matched candidate with a real workPlan.json over a bare ' +
      'meta-only match sharing the same executionId (#7298)',
    async () => {
      const executionId = 'abc222' as ExecutionId;
      // A parent orchestrator tab and a child bash-tool stream both record the
      // same executionId in their sidecar meta.json, but only the child ever
      // durably persisted todos — mirrors the resolver picking the parent (no
      // streamLogs/workPlan) and callers like the completed-run todo reader
      // silently reading nothing.
      // Named so the no-data candidate sorts alphabetically FIRST in the
      // persisted-stream directory listing — this is what makes the test
      // actually exercise the "first meta match wins" bug rather than
      // accidentally passing because the real-data stream happened to be
      // read first.
      const parentStream = 'aOrchestrator@deepseekproT#abc222' as StreamTabId;
      const childStream = 'zBashTool@tool#abc222' as StreamTabId;

      const store = new StreamSnapshotStore();
      store.setTaskState(parentStream, taskState('orchestrator'), executionId);
      store.setTaskState(childStream, taskState('bash'), executionId);
      store.handleProgressEvent('updateTodos', {
        streamId: childStream,
        todos: [TODO],
      });
      await store.flush();

      const resolved = await resolvePersistedStreamIdForExecution(executionId, {
        snapshotStore: new StreamSnapshotStore(),
      });

      expect(resolved).toEqual({
        streamId: childStream,
        source: 'streamDataMeta',
      });
    },
  );

  it(
    'prefers the meta-matched candidate with real streamLogs over a bare ' +
      'meta-only match, using an already-loaded StreamLogStore (#7298)',
    async () => {
      const executionId = 'abc333' as ExecutionId;
      // Same alphabetical-ordering reasoning as the workPlan test above.
      const parentStream = 'aOrchestrator@deepseekproT#abc333' as StreamTabId;
      const childStream = 'zBashTool@tool#abc333' as StreamTabId;

      const snapshotWriter = new StreamSnapshotStore();
      snapshotWriter.setTaskState(
        parentStream,
        taskState('orchestrator'),
        executionId,
      );
      snapshotWriter.setTaskState(childStream, taskState('bash'), executionId);
      await snapshotWriter.flush();

      const logStore = new StreamLogStore();
      await logStore.load();
      logStore.append(childStream, {
        id: 'entry-1',
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: 100,
        messageType: MESSAGE_TYPES.DEFAULT,
        text: 'child stream output',
      });
      await logStore.flush();

      const resolved = await resolvePersistedStreamIdForExecution(executionId, {
        snapshotStore: new StreamSnapshotStore(),
        streamLogStore: logStore,
      });

      expect(resolved).toEqual({
        streamId: childStream,
        source: 'streamDataMeta',
      });
    },
  );

  it(
    'prefers a log-backed meta match over an earlier-ordered workPlan-only ' +
      'match sharing the same executionId (#7403)',
    async () => {
      const executionId = 'abc444' as ExecutionId;
      // Named so the workPlan-only candidate sorts alphabetically FIRST in
      // the persisted-stream directory listing, mirroring the reported bug:
      // an earlier-ordered candidate has only workPlan.json (no stream log)
      // while a later-ordered candidate has the real streamLogs entry. The
      // resolver must still pick the log-backed one regardless of order.
      const workPlanOnlyStream =
        'aOrchestrator@deepseekproT#abc444' as StreamTabId;
      const logBackedStream = 'zBashTool@tool#abc444' as StreamTabId;

      const snapshotWriter = new StreamSnapshotStore();
      snapshotWriter.setTaskState(
        workPlanOnlyStream,
        taskState('orchestrator'),
        executionId,
      );
      snapshotWriter.setTaskState(
        logBackedStream,
        taskState('bash'),
        executionId,
      );
      snapshotWriter.handleProgressEvent('updateTodos', {
        streamId: workPlanOnlyStream,
        todos: [TODO],
      });
      await snapshotWriter.flush();

      const logStore = new StreamLogStore();
      await logStore.load();
      logStore.append(logBackedStream, {
        id: 'entry-1',
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: 100,
        messageType: MESSAGE_TYPES.DEFAULT,
        text: 'child stream output',
      });
      await logStore.flush();

      const resolved = await resolvePersistedStreamIdForExecution(executionId, {
        snapshotStore: new StreamSnapshotStore(),
        streamLogStore: logStore,
      });

      expect(resolved).toEqual({
        streamId: logBackedStream,
        source: 'streamDataMeta',
      });
    },
  );

  it(
    'bounds the concurrent meta-file reads instead of fanning out over every ' +
      'persisted stream at once (#7299)',
    async () => {
      const streamCount = 20;
      const seedStore = new StreamSnapshotStore();
      for (let i = 0; i < streamCount; i++) {
        const idHex = i.toString(16).padStart(2, '0');
        seedStore.setTaskState(
          `agent${i}@model#abcd${idHex}` as StreamTabId,
          taskState('agent'),
          `abcd${idHex}` as ExecutionId,
        );
      }
      await seedStore.flush();

      const resolveStore = new StreamSnapshotStore();
      let inFlight = 0;
      let maxInFlight = 0;
      vi.spyOn(resolveStore, 'readPersistedExecutionId').mockImplementation(
        async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight--;
          return undefined;
        },
      );

      await resolvePersistedStreamIdForExecution('abcdff' as ExecutionId, {
        snapshotStore: resolveStore,
      });

      // Matches the resolver's META_SCAN_CONCURRENCY bound: with 20 candidates
      // and an unbounded fan-out every read would start at once (maxInFlight
      // would hit 20); bounded, it never exceeds the worker-pool size.
      expect(maxInFlight).toBeGreaterThan(1);
      expect(maxInFlight).toBeLessThanOrEqual(8);
    },
  );
});
