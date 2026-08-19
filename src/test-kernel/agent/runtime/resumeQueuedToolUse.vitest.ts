import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResumeToolUseFromResumeDataOptions } from '@agent/runtime/executeAgent';
import { resumeQueuedToolUseFromResumeData } from '@agent/runtime/resumeQueuedToolUse';
import type { StreamTabId } from '@shared/schemas';
import { RUN_OUTCOME } from '@shared/schemas';
import { createDeferred } from '@test/support/asyncTestUtils';
import { createTestSession } from '@test/support/sessionTestUtils';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';

const resumeToolUseFromResumeDataMock = vi.hoisted(() => vi.fn());
vi.mock('@agent/runtime/executeAgent', () => ({
  resumeToolUseFromResumeData: resumeToolUseFromResumeDataMock,
  // The module under test narrows admission cancellation by `instanceof`; the
  // mocked launcher never throws one, so a stand-in class keeps that branch
  // false without pulling the real engine module into this test.
  ResumeAdmissionCancelledError: class extends Error {},
}));

const STREAM = 'stream:resume-ownership' as StreamTabId;
const completed = {
  category: 'toolUse' as const,
  outcome: RUN_OUTCOME.COMPLETED,
  executionId: 'exec:resume',
  streamId: STREAM,
  response: 'done',
  files: [],
  totalCostUsd: 0,
};
const isCancellationRequested = (): boolean => false;

function snapshot() {
  return createToolUseResumeData({ streamId: STREAM });
}

function seedRecoverable(
  session: ReturnType<typeof createTestSession>,
  ...texts: string[]
): void {
  const flow = session.followUps.claimLive(STREAM, 'flow')!;
  for (const text of texts) session.followUps.queue(flow).enqueue({ text });
  session.followUps.release(flow, 'recoverable');
}

const sessions: ReturnType<typeof createTestSession>[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
});

function createSession(): ReturnType<typeof createTestSession> {
  const session = createTestSession();
  sessions.push(session);
  return session;
}

describe('resumeQueuedToolUseFromResumeData ownership', () => {
  beforeEach(() => {
    resumeToolUseFromResumeDataMock.mockReset();
    resumeToolUseFromResumeDataMock.mockImplementation(
      async (_resume: unknown, options: ResumeToolUseFromResumeDataOptions) => {
        options.onFollowUpConsumed?.();
        return completed;
      },
    );
  });

  it('claims recovery before draining and preserves ordered raced input', async () => {
    const session = createSession();
    seedRecoverable(session, 'first');

    await expect(
      resumeQueuedToolUseFromResumeData(STREAM, snapshot(), {
        session,
        isCancellationRequested,
        onFollowUpQueueReady: () => {
          expect(
            session.followUps.submit(STREAM, { text: 'second' }, 'recoverable'),
          ).toEqual({ kind: 'recovering' });
        },
        onError: vi.fn(),
      }),
    ).resolves.toBe(true);

    const options = resumeToolUseFromResumeDataMock.mock
      .calls[0]?.[1] as ResumeToolUseFromResumeDataOptions;
    expect(options.drainedFollowUps?.map((item) => item.text)).toEqual([
      'first',
      'second',
    ]);
  });

  it('rejects a competing recovery consumer deterministically', async () => {
    const session = createSession();
    seedRecoverable(session, 'once');
    const barrier = createDeferred();
    resumeToolUseFromResumeDataMock.mockImplementationOnce(async () => {
      await barrier.promise;
      return completed;
    });

    const first = resumeQueuedToolUseFromResumeData(STREAM, snapshot(), {
      session,
      isCancellationRequested,
      onError: vi.fn(),
    });
    await vi.waitFor(() =>
      expect(resumeToolUseFromResumeDataMock).toHaveBeenCalledOnce(),
    );
    await expect(
      resumeQueuedToolUseFromResumeData(STREAM, snapshot(), {
        session,
        isCancellationRequested,
        onError: vi.fn(),
      }),
    ).resolves.toBe(false);
    barrier.resolve();
    await first;
    expect(resumeToolUseFromResumeDataMock).toHaveBeenCalledOnce();
  });

  it('restores an unconsumed batch after resume failure', async () => {
    const session = createSession();
    seedRecoverable(session, 'keep me');
    resumeToolUseFromResumeDataMock.mockRejectedValueOnce(new Error('failed'));

    await expect(
      resumeQueuedToolUseFromResumeData(STREAM, snapshot(), {
        session,
        isCancellationRequested,
        onError: vi.fn(),
      }),
    ).resolves.toBe(false);
    expect(session.followUps.getAll(STREAM)).toEqual(['keep me']);
  });

  it('replays a completed-child result that races a failed recovery', async () => {
    const session = createSession();
    seedRecoverable(session, 'original');
    let rejectResume!: (error: unknown) => void;
    const barrier = new Promise<never>((_resolve, reject) => {
      rejectResume = reject;
    });
    resumeToolUseFromResumeDataMock.mockReturnValueOnce(barrier);

    const resuming = resumeQueuedToolUseFromResumeData(STREAM, snapshot(), {
      session,
      isCancellationRequested,
      onError: vi.fn(),
    });
    await vi.waitFor(() =>
      expect(resumeToolUseFromResumeDataMock).toHaveBeenCalledOnce(),
    );

    expect(
      session.followUps.submit(
        STREAM,
        { text: 'completed child', origin: 'subagent_result' },
        'recoverable',
      ),
    ).toEqual({ kind: 'recovering' });
    rejectResume(new Error('resume failed'));

    await expect(resuming).resolves.toBe(false);
    expect(session.followUps.getAll(STREAM)).toEqual([
      'original',
      'completed child',
    ]);
  });

  it('adopts the exact recovery generation claimed by submission', async () => {
    const session = createSession();
    const submission = session.followUps.submit(
      STREAM,
      { text: 'claimed' },
      'recoverable',
    );
    expect(submission.kind).toBe('recovery');
    if (submission.kind !== 'recovery') throw new Error('recovery not claimed');
    const recovery = submission.lease;

    await expect(
      resumeQueuedToolUseFromResumeData(STREAM, snapshot(), {
        session,
        recovery,
        isCancellationRequested,
        onError: vi.fn(),
      }),
    ).resolves.toBe(true);
    expect(resumeToolUseFromResumeDataMock).toHaveBeenCalledOnce();
  });
});
