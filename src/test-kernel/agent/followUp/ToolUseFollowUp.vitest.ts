import { describe, expect, it, vi, type Mock } from 'vitest';

import * as resumability from '@agent/storage/resumability';
import {
  presentFollowUpResult,
  submitFollowUp,
} from '@agent/followUp/ToolUseFollowUp';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import type { ToolUseFollowUpTarget } from '@agent/runtime/executionRegistry';
import type { LiveToolUseFlowContext } from '@agent/runtime/ExecutionHandle';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { StreamTabId } from '@shared/schemas';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function mockTryResume(): Mock<() => Promise<boolean>> {
  return vi.fn(async () => true);
}

function fakeSession(target: ToolUseFollowUpTarget): SessionHandle {
  return {
    executions: { getToolUseFollowUpTarget: () => target },
    followUps: new ToolUseFollowUpQueue(),
    events: { emit: vi.fn() },
    snapshots: {
      getRunMetadata: () => ({}),
      readPersistedExecutionId: vi.fn(async () => undefined),
    },
  } as unknown as SessionHandle;
}

function activeTarget(
  appendFollowUp: LiveToolUseFlowContext['session']['appendFollowUp'],
): ToolUseFollowUpTarget {
  return {
    kind: 'active',
    context: {
      session: { appendFollowUp },
      modelHandler: { supportsManualCompaction: true },
      requestImmediateCompaction: () => {},
      modelSwitchDisabledReason: () => undefined,
      switchModel: async () => {},
      interrupt: () => {},
    },
  };
}

const id = (value: string) => value as StreamTabId;

describe('submitFollowUp', () => {
  it('uses the live child owner while waiting, between turns, and during a turn', async () => {
    const streamId = id('stream:live-child');
    const session = fakeSession({ kind: 'queue', reason: 'waiting' });
    const child = session.followUps.claimLive(streamId, 'child')!;
    const tryResumeStream = mockTryResume();

    for (const text of ['while waiting', 'between turns', 'during turn']) {
      await expect(
        submitFollowUp(streamId, text, {
          session,
          resumePort: { tryResumeStream },
        }),
      ).resolves.toMatchObject({
        status: 'queued',
        continuation: 'live',
      });
    }

    expect(tryResumeStream).not.toHaveBeenCalled();
    expect(
      session.followUps.drainItems(child).map((item) => item.text),
    ).toEqual(['while waiting', 'between turns', 'during turn']);
  });

  it('reports input admitted by a live flow as sent', async () => {
    const streamId = id('stream:live-flow');
    const appendFollowUp = vi.fn();
    const session = fakeSession(activeTarget(appendFollowUp));
    const flow = session.followUps.claimLive(streamId, 'flow')!;
    const tryResumeStream = mockTryResume();

    await expect(
      submitFollowUp(streamId, 'during active turn', {
        session,
        resumePort: { tryResumeStream },
      }),
    ).resolves.toEqual({ status: 'sent' });

    expect(tryResumeStream).not.toHaveBeenCalled();
    expect(appendFollowUp).not.toHaveBeenCalled();
    expect(session.followUps.drainItems(flow)).toMatchObject([
      { text: 'during active turn' },
    ]);
    expect(session.events.emit).toHaveBeenCalledWith({
      scope: 'session',
      event: {
        type: 'followUpSent',
        payload: { streamId },
      },
    });
  });

  it('does not report an automatic live-flow notification as user input', async () => {
    const streamId = id('stream:live-flow-notification');
    const session = fakeSession(activeTarget(vi.fn()));
    const flow = session.followUps.claimLive(streamId, 'flow')!;

    await expect(
      submitFollowUp(streamId, 'child progress', {
        session,
        mode: 'live_notification',
      }),
    ).resolves.toEqual({
      status: 'queued',
      reason: 'waiting',
      continuation: 'live',
    });

    expect(session.followUps.drainItems(flow)).toMatchObject([
      { text: 'child progress' },
    ]);
    expect(session.events.emit).not.toHaveBeenCalled();
  });

  it('enqueues live notifications for a waiting parent without child owner', async () => {
    const streamId = id('stream:waiting-notification');
    const session = fakeSession({ kind: 'queue', reason: 'waiting' });
    const tryResumeStream = mockTryResume();

    // Create a child-owned entry (simulates a running child loop), then
    // release the lease so the entry exists but has no owner — the exact
    // state of a WAITING parent queue after a child finishes its turn and
    // a live_notification (progress update, execution event) arrives.
    const child = session.followUps.claimLive(streamId, 'child')!;
    session.followUps.release(child, 'recoverable');

    // live_notification on a WAITING queue without child owner should enqueue
    // without claiming recovery or triggering a stream resume.
    const result = await submitFollowUp(streamId, 'child progress', {
      session,
      resumePort: { tryResumeStream },
      mode: 'live_notification',
    });

    expect(result).toMatchObject({
      status: 'queued',
      reason: 'waiting',
      continuation: 'live',
    });
    expect(tryResumeStream).not.toHaveBeenCalled();
    expect(session.followUps.getAll(streamId)).toEqual(['child progress']);
  });

  it('claims one recovery synchronously and orders repeated submissions once', async () => {
    const streamId = id('stream:recovery');
    const session = fakeSession({ kind: 'queue', reason: 'waiting' });
    const barrier = deferred<boolean>();
    const claimed: unknown[] = [];
    const tryResumeStream = vi.fn((_: StreamTabId, recovery: unknown) => {
      claimed.push(recovery);
      return barrier.promise;
    });

    const first = submitFollowUp(streamId, 'one', {
      session,
      resumePort: { tryResumeStream },
    });
    const second = submitFollowUp(streamId, 'two', {
      session,
      resumePort: { tryResumeStream },
    });
    const third = submitFollowUp(streamId, 'three', {
      session,
      resumePort: { tryResumeStream },
    });

    expect(tryResumeStream).toHaveBeenCalledTimes(1);
    expect(claimed).toHaveLength(1);
    await expect(second).resolves.toMatchObject({ continuation: 'recovering' });
    await expect(third).resolves.toMatchObject({ continuation: 'recovering' });
    expect(session.followUps.getAll(streamId)).toEqual(['one', 'two', 'three']);

    barrier.resolve(true);
    await expect(first).resolves.toMatchObject({ continuation: 'resumed' });
  });

  it('starts recovery after the child generation releases', async () => {
    const streamId = id('stream:child-release');
    const session = fakeSession({ kind: 'queue', reason: 'waiting' });
    const child = session.followUps.claimLive(streamId, 'child')!;
    session.followUps.release(child, 'recoverable');
    const tryResumeStream = mockTryResume();

    await expect(
      submitFollowUp(streamId, 'continue', {
        session,
        resumePort: { tryResumeStream },
      }),
    ).resolves.toMatchObject({ continuation: 'resumed' });
    expect(tryResumeStream).toHaveBeenCalledTimes(1);
  });

  it('enqueues live notifications for children-running parent without recovery', async () => {
    const streamId = id('stream:children-running-notification');
    const session = fakeSession({
      kind: 'queue',
      reason: 'children_running',
    });
    // Create a child-owned entry to simulate the parent having active children.
    const child = session.followUps.claimLive(streamId, 'child')!;
    // Release the child so the queue stays but loses its owner.
    session.followUps.release(child, 'recoverable');
    const tryResumeStream = mockTryResume();

    const result = await submitFollowUp(streamId, 'child update', {
      session,
      resumePort: { tryResumeStream },
      mode: 'live_notification',
    });

    expect(result).toMatchObject({
      status: 'queued',
      reason: 'children_running',
      continuation: 'live',
    });
    expect(tryResumeStream).not.toHaveBeenCalled();
    expect(session.followUps.getAll(streamId)).toEqual(['child update']);
  });

  it('keeps children-running explicitly recoverable after child untracking', async () => {
    const streamId = id('stream:children-running');
    const session = fakeSession({ kind: 'queue', reason: 'children_running' });
    const tryResumeStream = mockTryResume();

    await submitFollowUp(streamId, 'child result', {
      session,
      resumePort: { tryResumeStream },
    });

    expect(tryResumeStream).toHaveBeenCalledTimes(1);
  });

  it('delivers a final child result through the retained queue after child untracking', async () => {
    const streamId = id('stream:final-child-delivery');
    const session = fakeSession({
      kind: 'no_session',
      streamStatus: 'completed',
    });
    const parentFlow = session.followUps.claimLive(streamId, 'flow')!;
    session.followUps.release(parentFlow, 'recoverable');
    const tryResumeStream = mockTryResume();

    await expect(
      submitFollowUp(
        streamId,
        { text: 'final child result', origin: 'subagent_result' },
        {
          session,
          resumePort: { tryResumeStream },
          mode: 'child_delivery',
        },
      ),
    ).resolves.toEqual({
      status: 'queued',
      reason: 'children_running',
      continuation: 'resumed',
    });

    expect(tryResumeStream).toHaveBeenCalledTimes(1);
    expect(session.followUps.getAll(streamId)).toEqual(['final child result']);
  });

  it('trusts a matching retained generation after the parent completes', async () => {
    const streamId = id('stream:retained-child-generation');
    const generationId = 'a98f8f0a-b61a-4913-a88e-a934da14d4e5';
    const session = fakeSession({
      kind: 'queue',
      reason: 'children_running',
    });
    const parent = session.followUps.claimLive(streamId, 'flow', generationId)!;
    session.followUps.release(parent, 'recoverable');
    const deriveSpy = vi.spyOn(resumability, 'deriveResumability');
    const tryResumeStream = mockTryResume();

    await expect(
      submitFollowUp(
        streamId,
        { text: 'retained child result', origin: 'subagent_result' },
        {
          session,
          resumePort: { tryResumeStream },
          mode: 'child_delivery',
          expectedGenerationId: generationId,
        },
      ),
    ).resolves.toMatchObject({ status: 'queued', continuation: 'resumed' });

    expect(deriveSpy).not.toHaveBeenCalled();
    expect(session.followUps.getAll(streamId)).toEqual([
      'retained child result',
    ]);
  });

  it('does not let child delivery reopen a terminal parent queue', async () => {
    const streamId = id('stream:terminal-child-delivery');
    const session = fakeSession({
      kind: 'no_session',
      streamStatus: 'completed',
    });
    const tryResumeStream = mockTryResume();

    await expect(
      submitFollowUp(
        streamId,
        { text: 'late child result', origin: 'subagent_result' },
        {
          session,
          resumePort: { tryResumeStream },
          mode: 'child_delivery',
        },
      ),
    ).resolves.toEqual({ status: 'dropped' });
    expect(tryResumeStream).not.toHaveBeenCalled();
  });

  it('admits a replayed child delivery at most once and wakes at most once', async () => {
    const streamId = id('stream:replay-child-delivery');
    const session = fakeSession({ kind: 'queue', reason: 'children_running' });
    const tryResumeStream = mockTryResume();
    const delivery = {
      text: 'child result',
      origin: 'subagent_result' as const,
      deliveryId: 'exec-1:turn:1:delivery',
    };

    await expect(
      submitFollowUp(streamId, delivery, {
        session,
        resumePort: { tryResumeStream },
        mode: 'child_delivery',
      }),
    ).resolves.toMatchObject({ status: 'queued', continuation: 'resumed' });
    expect(tryResumeStream).toHaveBeenCalledTimes(1);

    // A producer repeating the same logical result callback must not append
    // another parent message nor trigger another parent wake.
    for (let replay = 0; replay < 100; replay++) {
      await expect(
        submitFollowUp(streamId, delivery, {
          session,
          resumePort: { tryResumeStream },
          mode: 'child_delivery',
        }),
      ).resolves.toEqual({ status: 'duplicate' });
    }
    expect(tryResumeStream).toHaveBeenCalledTimes(1);
    expect(session.followUps.getAll(streamId)).toEqual(['child result']);
  });

  it('rejects terminal queues and never invokes recovery', async () => {
    const streamId = id('stream:terminal');
    const session = fakeSession({ kind: 'queue', reason: 'waiting' });
    const lease = session.followUps.claimLive(streamId, 'flow')!;
    session.followUps.release(lease, 'terminal');
    const tryResumeStream = mockTryResume();

    await expect(
      submitFollowUp(streamId, 'late', {
        session,
        resumePort: { tryResumeStream },
      }),
    ).resolves.toEqual({ status: 'dropped' });
    expect(tryResumeStream).not.toHaveBeenCalled();
  });

  it('restores the persisted generation before admitting a durable producer', async () => {
    const streamId = id('stream:persisted-generation');
    const session = fakeSession({ kind: 'queue', reason: 'waiting' });
    const executionId = 'persisted-execution';
    const generationId = 'e63883b0-0fe0-48c7-9888-a2daeaab30a5';
    vi.spyOn(session.snapshots, 'getRunMetadata').mockReturnValue({
      executionId,
    } as never);
    vi.spyOn(resumability, 'deriveResumability').mockResolvedValue({
      resumable: true,
      cause: resumability.RESUMABILITY_CAUSE.MISSING_TERMINAL_WITH_FLOW,
      flowRecord: {
        flowName: 'texra',
        shared: { continuationGenerationId: generationId },
        createdAt: '2026-08-13T12:00:00.000Z',
        nodes: [],
      },
    });
    const tryResumeStream = mockTryResume();

    await expect(
      submitFollowUp(streamId, 'answer after reload', {
        session,
        resumePort: { tryResumeStream },
        expectedGenerationId: generationId,
      }),
    ).resolves.toMatchObject({
      status: 'queued',
      continuation: 'resumed',
    });
    expect(session.followUps.currentGenerationId(streamId)).toBe(generationId);
  });

  it('rebinds a provisional recovery before admitting a durable producer', async () => {
    const streamId = id('stream:provisional-recovery');
    const session = fakeSession({ kind: 'queue', reason: 'waiting' });
    const executionId = 'persisted-execution';
    const generationId = 'a2047268-908c-4ac5-8194-71fb377bd7f3';
    vi.spyOn(session.snapshots, 'getRunMetadata').mockReturnValue({
      executionId,
    } as never);
    vi.spyOn(resumability, 'deriveResumability').mockResolvedValue({
      resumable: true,
      cause: resumability.RESUMABILITY_CAUSE.MISSING_TERMINAL_WITH_FLOW,
      flowRecord: {
        flowName: 'texra',
        shared: { continuationGenerationId: generationId },
        createdAt: '2026-08-13T12:00:00.000Z',
        nodes: [],
      },
    });
    const provisional = session.followUps.claimRecovery(streamId, true)!;
    expect(provisional.generationId).not.toBe(generationId);

    await expect(
      submitFollowUp(streamId, 'answer during recovery startup', {
        session,
        resumePort: { tryResumeStream: mockTryResume() },
        expectedGenerationId: generationId,
      }),
    ).resolves.toMatchObject({ status: 'queued' });
    expect(provisional.generationId).toBe(generationId);
  });

  it('rebinds a released provisional recovery before durable admission', async () => {
    const streamId = id('stream:released-provisional-recovery');
    const session = fakeSession({ kind: 'queue', reason: 'waiting' });
    const executionId = 'persisted-execution';
    const generationId = '51c54412-e977-48ab-8304-53007cc0bb7a';
    vi.spyOn(session.snapshots, 'getRunMetadata').mockReturnValue({
      executionId,
    } as never);
    vi.spyOn(resumability, 'deriveResumability').mockResolvedValue({
      resumable: true,
      cause: resumability.RESUMABILITY_CAUSE.MISSING_TERMINAL_WITH_FLOW,
      flowRecord: {
        flowName: 'texra',
        shared: { continuationGenerationId: generationId },
        createdAt: '2026-08-13T12:00:00.000Z',
        nodes: [],
      },
    });
    const provisional = session.followUps.claimRecovery(streamId, true)!;
    session.followUps.release(provisional, 'recoverable');

    await expect(
      submitFollowUp(streamId, 'answer after failed recovery', {
        session,
        resumePort: { tryResumeStream: mockTryResume() },
        expectedGenerationId: generationId,
      }),
    ).resolves.toMatchObject({ status: 'queued', continuation: 'resumed' });
    expect(provisional.generationId).toBe(generationId);
  });
});

describe('ToolUseFollowUpQueue claim exclusivity', () => {
  it('makes recovery-vs-child claims exclusive in either order', () => {
    const streamId = id('stream:claim-race');
    const recoveryFirst = new ToolUseFollowUpQueue();
    expect(
      recoveryFirst.submit(streamId, { text: 'recover' }, 'recoverable').kind,
    ).toBe('recovery');
    expect(recoveryFirst.claimLive(streamId, 'child')).toBeUndefined();

    const childFirst = new ToolUseFollowUpQueue();
    expect(childFirst.claimLive(streamId, 'child')).toBeDefined();
    expect(childFirst.claimRecovery(streamId)).toBeUndefined();
  });
});

describe('presentFollowUpResult', () => {
  it('maps merged host outcomes without ownership checks', () => {
    expect(presentFollowUpResult({ status: 'sent' })).toEqual({
      severity: 'none',
    });
    expect(
      presentFollowUpResult({
        status: 'queued',
        reason: 'waiting',
        continuation: 'resume_failed',
      }),
    ).toMatchObject({ severity: 'info' });
    expect(presentFollowUpResult({ status: 'dropped' })).toMatchObject({
      severity: 'warning',
    });
  });
});
