import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResumeToolUseFromResumeDataOptions } from '@agent/runtime/executeAgent';
import { resumeRun } from '@agent/runtime/resumeRun';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { RUN_OUTCOME } from '@shared/schemas';
import { createDeferred } from '@test/support/asyncTestUtils';
import { createTestSession } from '@test/support/sessionTestUtils';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';

const resumeToolUseFromResumeDataMock = vi.hoisted(() => vi.fn());
vi.mock('@agent/runtime/executeAgent', async (importActual) => ({
  ...(await importActual<typeof import('@agent/runtime/executeAgent')>()),
  resumeToolUseFromResumeData: resumeToolUseFromResumeDataMock,
}));

const retrieveSessionResumeDataMock = vi.hoisted(() => vi.fn());
vi.mock('@agent/runtime/SessionResumeRetrieval', () => ({
  retrieveSessionResumeData: retrieveSessionResumeDataMock,
}));

const getExecutionStoreMock = vi.hoisted(() => vi.fn());
vi.mock('@agent/storage/ExecutionKVStore', async (importActual) => ({
  ...(await importActual<typeof import('@agent/storage/ExecutionKVStore')>()),
  getExecutionStore: getExecutionStoreMock,
}));

const EXECUTION = 'exec:resume' as ExecutionId;
const STREAM = 'stream:resume-ownership' as StreamTabId;
const completed = {
  category: 'toolUse' as const,
  outcome: RUN_OUTCOME.COMPLETED,
  executionId: EXECUTION,
  streamId: STREAM,
  response: 'done',
  files: [],
  totalCostUsd: 0,
};

function snapshot() {
  return createToolUseResumeData({ executionId: EXECUTION, streamId: STREAM });
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
  vi.spyOn(session.snapshots, 'preload').mockResolvedValue(undefined);
  return session;
}

const executeWorkflow = vi.fn(async () => {
  throw new Error('tool-use fixtures never launch a workflow');
});

describe('resumeRun tool-use queue ownership', () => {
  beforeEach(() => {
    getExecutionStoreMock.mockReset().mockReturnValue({
      readConfig: async () => snapshot().agentConfig,
      readMeta: async () => ({ streamId: STREAM }),
    });
    retrieveSessionResumeDataMock.mockReset().mockResolvedValue(snapshot());
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
      resumeRun(EXECUTION, {
        session,
        executeWorkflow,
        onFollowUpQueueReady: () => {
          expect(
            session.followUps.submit(STREAM, { text: 'second' }, 'recoverable'),
          ).toEqual({ kind: 'recovering' });
        },
      }),
    ).resolves.toBe('started');

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

    const first = resumeRun(EXECUTION, { session, executeWorkflow });
    await vi.waitFor(() =>
      expect(resumeToolUseFromResumeDataMock).toHaveBeenCalledOnce(),
    );
    await expect(
      resumeRun(EXECUTION, { session, executeWorkflow }),
    ).resolves.toEqual({ failed: 'not_resumable' });
    barrier.resolve();
    await first;
    expect(resumeToolUseFromResumeDataMock).toHaveBeenCalledOnce();
  });

  it('restores an unconsumed batch after resume failure', async () => {
    const session = createSession();
    seedRecoverable(session, 'keep me');
    resumeToolUseFromResumeDataMock.mockRejectedValueOnce(new Error('failed'));

    await expect(
      resumeRun(EXECUTION, { session, executeWorkflow }),
    ).rejects.toThrow('failed');
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

    const resuming = resumeRun(EXECUTION, { session, executeWorkflow });
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

    await expect(resuming).rejects.toThrow('resume failed');
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
      resumeRun(EXECUTION, { session, recovery, executeWorkflow }),
    ).resolves.toBe('started');
    expect(resumeToolUseFromResumeDataMock).toHaveBeenCalledOnce();
  });

  it('refuses with `finished` when no checkpoint remains', async () => {
    const session = createSession();
    retrieveSessionResumeDataMock.mockResolvedValueOnce(null);

    await expect(
      resumeRun(EXECUTION, { session, executeWorkflow }),
    ).resolves.toEqual({ failed: 'finished' });
    expect(resumeToolUseFromResumeDataMock).not.toHaveBeenCalled();
  });
});
