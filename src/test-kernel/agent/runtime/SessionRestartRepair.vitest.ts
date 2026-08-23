import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import { clearStoreCache, getExecutionStore } from '@agent/storage';
import { flowKey } from '@agent/node/persistedFlow';
import {
  acquireFreshExecutionLease,
  completeOwnedExecutionLease,
  resetExecutionLeaseCoordinationForTests,
} from '@agent/storage/executionLease';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { submitFollowUp } from '@agent/followUp/ToolUseFollowUp';
import * as runClassification from '@agent/runtime/runClassification';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { platform } from '@platform/platform';
import {
  LOG_LEVELS,
  RUN_OUTCOME,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import {
  startForeignInstance,
  writeForeignLease,
  writeOrphanedLease,
} from '@test/support/executionLeaseFixtures';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  appendTranscriptEntry,
  snapshotFacts,
} from '@test/support/storeTestDrivers';
import { StreamLogStore, StreamSnapshotStore } from '@transcript';
import { StorageFS } from '@utils/files/storageFS';

setupPlatform({ workspacePath: '/workspace/session-restart-repair' });

const executionId = 'abc123' as ExecutionId;
const streamId = `crashed#${executionId}` as StreamTabId;
const META_TIMESTAMP = '2026-07-26T00:00:00.000Z';
const validFlowRecord = {
  shared: { messages: [] },
  cursor: { nextNodeId: 'start' },
};

/** Sessions opened by a test, disposed in afterEach (dispose is idempotent). */
const sessions: SessionHandle[] = [];

function trackSession(session: SessionHandle): SessionHandle {
  sessions.push(session);
  return session;
}

function openDeferredSession(transcripts: StreamLogStore): SessionHandle {
  return trackSession(
    new SessionHandle({ transcripts, restartRepair: 'deferred' }),
  );
}

function appendRunningGroup(
  transcripts: StreamLogStore,
  stream: StreamTabId,
  id: string,
  timestamp = 1_000,
): void {
  appendTranscriptEntry(transcripts, stream, {
    id,
    type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
    level: LOG_LEVELS.INFO,
    timestamp,
    data: { status: STREAM_PHASE.RUNNING },
  });
}

function expectClosedWith(
  transcripts: StreamLogStore,
  stream: StreamTabId,
  status: string,
): void {
  expect(transcripts.get(stream)?.getRange(0).at(-1)).toMatchObject({
    type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
    data: { status },
  });
}

/**
 * Persist the stream→execution sidecar FK — since Axis T the ONE reverse
 * edge restart repair recognizes; name suffixes are never ownership.
 */
async function seedSidecarFk(
  stream: StreamTabId,
  ownedExecutionId: ExecutionId,
): Promise<void> {
  const snapshots = new StreamSnapshotStore();
  snapshotFacts(snapshots).setRunConfig(
    stream,
    AgentConfigSchema.parse({
      agent: 'chat',
      model: 'deepseekT',
      agentCategory: 'toolUse',
    }),
    ownedExecutionId,
  );
  await snapshots.flush();
}

/**
 * Writes a cancelled-but-resumable execution meta plus a valid flow record.
 * `streamId` is the authored execution→stream edge `registerExecution`
 * stamps; the checkpoint scan reads it to find stopped runs outside the seed.
 */
async function seedResumableExecution(
  id: ExecutionId,
  streamId?: StreamTabId,
): Promise<ReturnType<typeof getExecutionStore>> {
  const executionStore = getExecutionStore(id);
  await executionStore.writeMeta({
    timestamp: META_TIMESTAMP,
    outcome: RUN_OUTCOME.CANCELLED,
    ...(streamId ? { streamId } : {}),
  });
  await executionStore.write(flowKey(id), validFlowRecord);
  return executionStore;
}

/**
 * Mocks a pending workspace-storage root change, returning the commit mock so
 * callers can assert whether it was invoked.
 */
function mockPendingWorkspaceChange(
  opts: { pending?: boolean; commit?: boolean } = {},
): Mock<() => boolean> {
  const commitWorkspaceStorageChange = vi.fn(() => opts.commit ?? true);
  Object.assign(platform().storage, {
    hasPendingWorkspaceStorageChange: () => opts.pending ?? true,
    commitWorkspaceStorageChange,
  });
  return commitWorkspaceStorageChange;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const session of sessions) {
    session.dispose();
  }
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
  resetExecutionLeaseCoordinationForTests();
});

describe('SessionHandle restart repair', () => {
  it('stops in-flight restart repair when the session is disposed', async () => {
    const transcripts = await StreamLogStore.open();
    appendRunningGroup(transcripts, streamId, 'disposed-running-group');
    await transcripts.flush();
    await seedSidecarFk(streamId, executionId);

    let finishClassification:
      | ((classification: runClassification.RunClassification) => void)
      | undefined;
    const classificationBlocked =
      new Promise<runClassification.RunClassification>((resolve) => {
        finishClassification = resolve;
      });
    vi.spyOn(runClassification, 'classifyRun').mockReturnValue(
      classificationBlocked,
    );

    const session = openDeferredSession(transcripts);
    const readiness = session.waitUntilReady();
    await vi.waitFor(() => {
      expect(runClassification.classifyRun).toHaveBeenCalledOnce();
    });

    session.dispose();
    finishClassification?.({ kind: 'finished' });
    await expect(readiness).resolves.toBeUndefined();

    expect(session.status.get(streamId)).toBeUndefined();
    expect(transcripts.get(streamId)?.getRange(0)).toHaveLength(1);
    await expect(getExecutionStore(executionId).readMeta()).resolves.toBeNull();
  });

  it('shows a crashed run with a malformed checkpoint as unclassified, never finished', async () => {
    const transcripts = await StreamLogStore.open();
    appendRunningGroup(transcripts, streamId, 'crashed-running-group');
    await transcripts.flush();
    await seedSidecarFk(streamId, executionId);

    const executionStore = getExecutionStore(executionId);
    await executionStore.writeMeta({ timestamp: META_TIMESTAMP });
    await executionStore.write(flowKey(executionId), { invalid: true });

    await writeOrphanedLease(executionId);

    const session = openDeferredSession(transcripts);
    await session.waitUntilReady();

    // A present-but-invalid checkpoint is unknown state: no phase, no outcome
    // written, the transcript left open, the flow record untouched, and the
    // cause shown as malformed: Delete, not Resume, clears it.
    expect(session.status.get(streamId)).toBeUndefined();
    expect(session.status.holdState(streamId)).toEqual({
      kind: 'unclassified',
      cause: 'invalid-flow',
      retryable: false,
    });
    await expect(executionStore.readMeta()).resolves.toEqual(
      expect.not.objectContaining({ outcome: expect.anything() }),
    );
    await expect(executionStore.read(flowKey(executionId))).resolves.toEqual({
      invalid: true,
    });
    expect(transcripts.get(streamId)?.getRange(0)).toHaveLength(1);
  });

  // The CLI and the VS Code extension open the process session without
  // `restartRepair: 'deferred'`; desktop is the only host that defers repair
  // while it claims legacy stream identities.
  it('starts one repair pass at construction when the host does not defer it', async () => {
    const eagerExecutionId = 'ea9e4123' as ExecutionId;
    const eagerStreamId = `eager#${eagerExecutionId}` as StreamTabId;
    const transcripts = await StreamLogStore.open();
    appendRunningGroup(transcripts, eagerStreamId, 'eager-running-group');
    await transcripts.flush();
    await seedSidecarFk(eagerStreamId, eagerExecutionId);

    const executionStore = getExecutionStore(eagerExecutionId);
    await executionStore.writeMeta({ timestamp: META_TIMESTAMP });
    const classify = vi.spyOn(runClassification, 'classifyRun');

    const session = trackSession(new SessionHandle({ transcripts }));
    await session.waitUntilReady();

    // One pass, one ownership read: the settlement lease re-reads only the
    // durable facts, never ownership.
    expect(classify).toHaveBeenCalledOnce();
    expect(session.status.get(eagerStreamId)).toBe(STREAM_PHASE.CANCELLED);
    expectClosedWith(transcripts, eagerStreamId, RUN_OUTCOME.CANCELLED);
  });

  it('shows a stream with unreadable metadata as unclassified without failing readiness or the other streams', async () => {
    const otherExecutionId = 'd00d1234' as ExecutionId;
    const otherStreamId = `other#${otherExecutionId}` as StreamTabId;
    const transcripts = await StreamLogStore.open();
    appendRunningGroup(transcripts, streamId, 'malformed-meta-running-group');
    appendRunningGroup(transcripts, otherStreamId, 'other-running-group');
    await transcripts.flush();
    await seedSidecarFk(streamId, executionId);
    await seedSidecarFk(otherStreamId, otherExecutionId);

    const executionStore = getExecutionStore(executionId);
    const malformedMeta = { timestamp: 123 };
    await executionStore.write('meta', malformedMeta);
    await executionStore.write(flowKey(executionId), validFlowRecord);
    await getExecutionStore(otherExecutionId).writeMeta({
      timestamp: META_TIMESTAMP,
      outcome: RUN_OUTCOME.COMPLETED,
    });

    const session = openDeferredSession(transcripts);
    await expect(session.waitUntilReady()).resolves.toBeUndefined();

    // Nothing known about the unreadable run: no phase, nothing written, the
    // transcript left open, and the cause shown as malformed (Delete clears it).
    expect(session.status.get(streamId)).toBeUndefined();
    expect(session.status.holdState(streamId)).toEqual({
      kind: 'unclassified',
      cause: 'invalid-meta',
      retryable: false,
    });
    await expect(executionStore.read('meta')).resolves.toEqual(malformedMeta);
    await expect(executionStore.read(flowKey(executionId))).resolves.toEqual(
      validFlowRecord,
    );
    expect(transcripts.get(streamId)?.getRange(0)).toHaveLength(1);

    expect(session.status.get(otherStreamId)).toBe(STREAM_PHASE.COMPLETED);
    expectClosedWith(transcripts, otherStreamId, RUN_OUTCOME.COMPLETED);
  });

  it('offers Resume for a stopped run that kept its checkpoint', async () => {
    const stoppedExecutionId = '57a9ed12' as ExecutionId;
    const stoppedStreamId = `stopped#${stoppedExecutionId}` as StreamTabId;
    const transcripts = await StreamLogStore.open();
    // A user Stop closes the transcript group and records CANCELLED, but the
    // checkpoint is deleted only by the user or a COMPLETED run.
    appendRunningGroup(transcripts, stoppedStreamId, 'stopped-running-group');
    await transcripts.endRunningGroupsForStreams(
      [stoppedStreamId],
      2_000,
      RUN_OUTCOME.CANCELLED,
    );
    await transcripts.flush();
    await seedSidecarFk(stoppedStreamId, stoppedExecutionId);
    const executionStore = await seedResumableExecution(
      stoppedExecutionId,
      stoppedStreamId,
    );
    const classify = vi.spyOn(runClassification, 'classifyRun');
    const entriesBefore = transcripts.get(stoppedStreamId)?.getRange(0).length;

    const session = openDeferredSession(transcripts);
    await session.waitUntilReady();

    // Not transcript-unfinished, yet classified: resumable on its persisted
    // CANCELLED outcome, so the terminal display key lights Resume. Nothing
    // is rewritten and the closed transcript is left alone.
    expect(classify).toHaveBeenCalledWith(stoppedExecutionId);
    await expect(classify.mock.results[0]?.value).resolves.toEqual({
      kind: 'resumable',
      outcome: RUN_OUTCOME.CANCELLED,
    });
    expect(session.status.get(stoppedStreamId)).toBe(STREAM_PHASE.CANCELLED);
    expect(session.status.holdState(stoppedStreamId)).toBeUndefined();
    await expect(executionStore.readMeta()).resolves.toMatchObject({
      outcome: RUN_OUTCOME.CANCELLED,
    });
    await expect(
      executionStore.read(flowKey(stoppedExecutionId)),
    ).resolves.toEqual(validFlowRecord);
    expect(transcripts.get(stoppedStreamId)?.getRange(0)).toHaveLength(
      entriesBefore ?? -1,
    );
  });

  it('ignores malformed metadata for settled historical streams', async () => {
    const transcripts = await StreamLogStore.open();
    appendRunningGroup(transcripts, streamId, 'settled-history-running-group');
    await transcripts.endRunningGroupsForStreams(
      [streamId],
      2_000,
      RUN_OUTCOME.COMPLETED,
    );
    await transcripts.flush();
    const executionStore = getExecutionStore(executionId);
    const malformedMeta = { timestamp: null };
    await executionStore.write('meta', malformedMeta);

    const session = openDeferredSession(transcripts);
    await expect(session.waitUntilReady()).resolves.toBeUndefined();
    await expect(executionStore.read('meta')).resolves.toEqual(malformedMeta);
  });

  it('closes an orphaned group without rewriting its completed execution', async () => {
    const completedExecutionId = 'c0ffee123' as ExecutionId;
    const completedStreamId =
      `completed#${completedExecutionId}` as StreamTabId;
    const transcripts = await StreamLogStore.open();
    appendRunningGroup(
      transcripts,
      completedStreamId,
      'completed-running-group',
    );
    await transcripts.flush();
    await seedSidecarFk(completedStreamId, completedExecutionId);

    const executionStore = getExecutionStore(completedExecutionId);
    await executionStore.writeMeta({
      timestamp: META_TIMESTAMP,
      outcome: RUN_OUTCOME.COMPLETED,
    });

    const session = openDeferredSession(transcripts);
    await session.waitUntilReady();

    expect(session.status.get(completedStreamId)).toBe(STREAM_PHASE.COMPLETED);
    await expect(executionStore.readMeta()).resolves.toMatchObject({
      outcome: RUN_OUTCOME.COMPLETED,
    });
    expectClosedWith(transcripts, completedStreamId, RUN_OUTCOME.COMPLETED);
  });

  it('settles a crashed checkpointed run as CANCELLED and refuses follow-ups until resumed', async () => {
    const resumableExecutionId = 'facade123' as ExecutionId;
    const resumableStreamId =
      `resumable#${resumableExecutionId}` as StreamTabId;
    const transcripts = await StreamLogStore.open();
    appendRunningGroup(
      transcripts,
      resumableStreamId,
      'resumable-running-group',
    );
    await transcripts.flush();
    await seedSidecarFk(resumableStreamId, resumableExecutionId);
    const executionStore = getExecutionStore(resumableExecutionId);
    await executionStore.writeMeta({ timestamp: META_TIMESTAMP });
    await executionStore.write(flowKey(resumableExecutionId), validFlowRecord);
    await writeOrphanedLease(resumableExecutionId);

    const session = openDeferredSession(transcripts);
    await session.waitUntilReady();

    // Owner proven dead, checkpoint present: the interruption is recorded,
    // the checkpoint stays, and nothing is adopted. The explicit Resume
    // affordance is the only way to continue; a follow-up is handed back.
    expect(session.status.get(resumableStreamId)).toBe(STREAM_PHASE.CANCELLED);
    expect(session.status.holdState(resumableStreamId)).toBeUndefined();
    await expect(executionStore.readMeta()).resolves.toMatchObject({
      outcome: RUN_OUTCOME.CANCELLED,
    });
    await expect(
      executionStore.read(flowKey(resumableExecutionId)),
    ).resolves.toEqual(validFlowRecord);
    expectClosedWith(transcripts, resumableStreamId, RUN_OUTCOME.CANCELLED);

    const onAdmitted = vi.fn();
    await expect(
      submitFollowUp(resumableStreamId, 'are you there?', {
        session,
        onAdmitted,
      }),
    ).resolves.toEqual({
      status: 'no_session',
      streamStatus: STREAM_PHASE.CANCELLED,
    });
    expect(onAdmitted).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('seeds only unfinished streams and their transitive parent chain at startup', async () => {
    const child = 'bounded#child' as StreamTabId;
    const parent = 'bounded#parent' as StreamTabId;
    const grandparent = 'bounded#grandparent' as StreamTabId;
    const settled = 'bounded#settled' as StreamTabId;
    const childExecutionId = 'b0a00001' as ExecutionId;
    const parentExecutionId = 'b0a00002' as ExecutionId;
    const grandparentExecutionId = 'b0a00003' as ExecutionId;
    const settledExecutionId = 'b0a00004' as ExecutionId;

    const transcripts = await StreamLogStore.open();
    appendRunningGroup(transcripts, child, 'child-running-group');
    appendRunningGroup(transcripts, settled, 'settled-running-group');
    await transcripts.endRunningGroupsForStreams(
      [settled],
      2_000,
      RUN_OUTCOME.COMPLETED,
    );
    await transcripts.flush();
    transcripts.recordSummaryMeta(child, { parentStreamId: parent });
    transcripts.recordSummaryMeta(parent, { parentStreamId: grandparent });

    await seedSidecarFk(child, childExecutionId);
    await seedSidecarFk(parent, parentExecutionId);
    await seedSidecarFk(grandparent, grandparentExecutionId);
    await seedSidecarFk(settled, settledExecutionId);

    const session = openDeferredSession(transcripts);
    const preload = vi.spyOn(session.snapshots, 'preload');
    vi.spyOn(
      session as unknown as { runRestartRepair(): Promise<void> },
      'runRestartRepair',
    ).mockResolvedValue(undefined);

    await session.waitUntilReady();

    const expected = [child, parent, grandparent].sort();
    expect(preload).toHaveBeenCalledTimes(1);
    expect([...preload.mock.calls[0][0]].sort()).toEqual(expected);
    expect([...session.snapshots.getExecutionIdMap().keys()].sort()).toEqual(
      expected,
    );
  });

  it('does not settle a stream reused by a live run while classification is in flight', async () => {
    const reusedExecutionId = 'b0a00012' as ExecutionId;
    const reusedStreamId = 'reused#generation-change' as StreamTabId;

    const transcripts = await StreamLogStore.open();
    appendRunningGroup(transcripts, reusedStreamId, 'reused-running-group');
    await transcripts.flush();
    await seedSidecarFk(reusedStreamId, reusedExecutionId);
    await seedResumableExecution(reusedExecutionId);

    let finishClassification:
      | ((classification: runClassification.RunClassification) => void)
      | undefined;
    const classificationBlocked =
      new Promise<runClassification.RunClassification>((resolve) => {
        finishClassification = resolve;
      });
    vi.spyOn(runClassification, 'classifyRun').mockReturnValue(
      classificationBlocked,
    );

    const session = openDeferredSession(transcripts);
    const readiness = session.waitUntilReady();
    await vi.waitFor(() => {
      expect(runClassification.classifyRun).toHaveBeenCalledOnce();
    });

    // A live run reuses the stream while classification is blocked. The
    // generation recheck before mutation must drop the stale candidate
    // instead of settling this now-running stream.
    session.status.transition(
      reusedStreamId,
      STREAM_PHASE.RUNNING,
      'lifecycle',
    );
    finishClassification?.({ kind: 'resumable' });

    await readiness;
    expect(session.status.get(reusedStreamId)).toBe(STREAM_PHASE.RUNNING);
  });

  it('replaces stores with evictAll + bounded preload at the workspace-root boundary', async () => {
    const transcripts = await StreamLogStore.open();
    const session = openDeferredSession(transcripts);
    const reload = vi.spyOn(transcripts, 'reload').mockResolvedValue();
    const preloadSnapshots = vi.spyOn(session.snapshots, 'preload');
    const evictSnapshots = vi.spyOn(session.snapshots, 'evictAll');
    const loadSnapshots = vi.spyOn(session.snapshots, 'load');
    session.status.transition(
      'previous-workspace' as StreamTabId,
      STREAM_PHASE.RUNNING,
      'lifecycle',
    );

    await session.reloadAfterStorageRootChange();

    expect(reload).toHaveBeenCalledOnce();
    expect(evictSnapshots).toHaveBeenCalledOnce();
    expect(preloadSnapshots).toHaveBeenCalledWith([]);
    expect(loadSnapshots).not.toHaveBeenCalled();
    expect(
      session.status.get('previous-workspace' as StreamTabId),
    ).toBeUndefined();
  });

  it('waits for execution artifacts before replacing workspace stores', async () => {
    const liveExecutionId = 'workspace-live' as ExecutionId;
    const transcripts = await StreamLogStore.open();
    const session = openDeferredSession(transcripts);
    await acquireFreshExecutionLease(liveExecutionId);
    const reload = vi.spyOn(transcripts, 'reload').mockResolvedValue();

    try {
      const replacement = session.reloadAfterStorageRootChange();
      await Promise.resolve();

      expect(reload).not.toHaveBeenCalled();
      await completeOwnedExecutionLease(liveExecutionId);
      await replacement;

      expect(reload).toHaveBeenCalledOnce();
    } finally {
      await completeOwnedExecutionLease(liveExecutionId);
    }
  });

  it('keeps the old storage root pinned until execution artifacts finish', async () => {
    const liveExecutionId = 'workspace-root-pinned' as ExecutionId;
    const transcripts = await StreamLogStore.open();
    const session = openDeferredSession(transcripts);
    const storage = platform().storage;
    let activeRoot = '/workspace/old-storage';
    vi.spyOn(storage, 'getStoragePath').mockImplementation(() => activeRoot);
    Object.assign(storage, {
      hasPendingWorkspaceStorageChange: () => true,
      commitWorkspaceStorageChange: () => {
        activeRoot = '/workspace/new-storage';
        return true;
      },
    });
    await acquireFreshExecutionLease(liveExecutionId);
    const reload = vi.spyOn(transcripts, 'reload').mockResolvedValue();

    try {
      const replacement = session.reloadAfterStorageRootChange();
      await Promise.resolve();

      expect(storage.getStoragePath()).toBe('/workspace/old-storage');
      expect(reload).not.toHaveBeenCalled();

      await completeOwnedExecutionLease(liveExecutionId);
      await replacement;

      expect(storage.getStoragePath()).toBe('/workspace/new-storage');
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      await completeOwnedExecutionLease(liveExecutionId);
    }
  });

  it('flushes old-root stores before committing the new storage root', async () => {
    const transcripts = await StreamLogStore.open();
    const session = openDeferredSession(transcripts);
    const storage = platform().storage;
    const order: string[] = [];
    Object.assign(storage, {
      hasPendingWorkspaceStorageChange: () => true,
      commitWorkspaceStorageChange: () => {
        order.push('commit');
        return true;
      },
    });
    vi.spyOn(transcripts, 'flush').mockImplementation(async () => {
      order.push('transcripts.flush');
    });
    vi.spyOn(session.snapshots, 'flush').mockImplementation(async () => {
      order.push('snapshots.flush');
    });
    vi.spyOn(transcripts, 'reload').mockImplementation(async () => {
      order.push('transcripts.reload');
    });

    await session.reloadAfterStorageRootChange();

    expect(order.indexOf('transcripts.flush')).toBeLessThan(
      order.indexOf('commit'),
    );
    expect(order.indexOf('snapshots.flush')).toBeLessThan(
      order.indexOf('commit'),
    );
    expect(order.indexOf('commit')).toBeLessThan(
      order.indexOf('transcripts.reload'),
    );
  });

  it('does not commit a new root when the old transcript flush fails', async () => {
    const transcripts = await StreamLogStore.open();
    const session = openDeferredSession(transcripts);
    const commitWorkspaceStorageChange = mockPendingWorkspaceChange();
    const flushError = new Error('old transcript writes remain unresolved');
    vi.spyOn(transcripts, 'flush').mockRejectedValue(flushError);
    const reload = vi.spyOn(transcripts, 'reload');

    await expect(session.reloadAfterStorageRootChange()).rejects.toBe(
      flushError,
    );

    expect(commitWorkspaceStorageChange).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not commit a new root after disposal during the old-root flush', async () => {
    const transcripts = await StreamLogStore.open();
    const session = openDeferredSession(transcripts);
    const commitWorkspaceStorageChange = mockPendingWorkspaceChange();
    let finishFlush: (() => void) | undefined;
    const flushBlocked = new Promise<void>((resolve) => {
      finishFlush = resolve;
    });
    vi.spyOn(transcripts, 'flush').mockReturnValue(flushBlocked);

    const replacement = session.reloadAfterStorageRootChange();
    await vi.waitFor(() => {
      expect(transcripts.flush).toHaveBeenCalledOnce();
    });

    session.dispose();
    finishFlush?.();

    await expect(replacement).resolves.toBe(false);
    expect(commitWorkspaceStorageChange).not.toHaveBeenCalled();
  });

  it('rolls back a failed new-root load and permits retry', async () => {
    const transcripts = await StreamLogStore.open();
    const session = openDeferredSession(transcripts);
    const storage = platform().storage;
    let activeRoot = '/workspace/old-storage';
    const finalizeWorkspaceStorageChange = vi.fn();
    const rollbackWorkspaceStorageChange = vi.fn(() => {
      activeRoot = '/workspace/old-storage';
      return true;
    });
    Object.assign(storage, {
      getStoragePath: () => activeRoot,
      hasPendingWorkspaceStorageChange: () =>
        activeRoot === '/workspace/old-storage',
      commitWorkspaceStorageChange: () => {
        activeRoot = '/workspace/new-storage';
        return true;
      },
      finalizeWorkspaceStorageChange,
      rollbackWorkspaceStorageChange,
    });
    const reload = vi.spyOn(transcripts, 'reload').mockResolvedValue();
    const reloadError = new Error('new snapshot root is unreadable');
    vi.spyOn(session.snapshots, 'preload')
      .mockRejectedValueOnce(reloadError)
      .mockResolvedValue();
    const evictSnapshots = vi.spyOn(session.snapshots, 'evictAll');
    session.status.transition(
      'old-workspace-running' as StreamTabId,
      STREAM_PHASE.RUNNING,
      'lifecycle',
    );
    const transitionHooks = {
      workspacePath: '/workspace/new',
      afterStorageCommit: vi.fn(async () => {}),
      afterStorageRollback: vi.fn(),
      afterStorageFinalize: vi.fn(),
    };

    await expect(
      session.reloadAfterStorageRootChange(transitionHooks),
    ).rejects.toBe(reloadError);

    expect(activeRoot).toBe('/workspace/old-storage');
    expect(rollbackWorkspaceStorageChange).toHaveBeenCalledOnce();
    expect(transitionHooks.afterStorageCommit).toHaveBeenCalledOnce();
    expect(transitionHooks.afterStorageRollback).toHaveBeenCalledOnce();
    expect(transitionHooks.afterStorageFinalize).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(2);
    expect(evictSnapshots).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenNthCalledWith(2, {
      discardPendingWrites: true,
    });
    expect(session.status.get('old-workspace-running' as StreamTabId)).toBe(
      STREAM_PHASE.RUNNING,
    );

    await expect(
      session.reloadAfterStorageRootChange(transitionHooks),
    ).resolves.toBe(true);
    expect(activeRoot).toBe('/workspace/new-storage');
    expect(finalizeWorkspaceStorageChange).toHaveBeenCalledOnce();
    expect(transitionHooks.afterStorageCommit).toHaveBeenCalledTimes(2);
    expect(transitionHooks.afterStorageRollback).toHaveBeenCalledOnce();
    expect(transitionHooks.afterStorageFinalize).toHaveBeenCalledOnce();
  });

  it('holds a foreign-owned run read-only and settles it only on a later pass after the owner exits', async () => {
    const foreign = await startForeignInstance();
    const heldExecutionId = '9355abcd' as ExecutionId;
    const heldStreamId = `held#${heldExecutionId}` as StreamTabId;
    mockPendingWorkspaceChange({ pending: true, commit: false });
    const transcripts = await StreamLogStore.open();
    appendRunningGroup(transcripts, heldStreamId, 'held-running-group');
    await transcripts.flush();
    await seedSidecarFk(heldStreamId, heldExecutionId);
    const executionStore = getExecutionStore(heldExecutionId);
    await executionStore.writeMeta({ timestamp: META_TIMESTAMP });
    await executionStore.write(flowKey(heldExecutionId), validFlowRecord);
    await writeForeignLease(heldExecutionId, undefined, foreign.owner);

    const session = openDeferredSession(transcripts);

    try {
      await session.waitUntilReady();
      // Live foreign owner: held, no phase, nothing written, transcript open.
      expect(session.status.holdState(heldStreamId)).toEqual({
        kind: 'held',
        provable: true,
      });
      expect(session.status.get(heldStreamId)).toBeUndefined();
      expect((await executionStore.readMeta())?.outcome).toBeUndefined();
      expect(transcripts.get(heldStreamId)?.getRange(0)).toHaveLength(1);

      // No exit watch: the owner's death is noticed only by the next pass.
      await foreign.shutdown();
      await session.reloadAfterStorageRootChange();

      expect(session.status.holdState(heldStreamId)).toBeUndefined();
      expect(session.status.get(heldStreamId)).toBe(STREAM_PHASE.CANCELLED);
      await expect(executionStore.readMeta()).resolves.toMatchObject({
        outcome: RUN_OUTCOME.CANCELLED,
      });
      await expect(
        executionStore.read(flowKey(heldExecutionId)),
      ).resolves.toEqual(validFlowRecord);
      expectClosedWith(transcripts, heldStreamId, RUN_OUTCOME.CANCELLED);
    } finally {
      session.dispose();
    }
  });

  it('skips replacement when the workspace storage root is unchanged', async () => {
    const transcripts = await StreamLogStore.open();
    const session = openDeferredSession(transcripts);
    const commitWorkspaceStorageChange = mockPendingWorkspaceChange({
      pending: false,
      commit: false,
    });
    const reload = vi.spyOn(transcripts, 'reload').mockResolvedValue();

    await session.reloadAfterStorageRootChange();

    expect(commitWorkspaceStorageChange).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not resume a root replacement after session disposal', async () => {
    const liveExecutionId = 'workspace-disposed' as ExecutionId;
    const transcripts = await StreamLogStore.open();
    const session = openDeferredSession(transcripts);
    const commitWorkspaceStorageChange = mockPendingWorkspaceChange();
    await acquireFreshExecutionLease(liveExecutionId);

    try {
      const replacement = session.reloadAfterStorageRootChange();
      await Promise.resolve();
      expect(commitWorkspaceStorageChange).not.toHaveBeenCalled();

      session.dispose();
      await completeOwnedExecutionLease(liveExecutionId);

      await expect(replacement).resolves.toBe(false);
      expect(commitWorkspaceStorageChange).not.toHaveBeenCalled();
    } finally {
      await completeOwnedExecutionLease(liveExecutionId);
    }
  });

  it('holds new root executions outside the workspace replacement', async () => {
    const queuedExecutionId = 'workspace-queued' as ExecutionId;
    const transcripts = await StreamLogStore.open();
    const session = openDeferredSession(transcripts);
    let finishReload: (() => void) | undefined;
    const reloadBlocked = new Promise<void>((resolve) => {
      finishReload = resolve;
    });
    vi.spyOn(transcripts, 'reload').mockReturnValue(reloadBlocked);

    try {
      const replacement = session.reloadAfterStorageRootChange();
      await Promise.resolve();
      const acquisition = acquireFreshExecutionLease(queuedExecutionId);
      let acquired = false;
      void acquisition.then(() => {
        acquired = true;
      });
      await Promise.resolve();

      expect(acquired).toBe(false);
      finishReload?.();
      await replacement;
      await acquisition;

      expect(acquired).toBe(true);
    } finally {
      await completeOwnedExecutionLease(queuedExecutionId);
    }
  });

  it('surfaces a repair write failure at the readiness boundary', async () => {
    const transcripts = await StreamLogStore.open();
    appendRunningGroup(transcripts, streamId, 'failing-running-group');
    const repairError = new Error('restart repair write failed');
    vi.spyOn(transcripts, 'endRunningGroupsForStreams').mockRejectedValue(
      repairError,
    );

    const session = openDeferredSession(transcripts);
    await expect(session.waitUntilReady()).rejects.toBe(repairError);
  });
});
