import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResumeToolUseFromResumeDataOptions } from '@agent/runtime/executeAgent';
import { resumeRun, resumeStream } from '@agent/runtime/resumeRun';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { AgentCategory, RUN_OUTCOME } from '@shared/schemas';
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

// The refusal path re-reads the durable facts, which the fixtures below do
// not seed: the store double answers only `readConfig`/`readMeta`.
const classifyRunMock = vi.hoisted(() => vi.fn());
vi.mock('@agent/runtime/runClassification', async (importActual) => ({
  ...(await importActual<typeof import('@agent/runtime/runClassification')>()),
  classifyRun: classifyRunMock,
}));

const readExecutionStreamIndexMock = vi.hoisted(() => vi.fn());
vi.mock('@agent/storage/executionListing', async (importActual) => ({
  ...(await importActual<typeof import('@agent/storage/executionListing')>()),
  readExecutionStreamIndex: readExecutionStreamIndexMock,
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
    classifyRunMock.mockReset().mockResolvedValue({ kind: 'finished' });
    readExecutionStreamIndexMock.mockReset().mockResolvedValue({
      byStream: new Map([[STREAM, EXECUTION]]),
      unreadable: new Map(),
    });
    resumeToolUseFromResumeDataMock.mockReset();
    resumeToolUseFromResumeDataMock.mockImplementation(
      async (_resume: unknown, options: ResumeToolUseFromResumeDataOptions) => {
        options.onFollowUpConsumed?.();
        return completed;
      },
    );
  });

  it('claims stream recovery before resolving the disk index', async () => {
    const session = createSession();
    const index = createDeferred<{
      byStream: ReadonlyMap<StreamTabId, ExecutionId>;
      unreadable: ReadonlyMap<ExecutionId, string>;
    }>();
    readExecutionStreamIndexMock.mockReturnValueOnce(index.promise);

    const resumed = resumeStream(STREAM, { session, executeWorkflow });
    expect(
      session.followUps.submit(STREAM, { text: 'raced' }, 'recoverable'),
    ).toEqual({ kind: 'queued' });

    index.resolve({
      byStream: new Map([[STREAM, EXECUTION]]),
      unreadable: new Map(),
    });
    await expect(resumed).resolves.toEqual({
      started: true,
      delivered: true,
      outcome: RUN_OUTCOME.COMPLETED,
    });
    const options = resumeToolUseFromResumeDataMock.mock
      .calls[0]?.[1] as ResumeToolUseFromResumeDataOptions;
    expect(options.drainedFollowUps?.map((item) => item.text)).toEqual([
      'raced',
    ]);
  });

  it('preserves raced input when stream lookup finds no execution', async () => {
    const session = createSession();
    const index = createDeferred<{
      byStream: ReadonlyMap<StreamTabId, ExecutionId>;
      unreadable: ReadonlyMap<ExecutionId, string>;
    }>();
    readExecutionStreamIndexMock.mockReturnValueOnce(index.promise);

    const resumed = resumeStream(STREAM, { session, executeWorkflow });
    expect(
      session.followUps.submit(STREAM, { text: 'raced' }, 'recoverable'),
    ).toEqual({ kind: 'queued' });

    index.resolve({ byStream: new Map(), unreadable: new Map() });
    await expect(resumed).resolves.toEqual({ failed: 'not_resumable' });
    expect(session.followUps.getAll(STREAM)).toEqual(['raced']);
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
          ).toEqual({ kind: 'queued' });
        },
      }),
    ).resolves.toEqual({
      started: true,
      delivered: true,
      outcome: RUN_OUTCOME.COMPLETED,
    });

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

  it('refuses a recovery lease invalidated during storage reads', async () => {
    const session = createSession();
    const submission = session.followUps.submit(
      STREAM,
      { text: 'stale' },
      'recoverable',
    );
    expect(submission).toMatchObject({ kind: 'queued' });
    if (submission.kind !== 'queued' || !submission.lease) {
      throw new Error('recovery not claimed');
    }
    const config = createDeferred<ReturnType<typeof snapshot>['agentConfig']>();
    getExecutionStoreMock.mockReturnValueOnce({
      readConfig: () => config.promise,
      readMeta: async () => ({ streamId: STREAM }),
    });

    const resumed = resumeRun(EXECUTION, {
      session,
      recovery: submission.lease,
      executeWorkflow,
    });
    session.followUps.terminalize(STREAM);
    config.resolve(snapshot().agentConfig);

    await expect(resumed).resolves.toEqual({ failed: 'not_resumable' });
    expect(resumeToolUseFromResumeDataMock).not.toHaveBeenCalled();
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
    ).toEqual({ kind: 'queued' });
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
    expect(submission).toMatchObject({ kind: 'queued' });
    if (submission.kind !== 'queued' || !submission.lease) {
      throw new Error('recovery not claimed');
    }
    const recovery = submission.lease;

    await expect(
      resumeRun(EXECUTION, { session, recovery, executeWorkflow }),
    ).resolves.toEqual({
      started: true,
      delivered: true,
      outcome: RUN_OUTCOME.COMPLETED,
    });
    expect(resumeToolUseFromResumeDataMock).toHaveBeenCalledOnce();
  });

  it('keeps caller-supplied input recoverable for workflow records', async () => {
    const session = createSession();
    const submission = session.followUps.submit(
      STREAM,
      { text: 'workflow input' },
      'recoverable',
    );
    expect(submission).toMatchObject({ kind: 'queued' });
    if (submission.kind !== 'queued' || !submission.lease) {
      throw new Error('recovery not claimed');
    }
    getExecutionStoreMock.mockReturnValueOnce({
      readConfig: async () => ({
        ...snapshot().agentConfig,
        agentCategory: AgentCategory.Workflow,
      }),
      readMeta: async () => ({ streamId: STREAM }),
    });
    retrieveSessionResumeDataMock.mockResolvedValueOnce(null);

    await expect(
      resumeRun(EXECUTION, {
        session,
        recovery: submission.lease,
        executeWorkflow,
      }),
    ).resolves.toEqual({ failed: 'finished' });
    expect(session.followUps.getAll(STREAM)).toEqual(['workflow input']);
  });

  it('refuses with `finished` when no checkpoint remains', async () => {
    const session = createSession();
    retrieveSessionResumeDataMock.mockResolvedValueOnce(null);

    await expect(
      resumeRun(EXECUTION, { session, executeWorkflow }),
    ).resolves.toEqual({ failed: 'finished' });
    expect(resumeToolUseFromResumeDataMock).not.toHaveBeenCalled();
    expect(session.status.holdState(STREAM)).toBeUndefined();
  });

  // An empty retrieval is also what a torn read of the owner's rewrite looks
  // like, so the refusal is decided from the lease: a run another process is
  // executing keeps its hold instead of being reported finished.
  it('refuses an empty retrieval held elsewhere as owned elsewhere', async () => {
    const session = createSession();
    retrieveSessionResumeDataMock.mockResolvedValueOnce(null);
    classifyRunMock.mockResolvedValueOnce({
      kind: 'held_elsewhere',
      owner: { pid: 4321, processStart: null, hostname: 'other-host' },
    });

    await expect(
      resumeRun(EXECUTION, { session, executeWorkflow }),
    ).resolves.toEqual({ failed: 'owned_elsewhere' });
    expect(session.status.holdState(STREAM)).toContain('4321');
  });
});
