import { Effect, Fiber } from 'effect';
import { it } from '@effect/vitest';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { PersistedFlowStateError } from '@agent/node/persistedFlow';
import type { ResumeToolUseFromResumeDataOptions } from '@agent/runtime/executeAgent';
import { resumeRun, resumeStream } from '@agent/runtime/resumeRun';
import type { RunId, StreamTabId } from '@shared/schemas';
import { AgentCategory, RUN_OUTCOME } from '@shared/schemas';
import { DatabaseReadFailed } from '@shared/session/database';
import { streamHeldMessage } from '@shared/streams/streamStatusDisplay';
import { createDeferred } from '@test/support/asyncTestUtils';
import { createTestSession } from '@test/support/sessionTestUtils';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';
import { ensureError } from '@utils/errors/errorMessage';

const resumeToolUseFromResumeDataMock = vi.hoisted(() => vi.fn());
vi.mock('@agent/runtime/executeAgent', async (importActual) => ({
  ...(await importActual<typeof import('@agent/runtime/executeAgent')>()),
  resumeToolUseFromResumeData: resumeToolUseFromResumeDataMock,
}));

const retrieveSessionResumeDataMock = vi.hoisted(() => vi.fn());
vi.mock('@agent/runtime/SessionResumeRetrieval', () => ({
  retrieveSessionResumeData: (...args: unknown[]) =>
    Effect.tryPromise({
      try: () => retrieveSessionResumeDataMock(...args),
      catch: ensureError,
    }),
}));

const getExecutionStoreMock = vi.hoisted(() => vi.fn());
vi.mock('@agent/storage/ExecutionKVStore', async (importActual) => ({
  ...(await importActual<typeof import('@agent/storage/ExecutionKVStore')>()),
  getRunStore: getExecutionStoreMock,
  getRunRecords: () => {
    const store = getExecutionStoreMock();
    return {
      readConfig: () =>
        Effect.tryPromise({
          try: () => store.readConfig(),
          catch: ensureError,
        }),
      readMeta: () =>
        Effect.tryPromise({ try: () => store.readMeta(), catch: ensureError }),
    };
  },
}));

// The refusal path re-reads the durable facts, which the fixtures below do
// not seed: the store double answers only `readConfig`/`readMeta`/`exists`.
const classifyRunMock = vi.hoisted(() => vi.fn());
vi.mock('@agent/runtime/runClassification', async (importActual) => ({
  ...(await importActual<typeof import('@agent/runtime/runClassification')>()),
  classifyRun: (...args: unknown[]) =>
    Effect.promise(() => classifyRunMock(...args)),
}));

const inspectExecutionLeaseMock = vi.hoisted(() => vi.fn());
vi.mock('@agent/storage/executionLease', async (importActual) => ({
  ...(await importActual<typeof import('@agent/storage/executionLease')>()),
  inspectRunLease: inspectExecutionLeaseMock,
}));

const EXECUTION = 'aabbcc' as RunId;
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
  vi.spyOn(session.snapshots, 'preload').mockReturnValue(Effect.void);
  vi.spyOn(session.snapshots, 'getRunMetadata').mockReturnValue({
    executionId: EXECUTION,
  });
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
      exists: async () => false,
    });
    retrieveSessionResumeDataMock.mockReset().mockResolvedValue(snapshot());
    classifyRunMock.mockReset().mockResolvedValue({ kind: 'finished' });
    inspectExecutionLeaseMock.mockReset().mockResolvedValue({ status: 'free' });
    resumeToolUseFromResumeDataMock.mockReset();
    resumeToolUseFromResumeDataMock.mockImplementation(
      (_resume: unknown, options: ResumeToolUseFromResumeDataOptions) =>
        Effect.sync(() => {
          options.onFollowUpConsumed?.();
          return completed;
        }),
    );
  });

  it.live(
    'executes cold preload before retrieval and retains input when it fails',
    () =>
      Effect.gen(function* () {
        const session = createSession();
        seedRecoverable(session, 'Keep this input.');
        vi.mocked(session.snapshots.getRunMetadata).mockReturnValue({});
        const failure = new DatabaseReadFailed({
          path: ':memory:',
          cause: new Error('Corrupt stream prefix'),
        });
        vi.mocked(session.snapshots.preload).mockReturnValueOnce(
          Effect.fail(failure),
        );
        expect(
          yield* Effect.flip(
            resumeRun(EXECUTION, { session, executeWorkflow }),
          ),
        ).toBe(failure);
        expect(retrieveSessionResumeDataMock).not.toHaveBeenCalled();
        expect(session.followUps.getAll(STREAM)).toEqual(['Keep this input.']);
      }),
  );

  it.live(
    'claims stream recovery before reading committed stream metadata',
    () =>
      Effect.gen(function* () {
        const session = createSession();
        const preload = createDeferred<void>();
        const preloadStarted = createDeferred<void>();
        vi.mocked(session.snapshots.preload).mockReturnValueOnce(
          Effect.promise(() => {
            preloadStarted.resolve();
            return preload.promise;
          }),
        );

        const resumed = yield* Effect.forkChild(
          resumeStream(STREAM, { session, executeWorkflow }),
        );
        yield* Effect.promise(() => preloadStarted.promise);
        expect(
          session.followUps.submit(STREAM, { text: 'raced' }, 'recoverable'),
        ).toEqual({ kind: 'queued' });

        preload.resolve();
        expect(yield* Fiber.join(resumed)).toEqual({
          started: true,
          delivered: true,
          outcome: RUN_OUTCOME.COMPLETED,
        });
        const options = resumeToolUseFromResumeDataMock.mock
          .calls[0]?.[1] as ResumeToolUseFromResumeDataOptions;
        expect(options.drainedFollowUps?.map((item) => item.text)).toEqual([
          'raced',
        ]);
      }),
  );

  it.live('preserves raced input when stream lookup finds no execution', () =>
    Effect.gen(function* () {
      const session = createSession();
      const preload = createDeferred<void>();
      const preloadStarted = createDeferred<void>();
      vi.mocked(session.snapshots.preload).mockReturnValueOnce(
        Effect.promise(() => {
          preloadStarted.resolve();
          return preload.promise;
        }),
      );

      const resumed = yield* Effect.forkChild(
        resumeStream(STREAM, { session, executeWorkflow }),
      );
      yield* Effect.promise(() => preloadStarted.promise);
      expect(
        session.followUps.submit(STREAM, { text: 'raced' }, 'recoverable'),
      ).toEqual({ kind: 'queued' });

      vi.mocked(session.snapshots.getRunMetadata).mockReturnValue({});
      preload.resolve();
      expect(yield* Fiber.join(resumed)).toEqual({ failed: 'not_resumable' });
      expect(session.followUps.getAll(STREAM)).toEqual(['raced']);
    }),
  );

  it.live(
    'claims recovery before draining and preserves ordered raced input',
    () =>
      Effect.gen(function* () {
        const session = createSession();
        seedRecoverable(session, 'first');

        expect(
          yield* resumeRun(EXECUTION, {
            session,
            executeWorkflow,
            onFollowUpQueueReady: () => {
              expect(
                session.followUps.submit(
                  STREAM,
                  { text: 'second' },
                  'recoverable',
                ),
              ).toEqual({ kind: 'queued' });
            },
          }),
        ).toEqual({
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
      }),
  );

  it.live('rejects a competing recovery consumer deterministically', () =>
    Effect.gen(function* () {
      const session = createSession();
      seedRecoverable(session, 'once');
      const barrier = createDeferred();
      resumeToolUseFromResumeDataMock.mockReturnValueOnce(
        Effect.promise(() => barrier.promise).pipe(Effect.as(completed)),
      );

      const first = yield* Effect.forkChild(
        resumeRun(EXECUTION, { session, executeWorkflow }),
      );
      yield* Effect.promise(() =>
        vi.waitFor(() =>
          expect(resumeToolUseFromResumeDataMock).toHaveBeenCalledOnce(),
        ),
      );
      expect(yield* resumeRun(EXECUTION, { session, executeWorkflow })).toEqual(
        { failed: 'not_resumable' },
      );
      barrier.resolve();
      yield* Fiber.join(first);
      expect(resumeToolUseFromResumeDataMock).toHaveBeenCalledOnce();
    }),
  );

  it.live('refuses a recovery lease invalidated during storage reads', () =>
    Effect.gen(function* () {
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
      const config =
        createDeferred<ReturnType<typeof snapshot>['agentConfig']>();
      getExecutionStoreMock.mockReturnValueOnce({
        readConfig: () => config.promise,
        readMeta: async () => ({ streamId: STREAM }),
      });

      const resumed = yield* Effect.forkChild(
        resumeRun(EXECUTION, {
          session,
          recovery: submission.lease,
          executeWorkflow,
        }),
      );
      session.followUps.terminalize(STREAM);
      config.resolve(snapshot().agentConfig);

      expect(yield* Fiber.join(resumed)).toEqual({ failed: 'not_resumable' });
      expect(resumeToolUseFromResumeDataMock).not.toHaveBeenCalled();
    }),
  );

  it.live('restores an unconsumed batch after resume failure', () =>
    Effect.gen(function* () {
      const session = createSession();
      seedRecoverable(session, 'keep me');
      resumeToolUseFromResumeDataMock.mockReturnValueOnce(
        Effect.fail(new Error('failed')),
      );

      expect(
        (yield* Effect.flip(resumeRun(EXECUTION, { session, executeWorkflow })))
          .message,
      ).toContain('failed');
      expect(session.followUps.getAll(STREAM)).toEqual(['keep me']);
    }),
  );

  it.live('replays a completed-child result that races a failed recovery', () =>
    Effect.gen(function* () {
      const session = createSession();
      seedRecoverable(session, 'original');
      let rejectResume!: (error: unknown) => void;
      const barrier = new Promise<never>((_resolve, reject) => {
        rejectResume = reject;
      });
      resumeToolUseFromResumeDataMock.mockReturnValueOnce(
        Effect.tryPromise({
          try: () => barrier,
          catch: (error) => error,
        }),
      );

      const resuming = yield* Effect.forkChild(
        resumeRun(EXECUTION, { session, executeWorkflow }),
      );
      yield* Effect.promise(() =>
        vi.waitFor(() =>
          expect(resumeToolUseFromResumeDataMock).toHaveBeenCalledOnce(),
        ),
      );

      expect(
        session.followUps.submit(
          STREAM,
          { text: 'completed child', origin: 'subagent_result' },
          'recoverable',
        ),
      ).toEqual({ kind: 'queued' });
      rejectResume(new Error('resume failed'));

      expect((yield* Effect.flip(Fiber.join(resuming))).message).toContain(
        'resume failed',
      );
      expect(session.followUps.getAll(STREAM)).toEqual([
        'original',
        'completed child',
      ]);
    }),
  );

  it.live('adopts the exact recovery generation claimed by submission', () =>
    Effect.gen(function* () {
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

      expect(
        yield* resumeRun(EXECUTION, { session, recovery, executeWorkflow }),
      ).toEqual({
        started: true,
        delivered: true,
        outcome: RUN_OUTCOME.COMPLETED,
      });
      expect(resumeToolUseFromResumeDataMock).toHaveBeenCalledOnce();
    }),
  );

  it.live('keeps caller-supplied input recoverable for workflow records', () =>
    Effect.gen(function* () {
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
        exists: async () => false,
      });
      retrieveSessionResumeDataMock.mockResolvedValueOnce(null);

      expect(
        yield* resumeRun(EXECUTION, {
          session,
          recovery: submission.lease,
          executeWorkflow,
        }),
      ).toEqual({ failed: 'finished' });
      expect(session.followUps.getAll(STREAM)).toEqual(['workflow input']);
    }),
  );

  it.live('refuses with `finished` when no checkpoint remains', () =>
    Effect.gen(function* () {
      const session = createSession();
      retrieveSessionResumeDataMock.mockResolvedValueOnce(null);

      expect(yield* resumeRun(EXECUTION, { session, executeWorkflow })).toEqual(
        { failed: 'finished' },
      );
      expect(resumeToolUseFromResumeDataMock).not.toHaveBeenCalled();
      expect(session.status.holdState(STREAM)).toBeUndefined();
    }),
  );

  // An empty retrieval is also what a torn read of the owner's rewrite looks
  // like, so the refusal is decided from the lease: a run another process is
  // executing keeps its hold instead of being reported finished.
  it.live('refuses an empty retrieval held elsewhere as owned elsewhere', () =>
    Effect.gen(function* () {
      const session = createSession();
      retrieveSessionResumeDataMock.mockResolvedValueOnce(null);
      classifyRunMock.mockResolvedValueOnce({
        kind: 'held_elsewhere',
        owner: { pid: 4321, processStart: null, hostname: 'other-host' },
      });

      expect(yield* resumeRun(EXECUTION, { session, executeWorkflow })).toEqual(
        { failed: 'owned_elsewhere' },
      );
      expect(session.status.holdState(STREAM)).toContain('4321');
    }),
  );

  // History listings advertise a row from the checkpoint file alone, so a file
  // that yields no resume state is refused as unusable state — telling that
  // user the run "has finished", or throwing retrieval's internal wording at
  // them, are the two ways this used to go wrong.
  it.live.each([
    [
      'retrieval answers empty',
      (): void =>
        void retrieveSessionResumeDataMock.mockResolvedValueOnce(null),
    ],
    [
      'retrieval throws on a record it cannot resume',
      (): void =>
        void retrieveSessionResumeDataMock.mockRejectedValueOnce(
          new Error('Failed to retrieve tool-use resume data', {
            cause: new PersistedFlowStateError(EXECUTION, 'unsupported-record'),
          }),
        ),
    ],
  ] as const)(
    'refuses a checkpoint as unusable when %s',
    ([_description, arrange]) =>
      Effect.gen(function* () {
        const session = createSession();
        getExecutionStoreMock.mockReturnValue({
          readConfig: async () => snapshot().agentConfig,
          readMeta: async () => ({ streamId: STREAM }),
          exists: async () => true,
        });
        arrange();

        expect(
          yield* resumeRun(EXECUTION, { session, executeWorkflow }),
        ).toEqual({ failed: 'unusable_checkpoint' });
        expect(resumeToolUseFromResumeDataMock).not.toHaveBeenCalled();
      }),
  );

  // Only a cause that names the checkpoint refuses as unusable state. A
  // transient storage failure is the operational error it has always been, so
  // the host words it with the cause instead of telling the user to delete a
  // run whose saved state may be fine.
  it.live(
    'propagates a transient retrieval failure over a present checkpoint',
    () =>
      Effect.gen(function* () {
        const session = createSession();
        getExecutionStoreMock.mockReturnValue({
          readConfig: async () => snapshot().agentConfig,
          readMeta: async () => ({ streamId: STREAM }),
          exists: async () => true,
        });
        retrieveSessionResumeDataMock.mockRejectedValueOnce(
          new Error('KV timeout'),
        );

        expect(
          (yield* Effect.flip(
            resumeRun(EXECUTION, { session, executeWorkflow }),
          )).message,
        ).toContain('KV timeout');
      }),
  );

  // The launch's own acquire would raise `ExecutionLeaseActiveError` only
  // after the host cleared its window and switched onto the resumed stream.
  it.live(
    'refuses a run a live foreign owner holds before the host rearranges',
    () =>
      Effect.gen(function* () {
        const session = createSession();
        const owner = { pid: 4321, hostname: 'other-host' };
        inspectExecutionLeaseMock.mockResolvedValue({ status: 'held', owner });
        const onResumeResolved = vi.fn();

        expect(
          yield* resumeRun(EXECUTION, {
            session,
            executeWorkflow,
            onResumeResolved,
          }),
        ).toEqual({ failed: 'owned_elsewhere' });
        expect(onResumeResolved).not.toHaveBeenCalled();
        expect(resumeToolUseFromResumeDataMock).not.toHaveBeenCalled();
        expect(session.status.holdState(STREAM)).toBe(
          streamHeldMessage(owner.pid),
        );
      }),
  );
});
