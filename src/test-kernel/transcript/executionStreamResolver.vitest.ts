import { afterEach, describe, expect, it, vi } from 'vitest';

import { TaskStateSchema, type TaskState } from '@agent/core/state/TaskState';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { getExecutionStore } from '@agent/storage/ExecutionKVStore';
import { registerExecution } from '@agent/storage/executionLifecycle';
import { releaseOwnedExecutionLease } from '@agent/storage/executionLease';
import type { Platform } from '@platform/platform';
import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type ExecutionId,
  type StreamTabId,
  type TodoItem,
} from '@shared/schemas';
import { AgentCategory } from '@shared/schemas/agent';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';
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

const MINIMAL_CONFIG: AgentConfig = {
  agent: 'chat',
  model: 'deepseekproT',
  instruction: 'Check the proof.',
  agentCategory: AgentCategory.ToolUse,
  inputFiles: [],
  outputFiles: [],
  contextFiles: [],
  mediaFiles: [],
  editedFile: null,
  editedFiles: [],
  memories: [],
  toolConfig: DEFAULT_TOOL_CONFIG,
};

/** Reads the stream id cached by a completed resolver write-through. */
async function waitForCachedStreamId(
  executionId: ExecutionId,
): Promise<StreamTabId | undefined> {
  let streamId: StreamTabId | undefined;
  await vi.waitFor(async () => {
    streamId = (await getExecutionStore(executionId).readMeta())?.streamId;
    expect(streamId).toBeDefined();
  });
  return streamId;
}

const tempDirs: string[] = [];

function buildResolverPlatform(): Promise<Platform> {
  return createTempDirPlatform('texra-resolver-', tempDirs);
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
      store.setTodos(childStream, [TODO]);
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

      const logStore = await StreamLogStore.open();
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
      snapshotWriter.setTodos(workPlanOnlyStream, [TODO]);
      await snapshotWriter.flush();

      const logStore = await StreamLogStore.open();
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

  it('returns a cached executionMeta streamId without scanning any persisted stream (#7469)', async () => {
    const executionId = 'abc555' as ExecutionId;
    const cachedStreamId = 'orchestrator@deepseekproT#abc555' as StreamTabId;
    await registerExecution(executionId, MINIMAL_CONFIG, 'orchestrator');
    await releaseOwnedExecutionLease(executionId);
    await getExecutionStore(executionId).writeMeta({
      timestamp: new Date().toISOString(),
      streamId: cachedStreamId,
    });

    // No persisted stream exists at all — if the cache weren't consulted
    // first, the scan would find nothing and this would resolve to null.
    const resolved = await resolvePersistedStreamIdForExecution(executionId, {
      snapshotStore: new StreamSnapshotStore(),
    });

    expect(resolved).toEqual({
      streamId: cachedStreamId,
      source: 'executionMeta',
    });
  });

  it('caches a streamDataMeta resolution onto the execution meta for a later cheap lookup (#7469)', async () => {
    const executionId = 'abc666' as ExecutionId;
    const streamId = 'orchestrator@deepseekproT#abc666' as StreamTabId;
    await registerExecution(executionId, MINIMAL_CONFIG, 'orchestrator');
    await releaseOwnedExecutionLease(executionId);

    const store = new StreamSnapshotStore();
    store.setTaskState(streamId, taskState('orchestrator'), executionId);
    await store.flush();

    const first = await resolvePersistedStreamIdForExecution(executionId, {
      snapshotStore: new StreamSnapshotStore(),
    });
    expect(first).toEqual({ streamId, source: 'streamDataMeta' });

    const cachedStreamId = await waitForCachedStreamId(executionId);
    expect(cachedStreamId).toBe(streamId);

    const second = await resolvePersistedStreamIdForExecution(executionId, {
      snapshotStore: new StreamSnapshotStore(),
    });
    expect(second).toEqual({ streamId, source: 'executionMeta' });
  });

  it(
    'does not cache a multi-candidate resolution, so a later call with a ' +
      'loaded streamLogStore can still pick the log-backed candidate (#7469)',
    async () => {
      const executionId = 'abc777' as ExecutionId;
      const parentStream = 'aOrchestrator@deepseekproT#abc777' as StreamTabId;
      const childStream = 'zBashTool@tool#abc777' as StreamTabId;
      await registerExecution(executionId, MINIMAL_CONFIG, 'orchestrator');
      await releaseOwnedExecutionLease(executionId);

      const snapshotWriter = new StreamSnapshotStore();
      snapshotWriter.setTaskState(
        parentStream,
        taskState('orchestrator'),
        executionId,
      );
      snapshotWriter.setTaskState(childStream, taskState('bash'), executionId);
      await snapshotWriter.flush();

      const logStore = await StreamLogStore.open();
      logStore.append(childStream, {
        id: 'entry-1',
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: 100,
        messageType: MESSAGE_TYPES.DEFAULT,
        text: 'child stream output',
      });
      await logStore.flush();

      // First call has no streamLogStore, so pickBestMetaMatch can't see the
      // child's log and falls back to the first candidate (the parent).
      const uninformed = await resolvePersistedStreamIdForExecution(
        executionId,
        { snapshotStore: new StreamSnapshotStore() },
      );
      expect(uninformed).toEqual({
        streamId: parentStream,
        source: 'streamDataMeta',
      });

      // If that resolution had been cached, this second call -- which DOES
      // have the log store -- would incorrectly return the cached parent
      // instead of correctly picking the log-backed child.
      const informed = await resolvePersistedStreamIdForExecution(executionId, {
        snapshotStore: new StreamSnapshotStore(),
        streamLogStore: logStore,
      });
      expect(informed).toEqual({
        streamId: childStream,
        source: 'streamDataMeta',
      });
    },
  );
});
