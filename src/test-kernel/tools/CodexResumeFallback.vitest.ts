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
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { codexThreadsFor } from '@tools/agentCliSessionStores';

const mocks = vi.hoisted(() => ({
  registerRun: vi.fn(),
  createChildRun: vi.fn(),
  startChildRunLoop: vi.fn(),
  importCodexClass: vi.fn(),
  resumeThread: vi.fn(),
  submitFollowUp: vi.fn(),
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
const CodexThreads = codexThreadsFor(testSession.runs);

vi.mock('@agent/storage', () => ({
  registerRun: mocks.registerRun,
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
  getCodexCliReasoningEffort: () => Effect.succeed('high'),
  codexBinarySupportsXhigh: async () => false,
  CODEX_CLI_MODEL: 'gpt-5.2-codex',
}));

vi.mock('@tools/codexImport', async (importActual) => {
  const { Effect: EffectModule } = await import('effect');
  return {
    ...(await importActual<typeof import('@tools/codexImport')>()),
    // The client over whatever class the case's SDK import yields.
    openCodexClient: () =>
      mocks.importCodexClass().pipe(
        EffectModule.map((Codex: new () => unknown) => ({
          codex: new Codex(),
          codexPath: undefined,
        })),
      ),
  };
});

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

    mocks.registerRun.mockReturnValue(Effect.void);
    mocks.createChildRun.mockReturnValue(
      Effect.succeed(createFakeAgentCliChildRun(childRunId)),
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    CodexThreads.releaseByRunId(parentRunId);
    CodexThreads.release('stale-thread');
  });

  it.effect(
    'roots a fresh Codex launch in the session and logs detached rejection',
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
        const startThread = vi.fn((_options: unknown) => ({
          id: undefined,
          runStreamed: vi.fn(),
        }));
        mocks.importCodexClass.mockReturnValue(
          Effect.succeed(
            class MockCodex {
              startThread(options: unknown) {
                return startThread(options);
              }
            },
          ),
        );

        expect(
          yield* CodexTool.call({
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
        expect(startThread).toHaveBeenCalledWith(
          expect.objectContaining({ workingDirectory: '/desktop/project' }),
        );
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            roots: createFakeWorkspaceRoots({
              workspacePath: '/desktop/project',
            }),
            run: { session: testSession, runId: parentRunId, toolPolicy: {} },
          }),
        ),
      ),
  );

  it.effect(
    'releases a resume reservation when launch rejects a missing run context',
    () =>
      Effect.gen(function* () {
        expect(
          yield* CodexTool.call({
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

  it.effect(
    'launches one fallback loop when concurrent calls use the same stale thread_id',
    () =>
      Effect.gen(function* () {
        const sdkImportStarted = yield* Deferred.make<void>();
        const sdkReady = yield* Deferred.make<unknown>();
        const secondClaimLost = yield* Deferred.make<void>();
        const thread = {
          id: 'stale-thread',
          runStreamed: vi.fn(),
        };
        const runs = {
          getHandle: () => undefined,
        } as any;
        const getLaunch = captureRunLoopLaunch();

        // The SDK import is the gate: it announces that it started and then
        // waits for the suite to release it.
        mocks.importCodexClass.mockReturnValue(
          Deferred.succeed(sdkImportStarted, undefined).pipe(
            Effect.andThen(Deferred.await(sdkReady)),
          ),
        );
        // The contention this case claims is a lost claim: dispatch resolves
        // the registry for this session, which is the instance the suite holds,
        // so the gate fires from inside the second call's own failed
        // `claim` — the step that sends it into the fallback wait. Gating on
        // anything earlier (its approval, say) would let the test release the
        // SDK and promote the first launch before the second call ever
        // contended, and the follow-up assertions would pass on the plain
        // already-active path.
        const realClaim = CodexThreads.claim.bind(CodexThreads);
        const claim = vi
          .spyOn(CodexThreads, 'claim')
          .mockImplementation((threadId: string) => {
            const release = realClaim(threadId);
            if (!release) Deferred.doneUnsafe(secondClaimLost, Effect.void);
            return release;
          });

        const tool = CodexTool;
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
        yield* Deferred.await(secondClaimLost);

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
          expect.objectContaining({ text: 'also update the tests' }),
          expect.objectContaining({ session: expect.anything() }),
        );

        // One claim apiece: the loser parked on the reservation until the
        // launch promoted it, rather than re-claiming until the id went
        // active. A spin would still reach the same follow-up, so the count is
        // what distinguishes waiting from polling.
        expect(claim).toHaveBeenCalledTimes(2);

        getLaunch().strategy?.releaseSessionOwnership?.();
        expect(CodexThreads.lookup('stale-thread')).toBeUndefined();
        claim.mockRestore();
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: { session: testSession, runId: parentRunId, toolPolicy: {} },
          }),
        ),
      ),
  );
});
