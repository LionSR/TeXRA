import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import { createTestSession } from '@test/support/sessionTestUtils';
import { snapshotFacts } from '@test/support/storeTestDrivers';

const resumabilityMocks = vi.hoisted(() => ({
  deriveResumability: vi.fn(),
}));

vi.mock('@agent/storage/resumability', () => ({
  deriveResumability: resumabilityMocks.deriveResumability,
}));

interface DeferredResumability {
  readonly promise: Promise<{
    readonly resumable: true;
    readonly cause: 'interrupted-with-flow';
  }>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

function createDeferredResumability(): DeferredResumability {
  let resolve: DeferredResumability['resolve'] = () => undefined;
  let reject: DeferredResumability['reject'] = () => undefined;
  const promise = new Promise<Awaited<DeferredResumability['promise']>>(
    (settle, fail) => {
      resolve = () =>
        settle({ resumable: true, cause: 'interrupted-with-flow' });
      reject = fail;
    },
  );
  return { promise, resolve, reject };
}

/**
 * `SessionHandle.repairWaitingIfResumable` is the lazy WAITING repair every
 * host follow-up path runs. It probes the same `deriveResumability` the startup
 * pass uses, so a follow-up for a resumable execution reaches the resume queue
 * rather than `no_session`.
 */
describe('SessionHandle.repairWaitingIfResumable', () => {
  setupPlatform();

  const { deriveResumability } = resumabilityMocks;

  let caseCounter = 0;
  let session: SessionHandle;
  let streamId: StreamTabId;
  let executionId: ExecutionId;

  function ownStream(owner: ExecutionId): void {
    snapshotFacts(session.snapshots).setRunStart({
      streamId,
      executionId: owner,
      identity: { kind: 'agent', agent: 'assistant' },
    });
  }

  beforeEach(() => {
    const n = caseCounter++;
    deriveResumability.mockReset();
    session = createTestSession();
    streamId = `stream:waiting-repair-${n}` as StreamTabId;
    executionId = `b${n.toString(16).padStart(5, '0')}` as ExecutionId;
    ownStream(executionId);
  });

  function seedCancelled(): void {
    session.status.transition(streamId, STREAM_PHASE.RUNNING, 'lifecycle');
    session.status.transition(streamId, STREAM_PHASE.CANCELLED, 'user-stop');
  }

  function repair(id: StreamTabId = streamId): Promise<boolean> {
    return session.repairWaitingIfResumable(id);
  }

  function mockResumable(): void {
    deriveResumability.mockResolvedValue({
      resumable: true,
      cause: 'interrupted-with-flow',
    });
  }

  /** A single-implementation deferred probe, wired into the mock. */
  function startDeferredProbe(): DeferredResumability {
    const deferred = createDeferredResumability();
    deriveResumability.mockImplementation(() => deferred.promise);
    return deferred;
  }

  it('does not overwrite status created during an absent-generation probe', async () => {
    const deferred = startDeferredProbe();

    const pending = repair();
    session.status.transition(streamId, STREAM_PHASE.RUNNING, 'lifecycle');
    deferred.resolve();

    await expect(pending).resolves.toBe(false);
    expect(session.status.get(streamId)).toBe(STREAM_PHASE.RUNNING);
  });

  it('restores a terminal stream to WAITING when its execution is resumable', async () => {
    seedCancelled();
    mockResumable();

    await expect(repair()).resolves.toBe(true);

    expect(deriveResumability).toHaveBeenCalledWith(executionId);
    expect(session.status.get(streamId)).toBe(STREAM_PHASE.WAITING);
  });

  it('restores a persisted execution whose status entry is absent', async () => {
    mockResumable();

    await expect(repair()).resolves.toBe(true);

    expect(deriveResumability).toHaveBeenCalledWith(executionId);
    expect(session.status.get(streamId)).toBe(STREAM_PHASE.WAITING);
  });

  it('prefers the persisted sidecar FK over a divergent summary mirror', async () => {
    seedCancelled();
    // Flush the run.start fact so the sidecar carries the authoritative FK,
    // then evict the resident record so the probe is forced to read the cold
    // sidecar instead of answering from the always-resident snapshot.
    await session.snapshots.flush();
    session.snapshots.evictAll();
    const divergentExecutionId = `c${executionId.slice(1)}` as ExecutionId;
    session.transcripts.recordSummaryMeta(streamId, {
      executionId: divergentExecutionId,
    });
    mockResumable();

    await expect(repair()).resolves.toBe(true);

    expect(deriveResumability).toHaveBeenCalledWith(executionId);
    expect(session.status.get(streamId)).toBe(STREAM_PHASE.WAITING);
  });

  it('does not reject follow-ups when the ownership recheck becomes unreadable', async () => {
    seedCancelled();
    // Start from a cold sidecar so the probe's initial ownership read and its
    // recheck both go through `readPersistedExecutionId`.
    await session.snapshots.flush();
    session.snapshots.evictAll();
    mockResumable();
    vi.spyOn(session.snapshots, 'readPersistedExecutionId')
      .mockResolvedValueOnce(executionId)
      .mockRejectedValueOnce(new Error('ownership recheck failed'));

    await expect(repair()).resolves.toBe(false);

    expect(deriveResumability).toHaveBeenCalledWith(executionId);
    expect(session.status.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
  });

  it('leaves the terminal phase alone when the execution is not resumable', async () => {
    seedCancelled();
    deriveResumability.mockResolvedValue({
      resumable: false,
      cause: 'missing-flow',
    });

    await expect(repair()).resolves.toBe(false);

    expect(session.status.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
  });

  it('reports an already-waiting stream without reading resumability', async () => {
    session.status.transition(streamId, STREAM_PHASE.RUNNING, 'lifecycle');
    session.status.transition(streamId, STREAM_PHASE.WAITING, 'wait');

    await expect(repair()).resolves.toBe(true);

    expect(deriveResumability).not.toHaveBeenCalled();
  });

  it('never repairs a live run', async () => {
    session.status.transition(streamId, STREAM_PHASE.RUNNING, 'lifecycle');

    await expect(repair()).resolves.toBe(false);

    expect(deriveResumability).not.toHaveBeenCalled();
    expect(session.status.get(streamId)).toBe(STREAM_PHASE.RUNNING);
  });

  it('skips the probe for a stream with no recorded execution', async () => {
    const unknownStream = `${streamId}:unknown` as StreamTabId;

    await expect(repair(unknownStream)).resolves.toBe(false);

    expect(deriveResumability).not.toHaveBeenCalled();
  });

  it('does not reject follow-ups when the persisted ownership read fails for an unseeded stream', async () => {
    const unseededStream = `${streamId}:unseeded` as StreamTabId;
    vi.spyOn(
      session.snapshots,
      'readPersistedExecutionId',
    ).mockRejectedValueOnce(new Error('storage read failed'));

    await expect(repair(unseededStream)).resolves.toBe(false);

    expect(deriveResumability).not.toHaveBeenCalled();
  });

  it('collapses concurrent probes for one stream onto the first', async () => {
    seedCancelled();
    const deferred = startDeferredProbe();

    const first = repair();
    const second = repair();

    await vi.waitFor(() => expect(deriveResumability).toHaveBeenCalledTimes(1));

    deferred.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(session.status.get(streamId)).toBe(STREAM_PHASE.WAITING);

    // The slot is released with the probe, so a later submission probes again.
    session.status.transition(streamId, STREAM_PHASE.RUNNING, 'resume');
    session.status.transition(streamId, STREAM_PHASE.CANCELLED, 'user-stop');
    deriveResumability.mockResolvedValue({
      resumable: false,
      cause: 'missing-flow',
    });
    await expect(repair()).resolves.toBe(false);
    expect(deriveResumability).toHaveBeenCalledTimes(2);
  });

  it('starts a distinct probe when resident and cold authorities would revalidate differently', async () => {
    seedCancelled();
    const residentDeferred = createDeferredResumability();
    const coldDeferred = createDeferredResumability();
    deriveResumability
      .mockImplementationOnce(() => residentDeferred.promise)
      .mockImplementationOnce(() => coldDeferred.promise);

    const resident = repair();
    await vi.waitFor(() => expect(deriveResumability).toHaveBeenCalledTimes(1));

    // Move the same stream to a cold sidecar while the resident probe is still
    // in flight. The in-flight slot must not be reused: a cold probe revalidates
    // against the sidecar, not the resident snapshot record.
    await session.snapshots.flush();
    session.snapshots.evictAll();
    const cold = repair();
    await vi.waitFor(() => expect(deriveResumability).toHaveBeenCalledTimes(2));

    coldDeferred.resolve();
    await expect(cold).resolves.toBe(true);
    residentDeferred.resolve();
    await expect(resident).resolves.toBe(false);
    expect(session.status.get(streamId)).toBe(STREAM_PHASE.WAITING);
  });

  it('shares rejection and releases the probe slot for retry', async () => {
    seedCancelled();
    const failure = new Error('resumability read failed');
    deriveResumability.mockRejectedValueOnce(failure);

    const first = repair();
    const second = repair();

    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    expect(deriveResumability).toHaveBeenCalledTimes(1);

    mockResumable();
    await expect(repair()).resolves.toBe(true);
    expect(deriveResumability).toHaveBeenCalledTimes(2);
  });

  it('does not join a stale probe after resume starts', async () => {
    seedCancelled();
    const deferred = startDeferredProbe();

    const first = repair();
    await vi.waitFor(() => expect(deriveResumability).toHaveBeenCalledTimes(1));
    session.status.transition(streamId, STREAM_PHASE.RUNNING, 'resume');
    const second = repair();

    await expect(second).resolves.toBe(false);
    expect(deriveResumability).toHaveBeenCalledTimes(1);
    expect(session.status.get(streamId)).toBe(STREAM_PHASE.RUNNING);

    deferred.resolve();
    await expect(first).resolves.toBe(false);
  });

  it('does not recreate a stream cleared during the probe', async () => {
    seedCancelled();
    const deferred = startDeferredProbe();

    const pending = repair();
    await vi.waitFor(() => expect(deriveResumability).toHaveBeenCalledTimes(1));
    session.status.clearStream(streamId);
    // Public residency reset - the per-stream evict is store-internal.
    session.snapshots.evictAll();
    deferred.resolve();

    await expect(pending).resolves.toBe(false);
    expect(session.status.get(streamId)).toBeUndefined();
  });

  it('does not repair a replacement execution', async () => {
    seedCancelled();
    const deferred = startDeferredProbe();

    const pending = repair();
    await vi.waitFor(() => expect(deriveResumability).toHaveBeenCalledTimes(1));
    const replacementExecutionId = `c${executionId.slice(1)}` as ExecutionId;
    ownStream(replacementExecutionId);
    await session.snapshots.flush();
    deferred.resolve();

    await expect(pending).resolves.toBe(false);
    expect(session.status.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
    expect(deriveResumability).toHaveBeenCalledWith(executionId);
  });

  it('starts a distinct probe for a replacement execution', async () => {
    seedCancelled();
    const originalDeferred = createDeferredResumability();
    const replacementDeferred = createDeferredResumability();
    deriveResumability.mockImplementation((requestedId: string) =>
      requestedId === executionId
        ? originalDeferred.promise
        : replacementDeferred.promise,
    );

    const original = repair();
    await vi.waitFor(() => expect(deriveResumability).toHaveBeenCalledTimes(1));
    const replacementExecutionId = `d${executionId.slice(1)}` as ExecutionId;
    ownStream(replacementExecutionId);
    await session.snapshots.flush();
    const replacement = repair();
    await vi.waitFor(() => expect(deriveResumability).toHaveBeenCalledTimes(2));

    expect(deriveResumability).toHaveBeenNthCalledWith(1, executionId);
    expect(deriveResumability).toHaveBeenNthCalledWith(
      2,
      replacementExecutionId,
    );

    replacementDeferred.resolve();
    await expect(replacement).resolves.toBe(true);
    originalDeferred.resolve();
    await expect(original).resolves.toBe(false);
    expect(session.status.get(streamId)).toBe(STREAM_PHASE.WAITING);
  });

  it('does not repair a recreated terminal generation', async () => {
    seedCancelled();
    const deferred = startDeferredProbe();

    const pending = repair();
    await vi.waitFor(() => expect(deriveResumability).toHaveBeenCalledTimes(1));
    session.status.clearStream(streamId);
    seedCancelled();
    deferred.resolve();

    await expect(pending).resolves.toBe(false);
    expect(session.status.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
  });

  it('does not let a stale rejected probe poison the WAITING fast path', async () => {
    seedCancelled();
    const failure = new Error('resumability read failed');
    const deferred = startDeferredProbe();

    const first = repair();
    await vi.waitFor(() => expect(deriveResumability).toHaveBeenCalledTimes(1));
    const firstRejection = expect(first).rejects.toBe(failure);
    session.status.transition(streamId, STREAM_PHASE.RUNNING, 'resume');
    session.status.transition(streamId, STREAM_PHASE.WAITING, 'wait');

    await expect(repair()).resolves.toBe(true);
    expect(deriveResumability).toHaveBeenCalledTimes(1);

    deferred.reject(failure);
    await firstRejection;
    expect(session.status.get(streamId)).toBe(STREAM_PHASE.WAITING);
  });

  it('starts a distinct probe for a new terminal generation', async () => {
    seedCancelled();
    const firstDeferred = createDeferredResumability();
    const secondDeferred = createDeferredResumability();
    deriveResumability
      .mockImplementationOnce(() => firstDeferred.promise)
      .mockImplementationOnce(() => secondDeferred.promise);

    const first = repair();
    await vi.waitFor(() => expect(deriveResumability).toHaveBeenCalledTimes(1));
    session.status.clearStream(streamId);
    seedCancelled();
    const second = repair();
    await vi.waitFor(() => expect(deriveResumability).toHaveBeenCalledTimes(2));

    firstDeferred.resolve();
    await expect(first).resolves.toBe(false);

    const third = repair();
    secondDeferred.resolve();

    await expect(Promise.all([second, third])).resolves.toEqual([true, true]);
    expect(deriveResumability).toHaveBeenCalledTimes(2);
    expect(session.status.get(streamId)).toBe(STREAM_PHASE.WAITING);
  });
});
