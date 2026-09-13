import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';
// Regression coverage for atomic Codex disk-resume claims. Concurrent calls
// with the same stale thread_id must share one fallback loop: the first call
// owns asynchronous SDK setup, while later calls wait for registration and
// enqueue through the ordinary follow-up path. The detached-rejection case is
// also the only place the fresh `startThread` launch branch is exercised.

import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import type { ChildRunStrategy } from '@agent/runtime/childRunLoop';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { RunId } from '@shared/schemas';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { codexThreadsFor } from '@tools/agentCliSessionStores';

const mocks = vi.hoisted(() => ({
  requestBashApproval: vi.fn(),
  registerRun: vi.fn(),
  createChildRun: vi.fn(),
  startChildRunLoop: vi.fn(),
  importCodexClass: vi.fn(),
  findCodexBinaryPath: vi.fn(),
  resumeThread: vi.fn(),
  submitFollowUp: vi.fn(),
}));

vi.mock('@tools/approval/bashApproval', () => ({
  requestBashApproval: mocks.requestBashApproval,
  buildBashApprovalRejectedResult: vi.fn(),
}));

vi.mock('@agent/followUp/ToolUseFollowUp', () => ({
  submitFollowUp: mocks.submitFollowUp,
}));

// Session-keyed registries: the suite pins one fake session and reads the
// registry that dispatch resolves for it through the same accessor.
const testSession = {
  followUps: { acquire: () => ({ enqueue: vi.fn() }) },
  // The session-keyed registry resolves live handles through its session's
  // RunRegistry; this suite never tracks real handles, so lookups miss.
  runs: {
    getHandle: () => undefined,
  },
} as unknown as SessionHandle;
const CodexThreads = codexThreadsFor(testSession);

vi.mock('@agent/storage', () => ({
  registerRun: mocks.registerRun,
}));

vi.mock('@agent/storage/runLease', () => ({
  assertOwnedRunLease: vi.fn(),
}));

vi.mock('@tools/delegation/childRun', () => ({
  createChildRun: mocks.createChildRun,
  childRunDescription: (raw: string) => raw,
}));

vi.mock('@agent/runtime/childRunLoop', () => ({
  runWithOwnedRunLeaseLaunchGuard: (
    ...args: Parameters<
      typeof import('@agent/runtime/childRunLoop').runWithOwnedRunLeaseLaunchGuard
    >
  ) => args[2],
  startChildRunLoop: mocks.startChildRunLoop,
}));

vi.mock('@tools/codexConfig', () => ({
  getCodexSandboxMode: () => 'workspace-write',
  getCodexApprovalPolicy: () => 'on-request',
  getCodexCliReasoningEffort: () => 'high',
  CODEX_CLI_MODEL: 'gpt-5.2-codex',
  buildCodexConfig: () => ({
    agent: 'codex',
    model: 'Codex CLI',
    instruction: 'test',
    agentCategory: 'toolUse',
  }),
}));

vi.mock('@tools/codexImport', () => ({
  codexBinarySupportsXhigh: async () => false,
  importCodexClass: mocks.importCodexClass,
  findCodexBinaryPath: mocks.findCodexBinaryPath,
}));

import { CodexTool } from '@tools/codex';
import { createFakeAgentCliChildRun } from '../support/agentCliResumeTestUtils';

const parentRunId = 'parent-run' as RunId;
const childRunId = 'codex-child-run' as RunId;

function completedChildRunLoop() {
  return Effect.forkDetach(Effect.void);
}

/**
 * Capture the run id and strategy passed to the (single) child run loop
 * launch. The launch mints the run id itself, and that is the run a waiting
 * caller's follow-up must address.
 */
function captureRunLoopLaunch(): () => {
  runId?: RunId;
  strategy?: ChildRunStrategy<unknown>;
} {
  let launch: { runId?: RunId; strategy?: ChildRunStrategy<unknown> } = {};
  mocks.startChildRunLoop.mockImplementation(
    (params: { runId: RunId; strategy: ChildRunStrategy<unknown> }) => {
      launch = { runId: params.runId, strategy: params.strategy };
      return completedChildRunLoop();
    },
  );
  return () => launch;
}

describe('codex tool - atomic resume fallback', () => {
  beforeEach(() => {
    mocks.submitFollowUp.mockReturnValue(Effect.succeed({ status: 'sent' }));
    mocks.startChildRunLoop.mockReset();
    mocks.startChildRunLoop.mockReturnValue(completedChildRunLoop());
    mocks.importCodexClass.mockReset();
    mocks.findCodexBinaryPath.mockReset();
    mocks.requestBashApproval.mockReturnValue(
      Effect.succeed({ action: 'approve' }),
    );

    mocks.registerRun.mockReturnValue(Effect.void);
    mocks.findCodexBinaryPath.mockResolvedValue(undefined);
    mocks.createChildRun.mockReturnValue(
      Effect.succeed(createFakeAgentCliChildRun(childRunId)),
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    CodexThreads.releaseByRunId(parentRunId);
    CodexThreads.release('stale-thread');
  });

  it.live(
    'logs a detached run-loop rejection from a fresh Codex thread launch',
    () =>
      Effect.gen(function* () {
        const childRun = createFakeAgentCliChildRun(childRunId);
        const logged = yield* Deferred.make<void>();
        const error = vi
          .spyOn(childRun.logger, 'error')
          .mockImplementation(() => {
            Deferred.doneUnsafe(logged, Effect.void);
          });
        const lateFailure = new Error('late Codex finalization failed');
        mocks.createChildRun.mockReturnValue(Effect.succeed(childRun));
        mocks.startChildRunLoop.mockReturnValue(
          Effect.forkDetach(Effect.fail(lateFailure)),
        );
        mocks.importCodexClass.mockResolvedValue(
          class MockCodex {
            startThread(): {
              id: undefined;
              runStreamed: ReturnType<typeof vi.fn>;
            } {
              return { id: undefined, runStreamed: vi.fn() };
            }
          },
        );

        expect(
          yield* new CodexTool().call({
            prompt: 'launch Codex',
            sandbox_mode: 'workspace-write',
          }),
        ).toMatchObject({ status: 'executed' });
        // The detached loop fiber writes this log on the same runtime, so the
        // spy itself is the wake; nothing is polled.
        yield* Deferred.await(logged);
        expect(error).toHaveBeenCalledWith(
          'Codex run loop failed after launch',
          {
            data: lateFailure,
          },
        );
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: { session: testSession, runId: parentRunId, toolPolicy: {} },
          }),
        ),
      ),
  );

  it.live(
    'releases a resume reservation when launch rejects a missing run context',
    () =>
      Effect.gen(function* () {
        expect(
          yield* new CodexTool().call({
            prompt: 'resume Codex',
            sandbox_mode: 'workspace-write',
            thread_id: 'stale-thread',
          }),
        ).toMatchObject({ status: 'error' });
        expect(mocks.startChildRunLoop).not.toHaveBeenCalled();

        const release = CodexThreads.claim('stale-thread');
        expect(release).toBeTypeOf('function');
        release?.();
      }).pipe(Effect.provide(nativeToolTestLayer())),
  );

  it.live(
    'launches one fallback loop when concurrent calls use the same stale thread_id',
    () =>
      Effect.gen(function* () {
        const sdkImportStarted = yield* Deferred.make<void>();
        const sdkReady = yield* Deferred.make<unknown>();
        const secondApproved = yield* Deferred.make<void>();
        const thread = {
          id: 'stale-thread',
          runStreamed: vi.fn(),
        };
        const runs = {
          getHandle: () => undefined,
        } as any;
        const getLaunch = captureRunLoopLaunch();

        // importCodexClass is a Promise-shaped collaborator, so the gate is an
        // Effect run at that edge rather than a hand-rolled deferred promise.
        mocks.importCodexClass.mockImplementation(() =>
          Effect.runPromise(
            Deferred.succeed(sdkImportStarted, undefined).pipe(
              Effect.andThen(Deferred.await(sdkReady)),
            ),
          ),
        );
        // The second call's approval is the last step before it claims the id,
        // so completing the gate there proves it reached the fallback wait
        // rather than asserting on a fiber that has not started yet.
        mocks.requestBashApproval
          .mockReturnValueOnce(Effect.succeed({ action: 'approve' }))
          .mockImplementationOnce(() =>
            Deferred.succeed(secondApproved, undefined).pipe(
              Effect.as({ action: 'approve' }),
            ),
          );

        const tool = new CodexTool();
        const first = yield* Effect.forkChild(
          tool.call({
            prompt: 'continue the refactor',
            sandbox_mode: 'workspace-write',
            thread_id: 'stale-thread',
          }),
        );
        yield* Deferred.await(sdkImportStarted);

        const second = yield* Effect.forkChild(
          tool.call({
            prompt: 'also update the tests',
            sandbox_mode: 'workspace-write',
            thread_id: 'stale-thread',
          }),
        );
        yield* Deferred.await(secondApproved);

        expect(mocks.importCodexClass).toHaveBeenCalledTimes(1);
        expect(mocks.startChildRunLoop).not.toHaveBeenCalled();

        yield* Deferred.succeed(
          sdkReady,
          class MockCodex {
            resumeThread(threadId: string): typeof thread {
              mocks.resumeThread(threadId);
              return thread;
            }
          },
        );
        const firstResult = yield* Fiber.join(first);
        getLaunch().strategy?.onTurnSuccess?.({}, { runs } as any);
        const secondResult = yield* Fiber.join(second);

        expect(firstResult.status).toBe('executed');
        expect(secondResult.summary).toMatch(/Follow-up queued/);
        expect(mocks.resumeThread).toHaveBeenCalledOnce();
        expect(mocks.resumeThread).toHaveBeenCalledWith('stale-thread');
        expect(mocks.startChildRunLoop).toHaveBeenCalledTimes(1);
        expect(mocks.submitFollowUp).toHaveBeenCalledOnce();
        expect(mocks.submitFollowUp).toHaveBeenCalledWith(
          getLaunch().runId,
          'also update the tests',
          expect.objectContaining({ session: expect.anything() }),
        );

        getLaunch().strategy?.releaseSessionOwnership?.();
        expect(CodexThreads.lookup('stale-thread')).toBeUndefined();
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: { session: testSession, runId: parentRunId, toolPolicy: {} },
          }),
        ),
      ),
  );
});
