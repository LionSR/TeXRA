import { Effect, Fiber } from 'effect';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import * as resumability from '@agent/storage/resumability';
import {
  presentFollowUpResult,
  submitFollowUp,
} from '@agent/followUp/ToolUseFollowUp';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import type { ToolUseFollowUpTarget } from '@agent/runtime/runRegistry';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { RunId } from '@shared/schemas';
import { createDeferred } from '@test/support/asyncTestUtils';
import { generateRunId } from '@utils/core';

function mockTryResume(): Mock<() => Promise<boolean>> {
  return vi.fn(async () => true);
}

function fakeSession(target: ToolUseFollowUpTarget): SessionHandle {
  return {
    runs: { getToolUseFollowUpTarget: () => target },
    readRunRecords: () => Effect.succeed([]),
    status: { clearHold: () => {}, markUnavailable: () => {} },
    followUps: new ToolUseFollowUpQueue(),
  } as unknown as SessionHandle;
}

function activeTarget(): ToolUseFollowUpTarget {
  return {
    kind: 'active',
    context: {
      ownerSession: {} as SessionHandle,
      requestImmediateCompaction: () => {},
      modelSwitchDisabledReason: () => undefined,
      switchModel: async () => {},
      interrupt: () => {},
    },
  };
}

describe('submitFollowUp', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the live child owner while waiting, between turns, and during a turn', async () => {
    const runId = generateRunId();
    const session = fakeSession({ kind: 'queue' });
    const child = session.followUps.claimLive(runId, 'child')!;
    const tryResumeRun = mockTryResume();

    for (const text of ['while waiting', 'between turns', 'during turn']) {
      await expect(
        Effect.runPromise(
          submitFollowUp(runId, text, {
            session,
            resumePort: { tryResumeRun },
          }),
        ),
      ).resolves.toMatchObject({ status: 'queued' });
    }

    expect(tryResumeRun).not.toHaveBeenCalled();
    expect(
      session.followUps
        .queue(child)
        .drainItems()
        .map((item) => item.text),
    ).toEqual(['while waiting', 'between turns', 'during turn']);
  });

  it('reports input admitted by a live flow as sent', async () => {
    const runId = generateRunId();
    const session = fakeSession(activeTarget());
    const sent: RunId[] = [];
    session.followUps.onSent((sentRunId) => sent.push(sentRunId));
    const flow = session.followUps.claimLive(runId, 'flow')!;
    const tryResumeRun = mockTryResume();

    await expect(
      Effect.runPromise(
        submitFollowUp(runId, 'during active turn', {
          session,
          resumePort: { tryResumeRun },
        }),
      ),
    ).resolves.toEqual({ status: 'sent' });

    expect(tryResumeRun).not.toHaveBeenCalled();
    expect(session.followUps.queue(flow).drainItems()).toMatchObject([
      { text: 'during active turn' },
    ]);
    expect(sent).toEqual([runId]);
  });

  it('does not report an automatic live-flow notification as user input', async () => {
    const runId = generateRunId();
    const session = fakeSession(activeTarget());
    const sent: RunId[] = [];
    session.followUps.onSent((sentRunId) => sent.push(sentRunId));
    const flow = session.followUps.claimLive(runId, 'flow')!;

    await expect(
      Effect.runPromise(
        submitFollowUp(runId, 'child progress', {
          session,
          mode: 'live_notification',
        }),
      ),
    ).resolves.toEqual({ status: 'queued' });

    expect(session.followUps.queue(flow).drainItems()).toMatchObject([
      { text: 'child progress' },
    ]);
    expect(sent).toEqual([]);
  });

  it('enqueues live notifications for a waiting parent without child owner', async () => {
    const runId = generateRunId();
    const session = fakeSession({ kind: 'queue' });
    const tryResumeRun = mockTryResume();

    // Create a child-owned entry (simulates a running child loop), then
    // release the lease so the entry exists but has no owner — the exact
    // state of a WAITING parent queue after a child finishes its turn and
    // a live_notification (progress update, run event) arrives.
    const child = session.followUps.claimLive(runId, 'child')!;
    session.followUps.release(child, 'recoverable');

    // live_notification on a WAITING queue without child owner should enqueue
    // without claiming recovery or triggering a stream resume.
    const result = await Effect.runPromise(
      submitFollowUp(runId, 'child progress', {
        session,
        resumePort: { tryResumeRun },
        mode: 'live_notification',
      }),
    );

    expect(result).toMatchObject({ status: 'queued' });
    expect(tryResumeRun).not.toHaveBeenCalled();
    expect(session.followUps.getAll(runId)).toEqual(['child progress']);
  });

  it('claims one recovery and orders repeated submissions once', async () => {
    const runId = generateRunId();
    const session = fakeSession({ kind: 'queue' });
    const barrier = createDeferred<boolean>();
    const claimed: unknown[] = [];
    const tryResumeRun = vi.fn((_: RunId, recovery: unknown) => {
      claimed.push(recovery);
      return barrier.promise;
    });

    const first = Effect.runPromise(
      submitFollowUp(runId, 'one', {
        session,
        resumePort: { tryResumeRun },
      }),
    );
    const second = Effect.runPromise(
      submitFollowUp(runId, 'two', {
        session,
        resumePort: { tryResumeRun },
      }),
    );
    const third = Effect.runPromise(
      submitFollowUp(runId, 'three', {
        session,
        resumePort: { tryResumeRun },
      }),
    );

    await vi.waitFor(() => {
      expect(tryResumeRun).toHaveBeenCalledTimes(1);
      expect(claimed).toHaveLength(1);
    });
    await expect(second).resolves.toEqual({ status: 'queued' });
    await expect(third).resolves.toEqual({ status: 'queued' });
    expect(session.followUps.getAll(runId)).toEqual(['one', 'two', 'three']);

    barrier.resolve(true);
    await expect(first).resolves.toEqual({ status: 'queued' });
  });

  it('releases declined recovery after the submitting fiber is interrupted', async () => {
    const runId = generateRunId();
    const session = fakeSession({ kind: 'queue' });
    const resumed = createDeferred<boolean>();
    const admitted = createDeferred<void>();
    const fiber = Effect.runFork(
      submitFollowUp(runId, 'keep this input', {
        session,
        resumePort: { tryResumeRun: () => resumed.promise },
        onAdmitted: () => admitted.resolve(),
      }),
    );
    await admitted.promise;
    await Effect.runPromise(Fiber.interrupt(fiber));
    resumed.resolve(false);
    await resumed.promise;

    const successor = session.followUps.claimLive(runId, 'child');
    expect(successor).toBeDefined();
    expect(session.followUps.queue(successor!).getAll()).toEqual([
      'keep this input',
    ]);
  });

  it('starts recovery after the child generation releases', async () => {
    const runId = generateRunId();
    const session = fakeSession({ kind: 'queue' });
    const child = session.followUps.claimLive(runId, 'child')!;
    session.followUps.release(child, 'recoverable');
    const tryResumeRun = mockTryResume();

    await expect(
      Effect.runPromise(
        submitFollowUp(runId, 'continue', {
          session,
          resumePort: { tryResumeRun },
        }),
      ),
    ).resolves.toEqual({ status: 'queued' });
    expect(tryResumeRun).toHaveBeenCalledTimes(1);
  });

  it('admits a child delivery to the retained queue after the parent completes', async () => {
    const runId = generateRunId();
    const session = fakeSession({ kind: 'queue' });
    const parent = session.followUps.claimLive(runId, 'flow')!;
    session.followUps.release(parent, 'recoverable');
    const deriveSpy = vi.spyOn(resumability, 'deriveResumability');
    const tryResumeRun = mockTryResume();

    await expect(
      Effect.runPromise(
        submitFollowUp(
          runId,
          { text: 'retained child result', origin: 'subagent_result' },
          {
            session,
            resumePort: { tryResumeRun },
          },
        ),
      ),
    ).resolves.toEqual({ status: 'queued' });

    expect(deriveSpy).not.toHaveBeenCalled();
    expect(session.followUps.getAll(runId)).toEqual(['retained child result']);
  });

  it('refuses child delivery to a parent with no session', async () => {
    const runId = generateRunId();
    const session = fakeSession({
      kind: 'no_session',
      runStatus: 'completed',
    });
    const tryResumeRun = mockTryResume();

    await expect(
      Effect.runPromise(
        submitFollowUp(
          runId,
          { text: 'late child result', origin: 'subagent_result' },
          {
            session,
            resumePort: { tryResumeRun },
          },
        ),
      ),
    ).resolves.toEqual({ status: 'failed', reason: 'not_resumable' });
    expect(tryResumeRun).not.toHaveBeenCalled();
  });

  it('admits a replayed child delivery at most once and wakes at most once', async () => {
    const runId = generateRunId();
    const session = fakeSession({ kind: 'queue' });
    const tryResumeRun = mockTryResume();
    const delivery = {
      text: 'child result',
      origin: 'subagent_result' as const,
      deliveryId: 'exec-1:turn:1:delivery',
    };

    await expect(
      Effect.runPromise(
        submitFollowUp(runId, delivery, {
          session,
          resumePort: { tryResumeRun },
        }),
      ),
    ).resolves.toEqual({ status: 'queued' });
    expect(tryResumeRun).toHaveBeenCalledTimes(1);

    // A producer repeating the same logical result callback must not append
    // another parent message nor trigger another parent wake.
    for (let replay = 0; replay < 100; replay++) {
      await expect(
        Effect.runPromise(
          submitFollowUp(runId, delivery, {
            session,
            resumePort: { tryResumeRun },
          }),
        ),
      ).resolves.toEqual({ status: 'sent' });
    }
    expect(tryResumeRun).toHaveBeenCalledTimes(1);
    expect(session.followUps.getAll(runId)).toEqual(['child result']);
  });
});

describe('ToolUseFollowUpQueue claim exclusivity', () => {
  it('makes recovery-vs-child claims exclusive in either order', () => {
    const runId = generateRunId();
    const recoveryFirst = new ToolUseFollowUpQueue();
    const submission = recoveryFirst.submit(
      runId,
      { text: 'recover' },
      'recoverable',
    );
    expect(submission).toMatchObject({ kind: 'queued' });
    expect(submission.kind === 'queued' && submission.lease).toBeTruthy();
    expect(recoveryFirst.claimLive(runId, 'child')).toBeUndefined();

    const childFirst = new ToolUseFollowUpQueue();
    expect(childFirst.claimLive(runId, 'child')).toBeDefined();
    expect(childFirst.claimRecovery(runId)).toBeUndefined();
  });
});

describe('ToolUseFollowUpQueue terminal tombstones', () => {
  it('evicts the oldest tombstone at the historical cap', () => {
    const followUps = new ToolUseFollowUpQueue();
    const runIds = Array.from(
      { length: ToolUseFollowUpQueue.TERMINALIZED_CAP + 1 },
      () => generateRunId(),
    );
    for (const runId of runIds) followUps.terminalize(runId);

    expect(
      followUps.submit(runIds[0]!, { text: 'after eviction' }, 'recoverable'),
    ).toMatchObject({ kind: 'queued' });
    expect(
      followUps.submit(
        runIds[1]!,
        { text: 'still terminalized' },
        'recoverable',
      ),
    ).toEqual({ kind: 'refused' });
  });
});

describe('presentFollowUpResult', () => {
  it('words only refusals, with a failed wake as information', () => {
    expect(presentFollowUpResult({ status: 'sent' })).toEqual({
      severity: 'none',
    });
    expect(presentFollowUpResult({ status: 'queued' })).toEqual({
      severity: 'none',
    });
    expect(
      presentFollowUpResult({ status: 'queued', wake: 'failed' }),
    ).toMatchObject({ severity: 'info' });
    expect(
      presentFollowUpResult({ status: 'failed', reason: 'owned_elsewhere' }),
    ).toMatchObject({
      severity: 'warning',
      message: expect.stringContaining('another TeXRA window'),
    });
  });
});
