import { Effect, Fiber } from 'effect';
import { it } from '@effect/vitest';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { PersistedFlowStateError } from '@agent/node/persistedFlow';
import type { ResumeToolUseFromResumeDataOptions } from '@agent/runtime/executeAgent';
import { resumeRun, resumeClaimedRun } from '@agent/runtime/resumeRun';
import type { RunId } from '@shared/schemas';
import { AgentCategory, RUN_OUTCOME } from '@shared/schemas';
import { DatabaseReadFailed } from '@shared/session/database';
import { runHeldMessage } from '@shared/runs/runStatusDisplay';
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

const getRunStoreMock = vi.hoisted(() => vi.fn());
// `getRunRecords().exists()` answers "the log still lists this run"; the KV
// store double's `exists(key)` is the separate checkpoint-file probe.
const runExistsMock = vi.hoisted(() => vi.fn());
vi.mock('@agent/storage/RunKVStore', async (importActual) => ({
  ...(await importActual<typeof import('@agent/storage/RunKVStore')>()),
  getRunStore: getRunStoreMock,
  getRunRecords: () => {
    const store = getRunStoreMock();
    return {
      readConfig: () =>
        Effect.tryPromise({
          try: () => store.readConfig(),
          catch: ensureError,
        }),
      exists: () =>
        Effect.tryPromise({ try: () => runExistsMock(), catch: ensureError }),
    };
  },
}));

// The refusal path re-reads the durable facts, which the fixtures below do
// not seed: the store double answers only `readConfig` and the checkpoint
// probe `exists`; the run's own existence is `runExistsMock`.
const classifyRunMock = vi.hoisted(() => vi.fn());
vi.mock('@agent/runtime/runClassification', async (importActual) => ({
  ...(await importActual<typeof import('@agent/runtime/runClassification')>()),
  classifyRun: (...args: unknown[]) =>
    Effect.promise(() => classifyRunMock(...args)),
}));

const inspectRunLeaseMock = vi.hoisted(() => vi.fn());
vi.mock('@agent/storage/runLease', async (importActual) => ({
  ...(await importActual<typeof import('@agent/storage/runLease')>()),
  inspectRunLease: inspectRunLeaseMock,
}));

const RUN = 'aabbcc' as RunId;
const completed = {
  category: 'toolUse' as const,
  outcome: RUN_OUTCOME.COMPLETED,
  runId: RUN,
  response: 'done',
  files: [],
  totalCostUsd: 0,
};

function snapshot() {
  return createToolUseResumeData({ runId: RUN });
}

function seedRecoverable(
  session: ReturnType<typeof createTestSession>,
  ...texts: string[]
): void {
  const flow = session.followUps.claimLive(RUN, 'flow')!;
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

const executeWorkflow = vi.fn(async () => {
  throw new Error('tool-use fixtures never launch a workflow');
});

describe('resumeRun tool-use queue ownership', () => {
  beforeEach(() => {
    getRunStoreMock.mockReset().mockReturnValue({
      readConfig: async () => snapshot().agentConfig,
      exists: async () => false,
    });
    runExistsMock.mockReset().mockResolvedValue(true);
    retrieveSessionResumeDataMock.mockReset().mockResolvedValue(snapshot());
    classifyRunMock.mockReset().mockResolvedValue({ kind: 'finished' });
    inspectRunLeaseMock.mockReset().mockResolvedValue({ status: 'free' });
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
    'reads the durable records before retrieval and retains input when they fail',
    () =>
      Effect.gen(function* () {
        const session = createSession();
        seedRecoverable(session, 'Keep this input.');
        const failure = new DatabaseReadFailed({
          path: ':memory:',
          cause: new Error('Corrupt record'),
        });
        runExistsMock.mockRejectedValueOnce(failure);
        expect(
          yield* Effect.flip(resumeRun(RUN, { session, executeWorkflow })),
        ).toBe(failure);
        expect(retrieveSessionResumeDataMock).not.toHaveBeenCalled();
        expect(session.followUps.getAll(RUN)).toEqual(['Keep this input.']);
      }),
  );

  it.live('claims run recovery before reading the committed run records', () =>
    Effect.gen(function* () {
      const session = createSession();
      const config =
        createDeferred<ReturnType<typeof snapshot>['agentConfig']>();
      const configRead = createDeferred<void>();
      getRunStoreMock.mockReturnValueOnce({
        readConfig: () => {
          configRead.resolve();
          return config.promise;
        },
        exists: async () => false,
      });

      const resumed = yield* Effect.forkChild(
        resumeClaimedRun(RUN, { session, executeWorkflow }),
      );
      yield* Effect.promise(() => configRead.promise);
      expect(
        session.followUps.submit(RUN, { text: 'raced' }, 'recoverable'),
      ).toEqual({ kind: 'queued' });

      config.resolve(snapshot().agentConfig);
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

  it.live('preserves raced input when the run has no persisted record', () =>
    Effect.gen(function* () {
      const session = createSession();
      const exists = createDeferred<boolean>();
      const existsRead = createDeferred<void>();
      runExistsMock.mockImplementationOnce(() => {
        existsRead.resolve();
        return exists.promise;
      });

      const resumed = yield* Effect.forkChild(
        resumeClaimedRun(RUN, { session, executeWorkflow }),
      );
      yield* Effect.promise(() => existsRead.promise);
      expect(
        session.followUps.submit(RUN, { text: 'raced' }, 'recoverable'),
      ).toEqual({ kind: 'queued' });

      exists.resolve(false);
      expect(yield* Fiber.join(resumed)).toEqual({ failed: 'not_resumable' });
      expect(session.followUps.getAll(RUN)).toEqual(['raced']);
    }),
  );

  it.live(
    'claims recovery before draining and preserves ordered raced input',
    () =>
      Effect.gen(function* () {
        const session = createSession();
        seedRecoverable(session, 'first');

        expect(
          yield* resumeRun(RUN, {
            session,
            executeWorkflow,
            onFollowUpQueueReady: () => {
              expect(
                session.followUps.submit(
                  RUN,
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
        resumeRun(RUN, { session, executeWorkflow }),
      );
      yield* Effect.promise(() =>
        vi.waitFor(() =>
          expect(resumeToolUseFromResumeDataMock).toHaveBeenCalledOnce(),
        ),
      );
      expect(yield* resumeRun(RUN, { session, executeWorkflow })).toEqual({
        failed: 'not_resumable',
      });
      barrier.resolve();
      yield* Fiber.join(first);
      expect(resumeToolUseFromResumeDataMock).toHaveBeenCalledOnce();
    }),
  );

  it.live('refuses a recovery lease invalidated during storage reads', () =>
    Effect.gen(function* () {
      const session = createSession();
      const submission = session.followUps.submit(
        RUN,
        { text: 'stale' },
        'recoverable',
      );
      expect(submission).toMatchObject({ kind: 'queued' });
      if (submission.kind !== 'queued' || !submission.lease) {
        throw new Error('recovery not claimed');
      }
      const config =
        createDeferred<ReturnType<typeof snapshot>['agentConfig']>();
      getRunStoreMock.mockReturnValueOnce({
        readConfig: () => config.promise,
        exists: async () => false,
      });

      const resumed = yield* Effect.forkChild(
        resumeRun(RUN, {
          session,
          recovery: submission.lease,
          executeWorkflow,
        }),
      );
      session.followUps.terminalize(RUN);
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
        (yield* Effect.flip(resumeRun(RUN, { session, executeWorkflow })))
          .message,
      ).toContain('failed');
      expect(session.followUps.getAll(RUN)).toEqual(['keep me']);
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
        resumeRun(RUN, { session, executeWorkflow }),
      );
      yield* Effect.promise(() =>
        vi.waitFor(() =>
          expect(resumeToolUseFromResumeDataMock).toHaveBeenCalledOnce(),
        ),
      );

      expect(
        session.followUps.submit(
          RUN,
          { text: 'completed child', origin: 'subagent_result' },
          'recoverable',
        ),
      ).toEqual({ kind: 'queued' });
      rejectResume(new Error('resume failed'));

      expect((yield* Effect.flip(Fiber.join(resuming))).message).toContain(
        'resume failed',
      );
      expect(session.followUps.getAll(RUN)).toEqual([
        'original',
        'completed child',
      ]);
    }),
  );

  it.live('adopts the exact recovery generation claimed by submission', () =>
    Effect.gen(function* () {
      const session = createSession();
      const submission = session.followUps.submit(
        RUN,
        { text: 'claimed' },
        'recoverable',
      );
      expect(submission).toMatchObject({ kind: 'queued' });
      if (submission.kind !== 'queued' || !submission.lease) {
        throw new Error('recovery not claimed');
      }
      const recovery = submission.lease;

      expect(
        yield* resumeRun(RUN, { session, recovery, executeWorkflow }),
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
        RUN,
        { text: 'workflow input' },
        'recoverable',
      );
      expect(submission).toMatchObject({ kind: 'queued' });
      if (submission.kind !== 'queued' || !submission.lease) {
        throw new Error('recovery not claimed');
      }
      getRunStoreMock.mockReturnValueOnce({
        readConfig: async () => ({
          ...snapshot().agentConfig,
          agentCategory: AgentCategory.Workflow,
        }),
        exists: async () => false,
      });
      retrieveSessionResumeDataMock.mockResolvedValueOnce(null);

      expect(
        yield* resumeRun(RUN, {
          session,
          recovery: submission.lease,
          executeWorkflow,
        }),
      ).toEqual({ failed: 'finished' });
      expect(session.followUps.getAll(RUN)).toEqual(['workflow input']);
    }),
  );

  it.live('refuses with `finished` when no checkpoint remains', () =>
    Effect.gen(function* () {
      const session = createSession();
      retrieveSessionResumeDataMock.mockResolvedValueOnce(null);

      expect(yield* resumeRun(RUN, { session, executeWorkflow })).toEqual({
        failed: 'finished',
      });
      expect(resumeToolUseFromResumeDataMock).not.toHaveBeenCalled();
      expect(session.status.holdState(RUN)).toBeUndefined();
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

      expect(yield* resumeRun(RUN, { session, executeWorkflow })).toEqual({
        failed: 'owned_elsewhere',
      });
      expect(session.status.holdState(RUN)).toContain('4321');
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
            cause: new PersistedFlowStateError(RUN, 'unsupported-record'),
          }),
        ),
    ],
  ] as const)(
    'refuses a checkpoint as unusable when %s',
    ([_description, arrange]) =>
      Effect.gen(function* () {
        const session = createSession();
        getRunStoreMock.mockReturnValue({
          readConfig: async () => snapshot().agentConfig,
          exists: async () => true,
        });
        arrange();

        expect(yield* resumeRun(RUN, { session, executeWorkflow })).toEqual({
          failed: 'unusable_checkpoint',
        });
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
        getRunStoreMock.mockReturnValue({
          readConfig: async () => snapshot().agentConfig,
          exists: async () => true,
        });
        retrieveSessionResumeDataMock.mockRejectedValueOnce(
          new Error('KV timeout'),
        );

        expect(
          (yield* Effect.flip(resumeRun(RUN, { session, executeWorkflow })))
            .message,
        ).toContain('KV timeout');
      }),
  );

  // The launch's own acquire would raise `RunLeaseActiveError` only
  // after the host cleared its window and switched onto the resumed stream.
  it.live(
    'refuses a run a live foreign owner holds before the host rearranges',
    () =>
      Effect.gen(function* () {
        const session = createSession();
        const owner = { pid: 4321, hostname: 'other-host' };
        inspectRunLeaseMock.mockResolvedValue({ status: 'held', owner });
        const onResumeResolved = vi.fn();

        expect(
          yield* resumeRun(RUN, {
            session,
            executeWorkflow,
            onResumeResolved,
          }),
        ).toEqual({ failed: 'owned_elsewhere' });
        expect(onResumeResolved).not.toHaveBeenCalled();
        expect(resumeToolUseFromResumeDataMock).not.toHaveBeenCalled();
        expect(session.status.holdState(RUN)).toBe(runHeldMessage(owner.pid));
      }),
  );
});
