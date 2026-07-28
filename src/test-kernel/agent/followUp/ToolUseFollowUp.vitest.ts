import { describe, expect, it, vi } from 'vitest';

import {
  presentFollowUpResult,
  submitFollowUp,
} from '@agent/followUp/ToolUseFollowUp';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import type { ToolUseFollowUpTarget } from '@agent/runtime/executionRegistry';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { StreamTabId } from '@shared/schemas';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeSession(target: ToolUseFollowUpTarget): SessionHandle {
  return {
    executions: { getToolUseFollowUpTarget: () => target },
    followUps: new ToolUseFollowUpQueue(),
    events: { emit: vi.fn() },
  } as unknown as SessionHandle;
}

const id = (value: string) => value as StreamTabId;

describe('submitFollowUp', () => {
  it('uses the live child owner while waiting, between turns, and during a turn', async () => {
    const streamId = id('stream:live-child');
    const session = fakeSession({ kind: 'queue', reason: 'waiting' });
    const child = session.followUps.claimLive(streamId, 'child')!;
    const tryResumeStream = vi.fn(async () => true);

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

  it('enqueues live notifications for a waiting parent without child owner', async () => {
    const streamId = id('stream:waiting-notification');
    const session = fakeSession({ kind: 'queue', reason: 'waiting' });
    const tryResumeStream = vi.fn(async () => true);

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
    const tryResumeStream = vi.fn(async () => true);

    await expect(
      submitFollowUp(streamId, 'continue', {
        session,
        resumePort: { tryResumeStream },
      }),
    ).resolves.toMatchObject({ continuation: 'resumed' });
    expect(tryResumeStream).toHaveBeenCalledTimes(1);
  });

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
    const tryResumeStream = vi.fn(async () => true);

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
    const tryResumeStream = vi.fn(async () => true);

    await submitFollowUp(streamId, 'child result', {
      session,
      resumePort: { tryResumeStream },
    });

    expect(tryResumeStream).toHaveBeenCalledTimes(1);
  });

  it('rejects terminal queues and never invokes recovery', async () => {
    const streamId = id('stream:terminal');
    const session = fakeSession({ kind: 'queue', reason: 'waiting' });
    const lease = session.followUps.claimLive(streamId, 'flow')!;
    session.followUps.release(lease, 'terminal');
    const tryResumeStream = vi.fn(async () => true);

    await expect(
      submitFollowUp(streamId, 'late', {
        session,
        resumePort: { tryResumeStream },
      }),
    ).resolves.toEqual({ status: 'dropped' });
    expect(tryResumeStream).not.toHaveBeenCalled();
  });

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
