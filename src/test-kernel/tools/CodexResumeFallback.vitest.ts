/**
 * Codex launch and atomic disk-resume claims, over a real session whose
 * parent run is parked on the validation model: the child's registration,
 * its loop, its deliveries and its follow-ups are real. Only the Codex SDK
 * (its client and threads) and the app's Codex config are faked, at the
 * edge the tool imports them through.
 *
 * Failure modes:
 * - a fresh launch whose loop fails after the tool answered is never said;
 * - a resume whose launch is refused keeps the thread id reserved;
 * - concurrent calls with the same stale thread_id start two loops, or the
 *   loser re-claims in a spin instead of waiting for the winner's loop.
 */
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer } from 'effect';
import { describe, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  importCodexClass: vi.fn(),
}));

vi.mock('@texra/tools/codexConfig', async () => {
  const { Effect } = await import('effect');
  return {
    codexRun: () =>
      Effect.succeed({
        ref: 'openai/gpt-6.1-sol',
        slug: 'gpt-6.1-sol',
        effort: 'medium',
        note: undefined,
      }),
  };
});

vi.mock('@texra/tools/codexImport', async (importActual) => {
  const { Effect } = await import('effect');
  return {
    ...(await importActual<typeof import('@texra/tools/codexImport')>()),
    // The client over whatever class the case's SDK import yields.
    openCodexClient: () =>
      mocks.importCodexClass().pipe(
        Effect.map((Codex: new () => unknown) => ({
          codex: new Codex(),
          codexPath: undefined,
        })),
      ),
  };
});

import '@test/support/sessionGraphTestSetup';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { setLogSink } from '@logger/logSink';
import { withProcessServices } from '@platform/processRuntime';
import type { RunId } from '@shared/schemas';
import { captureLogEntries } from '@test/support/logSinkCapture';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { openTestDefaultSession } from '@test/support/sessionEnd';
import {
  parkedAfter,
  REAL_RUN_TIMEOUT,
  sessionStoreFaults,
  storedRows,
  untilStored,
  validationHost,
} from '@test/support/storeFaults';
import { noPluginHold } from '@test/support/testPluginServices';
import { testRuntime } from '@test/support/testProcessRuntime';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { CodexThreads as CodexThreadsService } from '@texra/tools/agentCliSessionStores';
import { AgentCliSessionRegistry } from '@texra/tools/agentCliSessionRegistry';
import { CodexTool } from '@texra/tools/codex';
import { generateRunId } from '@utils/core';

/** The tool's call layer under `run`, serving `registry` as the step would. */
const toolLayer = (
  registry: AgentCliSessionRegistry,
  run?: { readonly session: SessionHandle; readonly runId: RunId },
) =>
  Layer.merge(
    nativeToolTestLayer(run && { run: { ...run, toolPolicy: {} } }),
    Layer.succeed(CodexThreadsService)(registry),
  );

/** A root run of the bundled `assistant`, parked waiting for input: the
 *  parent a Codex child is launched under and delivers to. */
const parkedParent = Effect.gen(function* () {
  const roots = testWorkspaceRoots();
  const session = yield* openTestDefaultSession({ roots });
  const runId = generateRunId();
  yield* withProcessServices(
    testRuntime(),
    session.runs.launch({
      request: {
        config: AgentConfigSchema.parse({
          agent: 'assistant',
          model: 'gpt56',
          instruction: 'Parent.',
        }),
        runId,
      },
      options: {},
    }),
  ).pipe(Effect.forkChild);
  yield* untilStored(roots.storage, parkedAfter(runId, 1, roots.storage));
  return { session, runId, storage: roots.storage };
});

/** A Codex thread whose every turn answers `reply`, recording its prompts. */
const answeringThread = (id: string | undefined, reply: string) => {
  const prompts: string[] = [];
  return {
    prompts,
    thread: {
      id,
      runStreamed: (prompt: string) => {
        prompts.push(prompt);
        return Promise.resolve({
          events: (async function* () {
            yield {
              type: 'item.completed',
              item: { id: 'reply', type: 'agent_message', text: reply },
            };
            yield {
              type: 'turn.completed',
              usage: {
                input_tokens: 1,
                cached_input_tokens: 0,
                output_tokens: 1,
              },
            };
          })(),
        });
      },
    },
  };
};

/** The child runs `parent` launched, from the store. */
const childrenOf = (storage: string, parent: RunId) =>
  storedRows(storage)
    .filter((row) => row.type === 'run.start' && row.parent === parent)
    .map((row) => row.run);

describe(
  'codex tool - atomic resume fallback',
  { timeout: REAL_RUN_TIMEOUT },
  () => {
    validationHost('texra-codex-resume-');

    it.live(
      'roots a fresh Codex launch in the session and logs detached rejection',
      () =>
        Effect.gen(function* () {
          const parent = yield* parkedParent;
          const registry = new AgentCliSessionRegistry(noPluginHold);
          const startThread = vi.fn((_options: unknown) => ({
            id: undefined,
            runStreamed: () =>
              Promise.reject(new Error('Codex process exited')),
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
          // The failed turn ends the child. Neither its settled end nor the
          // end recording the lost result commits, so the backstop end is
          // written and the loop fails after the tool has answered.
          const logs = captureLogEntries();
          yield* Effect.addFinalizer(() => Effect.sync(() => setLogSink(null)));
          const faults = yield* sessionStoreFaults(parent.storage);
          yield* faults.failNext('appendAll', 'run.end');
          yield* faults.failNext('appendAll', 'run.end');

          expect(
            yield* CodexTool.call({
              prompt: 'launch Codex',
              sandbox_mode: 'workspace-write',
            }).pipe(Effect.provide(toolLayer(registry, parent))),
          ).toMatchObject({ status: 'executed' });
          const said = () =>
            logs.has(
              'ERROR',
              'childRunLoop',
              "Child 'codex' run loop failed after launch",
            );
          yield* untilStored(parent.storage, said);
          // The child reads as ended, not as running.
          const [child] = childrenOf(parent.storage, parent.runId);
          expect(
            storedRows(parent.storage).find(
              (row) => row.run === child && row.type === 'run.end',
            )?.data,
          ).toContain("The run's end was not saved: injected appendAll fault");
          expect(startThread).toHaveBeenCalledWith(
            expect.objectContaining({
              workingDirectory: testWorkspaceRoots().workspace,
            }),
          );
        }),
    );

    it.live(
      'releases a resume reservation when launch rejects a missing run context',
      () =>
        Effect.gen(function* () {
          const registry = new AgentCliSessionRegistry(noPluginHold);
          expect(
            yield* CodexTool.call({
              prompt: 'resume Codex',
              sandbox_mode: 'workspace-write',
              thread_id: 'stale-thread',
            }).pipe(Effect.provide(toolLayer(registry))),
          ).toMatchObject({ status: 'error' });
          expect(mocks.importCodexClass).not.toHaveBeenCalled();

          const release = registry.claim('stale-thread');
          expect(release).toBeTypeOf('function');
          release?.();
        }),
    );

    it.live(
      'launches one fallback loop when concurrent calls use the same stale thread_id',
      () =>
        Effect.gen(function* () {
          const parent = yield* parkedParent;
          const registry = new AgentCliSessionRegistry(noPluginHold);
          const sdkImportStarted = yield* Deferred.make<void>();
          const sdkReady = yield* Deferred.make<unknown>();
          const secondClaimLost = yield* Deferred.make<void>();
          const { thread, prompts } = answeringThread('stale-thread', 'Done.');
          const resumeThread = vi.fn((_threadId: string) => thread);

          // The SDK import is the gate: it announces that it started and
          // then waits for the case to release it.
          mocks.importCodexClass.mockReturnValue(
            Deferred.succeed(sdkImportStarted, undefined).pipe(
              Effect.andThen(Deferred.await(sdkReady)),
            ),
          );
          // The contention this case claims is a lost claim: the gate fires
          // from inside the second call's own failed `claim`, the step that
          // sends it into the fallback wait. Gating on anything earlier
          // would let the first launch promote the id before the second
          // call ever contended, and the follow-up assertions would pass on
          // the plain already-active path.
          const realClaim = registry.claim.bind(registry);
          const claim = vi
            .spyOn(registry, 'claim')
            .mockImplementation((threadId: string) => {
              const release = realClaim(threadId);
              if (!release) Deferred.doneUnsafe(secondClaimLost, Effect.void);
              return release;
            });
          const call = (prompt: string) =>
            CodexTool.call({
              prompt,
              sandbox_mode: 'workspace-write',
              thread_id: 'stale-thread',
            }).pipe(Effect.provide(toolLayer(registry, parent)));

          const first = yield* Effect.forkChild(call('continue the refactor'));
          yield* Deferred.await(sdkImportStarted);
          const second = yield* Effect.forkChild(call('also update the tests'));
          yield* Deferred.await(secondClaimLost);

          expect(mocks.importCodexClass).toHaveBeenCalledTimes(1);
          expect(childrenOf(parent.storage, parent.runId)).toEqual([]);

          // The first launch's loop runs its turn, which promotes the id;
          // the waiting call then queues onto that loop.
          yield* Deferred.succeed(
            sdkReady,
            class MockCodex {
              resumeThread(threadId: string) {
                return resumeThread(threadId);
              }
            },
          );
          expect((yield* Fiber.join(first)).status).toBe('executed');
          expect((yield* Fiber.join(second)).summary).toMatch(
            /Follow-up queued/,
          );
          yield* untilStored(parent.storage, () => prompts.length === 2);

          expect(resumeThread).toHaveBeenCalledOnce();
          expect(resumeThread).toHaveBeenCalledWith('stale-thread');
          expect(childrenOf(parent.storage, parent.runId)).toHaveLength(1);
          expect(prompts).toEqual([
            'continue the refactor',
            'also update the tests',
          ]);
          // One claim apiece: the loser parked on the reservation until the
          // launch promoted it, rather than re-claiming until the id went
          // active. A spin would still reach the same follow-up, so the
          // count is what distinguishes waiting from polling.
          expect(claim).toHaveBeenCalledTimes(2);
        }),
    );
  },
);
