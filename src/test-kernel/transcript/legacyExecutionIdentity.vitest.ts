import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { getExecutionStore } from '@agent/storage/ExecutionKVStore';
import { registerExecution } from '@agent/storage/executionLifecycle';
import { releaseOwnedExecutionLease } from '@agent/storage/executionLease';
import {
  EXECUTION_STREAM_ID_SOURCE,
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
  appendTranscriptEntry,
  snapshotFacts,
} from '@test/support/storeTestDrivers';
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
  appendTranscriptEntry(logStore, streamId, {
    id: 'entry-1',
    type: STREAM_LOG_ENTRY_TYPES.LOG,
    level: LOG_LEVELS.INFO,
    timestamp: 100,
    messageType: MESSAGE_TYPES.DEFAULT,
    text: 'child stream output',
  });
  await logStore.flush();
}

function runConfig(agent: string, model = 'deepseekproT'): AgentConfig {
  return AgentConfigSchema.parse({
    agent,
    model,
    agentCategory: AgentCategory.ToolUse,
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
    snapshotFacts(store).setRunConfig(
      streamId,
      runConfig('orchestrator'),
      executionId,
    );
    await store.flush();

    const resolved = await resolvePersistedStreamIdForExecution(executionId, {
      snapshotStore: new StreamSnapshotStore(),
    });

    expect(resolved).toEqual({
      streamId,
      fallbackStreamIds: [],
      exactExecutionCandidateStreamIds: [streamId],
    });
  });

  it(
    'bounds the concurrent meta-file reads instead of fanning out over every ' +
      'persisted stream at once (#7299)',
    async () => {
      const streamCount = 20;
      const seedStore = new StreamSnapshotStore();
      for (let i = 0; i < streamCount; i++) {
        const idHex = i.toString(16).padStart(2, '0');
        snapshotFacts(seedStore).setRunConfig(
          `agent${i}@model#abcd${idHex}` as StreamTabId,
          runConfig('agent'),
          `abcd${idHex}` as ExecutionId,
        );
      }
      await seedStore.flush();

      const resolveStore = new StreamSnapshotStore();
      let inFlight = 0;
      let maxInFlight = 0;
      vi.spyOn(
        resolveStore,
        'readPersistedStreamAssociation',
      ).mockImplementation(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return {};
      });

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

    expect(resolved).toEqual({ streamId, fallbackStreamIds: [] });
    await expect(
      getExecutionStore(executionId).readMeta(),
    ).resolves.toMatchObject({
      streamId,
      streamIdSource: EXECUTION_STREAM_ID_SOURCE.REGISTRATION,
    });
  });

  it('scans execution records whose stream-id provenance predates registration', async () => {
    const executionId = 'abc666' as ExecutionId;
    const streamId = 'orchestrator@deepseekproT#abc666' as StreamTabId;
    await getExecutionStore(executionId).writeMeta({
      timestamp: new Date().toISOString(),
      streamId,
    });

    const store = new StreamSnapshotStore();
    snapshotFacts(store).setRunConfig(
      streamId,
      runConfig('orchestrator'),
      executionId,
    );
    await store.flush();

    const resolved = await resolvePersistedStreamIdForExecution(executionId, {
      snapshotStore: new StreamSnapshotStore(),
    });
    expect(resolved).toEqual({
      streamId,
      fallbackStreamIds: [],
      exactExecutionCandidateStreamIds: [streamId],
    });
    await expect(
      getExecutionStore(executionId).readMeta(),
    ).resolves.toMatchObject({
      streamId,
      streamIdSource: EXECUTION_STREAM_ID_SOURCE.LEGACY_RESOLUTION,
    });

    const resumedStream = 'zOrchestrator@newModel#abc666' as StreamTabId;
    snapshotFacts(store).setRunConfig(
      resumedStream,
      runConfig('orchestrator', 'newModel'),
      executionId,
    );
    await store.flush();

    await expect(
      resolvePersistedStreamIdForExecution(executionId, {
        snapshotStore: new StreamSnapshotStore(),
      }),
    ).resolves.toEqual({
      fallbackStreamIds: [],
      exactExecutionCandidateStreamIds: [streamId, resumedStream],
    });
  });

  it('does not treat a work plan as canonical-ownership evidence', async () => {
    const executionId = 'abc777' as ExecutionId;
    const firstStream = 'aOrchestrator@deepseekproT#abc777' as StreamTabId;
    const secondStream = 'zBashTool@tool#abc777' as StreamTabId;
    const snapshotWriter = new StreamSnapshotStore();
    snapshotFacts(snapshotWriter).setRunConfig(
      firstStream,
      runConfig('orchestrator'),
      executionId,
    );
    snapshotFacts(snapshotWriter).setRunConfig(
      secondStream,
      runConfig('bash'),
      executionId,
    );
    snapshotFacts(snapshotWriter).setTodos(secondStream, [TODO]);
    await snapshotWriter.flush();
    // Seed a stamp-able record: the backfill write no-ops on absent metadata,
    // so without this a wrongful stamp attempt would be invisible below.
    await getExecutionStore(executionId).writeMeta({
      timestamp: new Date(0).toISOString(),
    });

    const resolved = await resolvePersistedStreamIdForExecution(executionId, {
      snapshotStore: new StreamSnapshotStore(),
    });
    expect(resolved).toEqual({
      fallbackStreamIds: [],
      exactExecutionCandidateStreamIds: [firstStream, secondStream],
    });
    // Skip-backfill-on-ambiguity (#9590 Stage 4): a resolution that reports
    // candidates never stamps a LEGACY_RESOLUTION identity on the record.
    expect(
      (await getExecutionStore(executionId).readMeta())?.streamId,
    ).toBeUndefined();
  });

  it('does not treat a stream log as canonical-ownership evidence', async () => {
    const executionId = 'abc888' as ExecutionId;
    const workPlanStream = 'aOrchestrator@deepseekproT#abc888' as StreamTabId;
    const logStream = 'zBashTool@tool#abc888' as StreamTabId;
    const snapshotWriter = new StreamSnapshotStore();
    snapshotFacts(snapshotWriter).setRunConfig(
      workPlanStream,
      runConfig('orchestrator'),
      executionId,
    );
    snapshotFacts(snapshotWriter).setRunConfig(
      logStream,
      runConfig('bash'),
      executionId,
    );
    snapshotFacts(snapshotWriter).setTodos(workPlanStream, [TODO]);
    await snapshotWriter.flush();
    // Seed a stamp-able record: the backfill write no-ops on absent metadata,
    // so without this a wrongful stamp attempt would be invisible below.
    await getExecutionStore(executionId).writeMeta({
      timestamp: new Date(0).toISOString(),
    });

    const logStore = await StreamLogStore.open();
    await appendLogEntry(logStore, logStream);

    const resolved = await resolvePersistedStreamIdForExecution(executionId, {
      snapshotStore: new StreamSnapshotStore(),
      streamLogStore: logStore,
    });
    expect(resolved).toEqual({
      fallbackStreamIds: [],
      exactExecutionCandidateStreamIds: [workPlanStream, logStream],
    });
    expect(
      (await getExecutionStore(executionId).readMeta())?.streamId,
    ).toBeUndefined();
  });

  it('does not treat several proven children as competing archive roots', async () => {
    const executionId = 'abc889' as ExecutionId;
    const parent = 'orchestrator@model#parent' as StreamTabId;
    const firstChild = 'bash@tool#abc889' as StreamTabId;
    const secondChild = 'codex@tool#abc889' as StreamTabId;
    const snapshotWriter = new StreamSnapshotStore();
    snapshotFacts(snapshotWriter).setRunConfig(
      firstChild,
      runConfig('bash'),
      executionId,
    );
    snapshotFacts(snapshotWriter).setParentStream(firstChild, parent);
    snapshotFacts(snapshotWriter).setRunConfig(
      secondChild,
      runConfig('codex'),
      executionId,
    );
    snapshotFacts(snapshotWriter).setParentStream(secondChild, parent);
    await snapshotWriter.flush();

    await expect(
      resolvePersistedStreamIdForExecution(executionId, {
        snapshotStore: new StreamSnapshotStore(),
      }),
    ).resolves.toEqual({
      fallbackStreamIds: [],
      associatedStreamIds: [firstChild, secondChild],
    });
  });

  it('resolves a sole delegated stream without treating it as an associated sibling', async () => {
    const executionId = 'abc88a' as ExecutionId;
    const streamId = 'bash@tool#abc88a' as StreamTabId;
    const snapshots = new StreamSnapshotStore();
    snapshotFacts(snapshots).setRunConfig(
      streamId,
      runConfig('bash'),
      executionId,
    );
    snapshotFacts(snapshots).setParentStream(
      streamId,
      'orchestrator@model#parent' as StreamTabId,
    );
    await snapshots.flush();

    await expect(
      resolvePersistedStreamIdForExecution(executionId, {
        snapshotStore: new StreamSnapshotStore(),
      }),
    ).resolves.toEqual({ streamId, fallbackStreamIds: [] });
  });

  it('reports several suffix-only sidecars as explicit ambiguity instead of choosing by order (#9590)', async () => {
    const executionId = 'abc999' as ExecutionId;
    const first = 'a@model#abc999' as StreamTabId;
    const second = 'z@model#abc999' as StreamTabId;
    const writer = new StreamSnapshotStore();
    snapshotFacts(writer).setTodos(first, [TODO]);
    snapshotFacts(writer).setTodos(second, [TODO]);
    await writer.flush();
    // Seed a stamp-able record: the backfill write no-ops on absent metadata,
    // so without this a wrongful stamp attempt would be invisible below.
    await getExecutionStore(executionId).writeMeta({
      timestamp: new Date(0).toISOString(),
    });

    await expect(
      resolvePersistedStreamIdForExecution(executionId, {
        snapshotStore: new StreamSnapshotStore(),
      }),
    ).resolves.toEqual({
      fallbackStreamIds: [],
      suffixCandidateStreamIds: [first, second],
    });
    // Suffix ambiguity never backfills a persisted identity (#9590 Stage 4).
    expect(
      (await getExecutionStore(executionId).readMeta())?.streamId,
    ).toBeUndefined();
  });

  it('reports a sidecar/log suffix disagreement as explicit ambiguity', async () => {
    const executionId = 'abcbbb' as ExecutionId;
    const sidecarStream = 'a@model#abcbbb' as StreamTabId;
    const logStream = 'z@model#abcbbb' as StreamTabId;
    const writer = new StreamSnapshotStore();
    snapshotFacts(writer).setTodos(sidecarStream, [TODO]);
    await writer.flush();
    const logs = await StreamLogStore.open();
    await appendLogEntry(logs, logStream);

    await expect(
      resolvePersistedStreamIdForExecution(executionId, {
        snapshotStore: new StreamSnapshotStore(),
        streamLogStore: logs,
      }),
    ).resolves.toEqual({
      fallbackStreamIds: [],
      suffixCandidateStreamIds: [sidecarStream, logStream],
    });
  });

  it('preserves the legacy streamLogs suffix fallback', async () => {
    const executionId = 'abcaaa' as ExecutionId;
    const streamId = 'agent@model#abcaaa' as StreamTabId;
    const logs = await StreamLogStore.open();
    await appendLogEntry(logs, streamId);

    await expect(
      resolvePersistedStreamIdForExecution(executionId, {
        snapshotStore: new StreamSnapshotStore(),
        streamLogStore: logs,
      }),
    ).resolves.toEqual({ streamId, fallbackStreamIds: [] });
  });

  it('never persists identity from a display-materialized transcript stream (#8226, #9590 Stage 4)', async () => {
    const executionId = 'abcccc' as ExecutionId;
    const orphanStream = 'progress@display#abcccc' as StreamTabId;
    // The #8226 class: a display event materializes a transcript stream via
    // `StreamLogStore.ensureStream` with no sidecar and no execution record.
    const logs = await StreamLogStore.open();
    logs.ensureStream(orphanStream);
    // Seed a stamp-able record: the backfill write no-ops on absent metadata,
    // so without this a wrongful stamp attempt would be invisible below.
    await getExecutionStore(executionId).writeMeta({
      timestamp: new Date(0).toISOString(),
    });

    // The suffix arm may still surface the orphan for compatibility display
    // reads, but resemblance is not proof: no LEGACY_RESOLUTION identity is
    // ever backfilled onto the execution record from it.
    await expect(
      resolvePersistedStreamIdForExecution(executionId, {
        snapshotStore: new StreamSnapshotStore(),
        streamLogStore: logs,
      }),
    ).resolves.toEqual({ streamId: orphanStream, fallbackStreamIds: [] });
    expect(
      (await getExecutionStore(executionId).readMeta())?.streamId,
    ).toBeUndefined();
  });
});
