import { afterEach, describe, expect, it, vi } from 'vitest';

import { TaskStateSchema, type TaskState } from '@agent/core/state/TaskState';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { getExecutionStore } from '@agent/storage/ExecutionKVStore';
import { registerExecution } from '@agent/storage/executionLifecycle';
import { releaseOwnedExecutionLease } from '@agent/storage/executionLease';
import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type ExecutionId,
  type StreamTabId,
  type TodoItem,
} from '@shared/schemas';
import { AgentCategory } from '@shared/schemas/agent';
import {
  cleanupTempDirs,
  createTempDirPlatform,
} from '@test/support/tempDirPlatform';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  resolvePersistedStreamIdForExecution,
  StreamLogStore,
  StreamSnapshotStore,
} from '@transcript';

const MINIMAL_CONFIG: AgentConfig = AgentConfigSchema.parse({
  agent: 'chat',
  model: 'deepseekproT',
  instruction: 'Check the proof.',
  agentCategory: AgentCategory.ToolUse,
});

const tempDirs: string[] = [];

async function appendLogEntry(
  logStore: StreamLogStore,
  streamId: StreamTabId,
): Promise<void> {
  logStore.append(streamId, {
    id: 'entry-1',
    type: STREAM_LOG_ENTRY_TYPES.LOG,
    level: LOG_LEVELS.INFO,
    timestamp: 100,
    messageType: MESSAGE_TYPES.DEFAULT,
    text: 'child stream output',
  });
  await logStore.flush();
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
  setupPlatform(() => createTempDirPlatform('texra-resolver-', tempDirs));

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDirs(tempDirs);
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

  it('returns the birth-written execution stream without scanning sidecars', async () => {
    const executionId = 'abc555' as ExecutionId;
    const streamId = 'orchestrator@deepseekproT#abc555' as StreamTabId;
    await registerExecution(executionId, MINIMAL_CONFIG, 'orchestrator', {
      streamId,
    });
    await releaseOwnedExecutionLease(executionId);

    const resolved = await resolvePersistedStreamIdForExecution(executionId, {
      snapshotStore: new StreamSnapshotStore(),
    });

    expect(resolved).toEqual({
      streamId,
      source: 'executionMeta',
    });
    await expect(
      getExecutionStore(executionId).readMeta(),
    ).resolves.toMatchObject({ streamId });
  });

  it('retains a sidecar scan fallback for execution records predating streamId', async () => {
    const executionId = 'abc666' as ExecutionId;
    const streamId = 'orchestrator@deepseekproT#abc666' as StreamTabId;
    await getExecutionStore(executionId).writeMeta({
      timestamp: new Date().toISOString(),
    });

    const store = new StreamSnapshotStore();
    store.setTaskState(streamId, taskState('orchestrator'), executionId);
    await store.flush();

    const resolved = await resolvePersistedStreamIdForExecution(executionId, {
      snapshotStore: new StreamSnapshotStore(),
    });
    expect(resolved).toEqual({ streamId, source: 'streamDataMeta' });
    await expect(
      getExecutionStore(executionId).readMeta(),
    ).resolves.toMatchObject({ streamId });
  });

  it('prefers a work-plan-bearing historical stream over a bare match', async () => {
    const executionId = 'abc777' as ExecutionId;
    const firstStream = 'aOrchestrator@deepseekproT#abc777' as StreamTabId;
    const secondStream = 'zBashTool@tool#abc777' as StreamTabId;
    const snapshotWriter = new StreamSnapshotStore();
    snapshotWriter.setTaskState(
      firstStream,
      taskState('orchestrator'),
      executionId,
    );
    snapshotWriter.setTaskState(secondStream, taskState('bash'), executionId);
    snapshotWriter.setTodos(secondStream, [TODO]);
    await snapshotWriter.flush();

    const resolved = await resolvePersistedStreamIdForExecution(executionId, {
      snapshotStore: new StreamSnapshotStore(),
    });
    expect(resolved).toEqual({
      streamId: secondStream,
      source: 'streamDataMeta',
      fallbackStreamIds: [firstStream],
    });
  });

  it('prefers a log-backed historical stream over a work-plan-only match', async () => {
    const executionId = 'abc888' as ExecutionId;
    const workPlanStream = 'aOrchestrator@deepseekproT#abc888' as StreamTabId;
    const logStream = 'zBashTool@tool#abc888' as StreamTabId;
    const snapshotWriter = new StreamSnapshotStore();
    snapshotWriter.setTaskState(
      workPlanStream,
      taskState('orchestrator'),
      executionId,
    );
    snapshotWriter.setTaskState(logStream, taskState('bash'), executionId);
    snapshotWriter.setTodos(workPlanStream, [TODO]);
    await snapshotWriter.flush();

    const logStore = await StreamLogStore.open();
    await appendLogEntry(logStore, logStream);

    const resolved = await resolvePersistedStreamIdForExecution(executionId, {
      snapshotStore: new StreamSnapshotStore(),
      streamLogStore: logStore,
    });
    expect(resolved).toEqual({
      streamId: logStream,
      source: 'streamDataMeta',
      fallbackStreamIds: [workPlanStream],
    });
    expect(
      (await getExecutionStore(executionId).readMeta())?.streamId,
    ).toBeUndefined();
  });
});
