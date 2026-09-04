import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearStoreCache, getExecutionStore } from '@agent/storage';
import { flowKey } from '@agent/node/persistedFlow';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { SessionState } from '@controllers/session/SessionState';
import {
  LOG_LEVELS,
  RUN_OUTCOME,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import {
  streamHeldMessage,
  streamUnreadableMessage,
} from '@shared/streams/streamStatusDisplay';
import {
  startForeignInstance,
  writeForeignLease,
} from '@test/support/executionLeaseFixtures';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  appendTranscriptEntry,
  snapshotFacts,
} from '@test/support/storeTestDrivers';
import { StreamLogStore, StreamSnapshotStore } from '@transcript';
import { StorageFS } from '@utils/files/storageFS';

setupPlatform({ workspacePath: '/workspace/derived-stream-phase' });

const META_TIMESTAMP = '2026-09-04T00:00:00.000Z';
const validFlowRecord = {
  shared: { messages: [] },
  cursor: { nextNodeId: 'start' },
};

/** Sessions opened by a test, disposed in afterEach (dispose is idempotent). */
const sessions: SessionHandle[] = [];

/**
 * A session whose restart repair never runs: `deferred` holds it until
 * `waitUntilReady`, which these tests deliberately never call, so every phase
 * below is derived at read time and not something repair wrote.
 */
function openUnrepairedSession(transcripts: StreamLogStore): SessionState {
  const session = new SessionHandle({ transcripts, restartRepair: 'deferred' });
  sessions.push(session);
  return new SessionState(session);
}

function appendRunningGroup(
  transcripts: StreamLogStore,
  stream: StreamTabId,
): void {
  appendTranscriptEntry(transcripts, stream, {
    id: `${stream}-group`,
    type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
    level: LOG_LEVELS.INFO,
    timestamp: 1_000,
    data: { status: STREAM_PHASE.RUNNING },
  });
}

/** Persist the stream→execution sidecar FK the hydration reads. */
async function seedSidecarFk(
  stream: StreamTabId,
  executionId: ExecutionId,
): Promise<void> {
  const snapshots = new StreamSnapshotStore();
  snapshotFacts(snapshots).setRunConfig(
    stream,
    AgentConfigSchema.parse({
      agent: 'chat',
      model: 'deepseekT',
      agentCategory: 'toolUse',
    }),
    executionId,
  );
  await snapshots.flush();
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const session of sessions) session.dispose();
  sessions.length = 0;
  for (const directory of [
    WORKSPACE_STORAGE_LAYOUT.executionLeases,
    'executions',
    'streamData',
    'streamLogs',
    'streamLogSummaries',
  ]) {
    await StorageFS.delete(directory, { recursive: true }).catch(
      () => undefined,
    );
  }
  clearStoreCache();
});

describe('SessionState.resolveStreamPhase', () => {
  it('derives a stopped run with a surviving checkpoint without writing anything', async () => {
    const executionId = 'aaaa1111' as ExecutionId;
    const stream = `stopped#${executionId}` as StreamTabId;
    const transcripts = await StreamLogStore.open();
    await seedSidecarFk(stream, executionId);
    const executionStore = getExecutionStore(executionId);
    await executionStore.writeMeta({
      timestamp: META_TIMESTAMP,
      outcome: RUN_OUTCOME.CANCELLED,
    });
    await executionStore.write(flowKey(executionId), validFlowRecord);

    const state = openUnrepairedSession(transcripts);
    await state.snapshots.preload([stream]);

    // The persisted outcome is the display fact, and CANCELLED is what every
    // downstream table already renders with Resume enabled.
    expect(state.resolveStreamPhase(stream)).toEqual({
      state: { phase: STREAM_PHASE.CANCELLED },
      origin: 'derived',
    });
    // Read-time only: no outcome rewrite, no transcript settlement.
    expect((await executionStore.readMeta())?.timestamp).toBe(META_TIMESTAMP);
    await expect(executionStore.read(flowKey(executionId))).resolves.toEqual(
      validFlowRecord,
    );
  });

  it('derives an unhydrated stream whose transcript was left open as interrupted', async () => {
    const executionId = 'bbbb2222' as ExecutionId;
    const stream = `crashed#${executionId}` as StreamTabId;
    const transcripts = await StreamLogStore.open();
    appendRunningGroup(transcripts, stream);
    await transcripts.flush();

    const state = openUnrepairedSession(transcripts);

    // No sidecar hydration at all: the always-resident summary is the only
    // evidence, and it is enough.
    expect(state.snapshots.hasProvenance(stream)).toBe(false);
    expect(state.resolveStreamPhase(stream)).toEqual({
      state: { phase: STREAM_PHASE.CANCELLED },
      origin: 'derived',
    });
  });

  it('shows a run whose lease a live foreign process holds as unavailable, never terminal', async () => {
    const foreign = await startForeignInstance();
    const executionId = 'cccc3333' as ExecutionId;
    const stream = `held#${executionId}` as StreamTabId;
    const transcripts = await StreamLogStore.open();
    await seedSidecarFk(stream, executionId);
    const executionStore = getExecutionStore(executionId);
    await executionStore.writeMeta({ timestamp: META_TIMESTAMP });
    await executionStore.write(flowKey(executionId), validFlowRecord);
    await writeForeignLease(executionId, undefined, foreign.owner);

    try {
      const state = openUnrepairedSession(transcripts);
      await state.snapshots.preload([stream]);

      // A checkpoint plus no outcome is also what a crash looks like; the
      // live lease is what keeps this out of the terminal arm.
      expect(state.resolveStreamPhase(stream)).toEqual({
        origin: 'derived',
        detail: streamHeldMessage(foreign.owner),
      });
      expect(state.getStreamPhaseState(stream)).toBeUndefined();
    } finally {
      await foreign.shutdown();
    }
  });

  it('shows a stream whose execution record could not be read as unavailable', async () => {
    const executionId = 'dddd4444' as ExecutionId;
    const stream = `unreadable#${executionId}` as StreamTabId;
    const transcripts = await StreamLogStore.open();
    await seedSidecarFk(stream, executionId);
    const executionStore = getExecutionStore(executionId);
    await executionStore.writeMeta({ timestamp: META_TIMESTAMP });
    vi.spyOn(executionStore, 'readMeta').mockRejectedValue(
      new Error('meta.json is unreadable'),
    );

    const state = openUnrepairedSession(transcripts);
    await state.snapshots.preload([stream]);

    // A failed authority read is not "nothing ran": it renders read-only with
    // the cause, so the failure cannot degrade into a quiet `ready`.
    expect(state.resolveStreamPhase(stream)).toEqual({
      origin: 'derived',
      detail: streamUnreadableMessage('meta.json is unreadable'),
    });
  });
});
