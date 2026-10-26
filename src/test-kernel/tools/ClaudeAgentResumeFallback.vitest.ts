/**
 * claude_code launch, resume and fork, over a real session whose parent run
 * is parked on the validation model: the child's registration, its loop,
 * its deliveries and its follow-ups are real. Only the Claude Agent SDK
 * (its `query` and binary lookup) and the app's Claude config (the env
 * block) are faked, at the edge the tool imports them through.
 *
 * The resume fallback applies when a caller passes a session_id whose
 * registry entry is gone (extension reload, host crash, or a stale id from
 * an older run): the first fallback claims the id before asynchronous
 * setup, while concurrent calls wait for that loop and then queue onto it.
 *
 * Failure modes:
 * - a launch nobody can collect, or whose setup fails, leaves a child run;
 * - a fallback launch forgets the stale id, so the SDK starts afresh;
 * - concurrent calls on one stale id start two loops, spin on the claim, or
 *   strand the waiter when the first launch fails;
 * - a fork mutates its source session, or a failed fork is resumed;
 * - a detached loop's failure after the tool answered is never said.
 */
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer } from 'effect';
import { describe, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  buildClaudeAgentEnv: vi.fn(),
  findClaudeBinaryPath: vi.fn(),
}));

vi.mock('@texra/tools/claudeAgentConfig', () => ({
  buildClaudeAgentEnv: mocks.buildClaudeAgentEnv,
}));

vi.mock('@texra/tools/claudeAgentImport', async (importActual) => {
  const { Effect } = await import('effect');
  return {
    ...(await importActual<typeof import('@texra/tools/claudeAgentImport')>()),
    importClaudeAgentSdk: () => Effect.succeed(mocks.query),
    findClaudeBinaryPath: mocks.findClaudeBinaryPath,
  };
});

import '@test/support/sessionGraphTestSetup';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { setLogSink } from '@logger/logSink';
import type { RunId } from '@shared/schemas';
import { captureLogEntries } from '@test/support/logSinkCapture';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { openTestDefaultSession } from '@test/support/sessionEnd';
import {
  parkedRoot,
  REAL_RUN_TIMEOUT,
  sessionStoreFaults,
  storedRows,
  untilStored,
  validationHost,
} from '@test/support/storeFaults';
import { noPluginHold } from '@test/support/testPluginServices';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { ClaudeAgentSessions as ClaudeAgentSessionsService } from '@texra/tools/agentCliSessionStores';
import { AgentCliSessionRegistry } from '@texra/tools/agentCliSessionRegistry';
import { ClaudeAgentTool } from '@texra/tools/claudeAgent';
import { generateRunId } from '@utils/core';

interface Parent {
  readonly session: SessionHandle;
  readonly runId: RunId;
  readonly storage: string;
}

/** A root run of the bundled `assistant` in the file's default session,
 *  parked waiting for input: the parent a Claude child is launched under
 *  and delivers to. */
const parkedParent = Effect.gen(function* () {
  const roots = testWorkspaceRoots();
  const session = yield* openTestDefaultSession({ roots });
  const runId = yield* parkedRoot(session, 'Parent.');
  return { session, runId, storage: roots.storage } satisfies Parent;
});

/** The tool's call layer under `parent`'s run, serving `registry` as the
 *  step would. */
const toolLayer = (
  registry: AgentCliSessionRegistry,
  parent: Parent,
  toolPolicy: { readonly stopAfterCycle?: boolean } = {},
) =>
  Layer.merge(
    nativeToolTestLayer({
      run: { session: parent.session, runId: parent.runId, toolPolicy },
    }),
    Layer.succeed(ClaudeAgentSessionsService)(registry),
  );

/** One SDK `query` answering a single result message. */
const answer = (result: Record<string, unknown>) =>
  (async function* () {
    yield { type: 'result', modelUsage: {}, total_cost_usd: 0, ...result };
  })();

/** A successful turn of `session_id`. */
const succeeded = (sessionId: string, text = 'Done.') =>
  answer({ subtype: 'success', session_id: sessionId, result: text });

/** The SDK options each `query` call was made with, in order. */
const queriedOptions = () =>
  mocks.query.mock.calls.map(
    ([args]) => (args as { options: Record<string, unknown> }).options,
  );

/** Wait until the SDK has been queried `n` times. */
const untilQueried = (storage: string, n: number) =>
  untilStored(storage, () => mocks.query.mock.calls.length >= n);

/** The child runs `parent` launched, from the store. */
const childrenOf = (parent: Parent) =>
  storedRows(parent.storage)
    .filter((row) => row.type === 'run.start' && row.parent === parent.runId)
    .map((row) => row.run);

/** A registry whose `claim` announces, through `lost`, the call that lost
 *  the claim: the step that sends a caller into the fallback wait. */
const contendedRegistry = (lost: Deferred.Deferred<void>) => {
  const registry = new AgentCliSessionRegistry(noPluginHold);
  const realClaim = registry.claim.bind(registry);
  const claim = vi
    .spyOn(registry, 'claim')
    .mockImplementation((sessionId: string) => {
      const release = realClaim(sessionId);
      if (!release) Deferred.doneUnsafe(lost, Effect.void);
      return release;
    });
  return { registry, claim };
};

describe(
  'claude_agent tool launch and resume fallback',
  { timeout: REAL_RUN_TIMEOUT },
  () => {
    validationHost('texra-claude-resume-');

    const setUp = Effect.gen(function* () {
      mocks.query.mockReset();
      mocks.buildClaudeAgentEnv.mockReset();
      mocks.findClaudeBinaryPath.mockReset();
      mocks.buildClaudeAgentEnv.mockReturnValue(Effect.succeed({}));
      mocks.findClaudeBinaryPath.mockReturnValue(Effect.succeed(undefined));
      return yield* parkedParent;
    });

    it.live(
      'refuses a one-shot run whose follow-up could never be collected',
      () =>
        Effect.gen(function* () {
          const parent = yield* setUp;
          const registry = new AgentCliSessionRegistry(noPluginHold);
          const result = yield* ClaudeAgentTool.call({
            prompt: 'must not launch into a run that ends first',
          }).pipe(
            Effect.provide(
              toolLayer(registry, parent, { stopAfterCycle: true }),
            ),
          );

          expect(result).toMatchObject({
            status: 'error',
            error: expect.stringContaining(
              'claude_code is unavailable in one-shot runs',
            ),
          });
          expect(childrenOf(parent)).toEqual([]);
        }),
    );

    it.live('does not create a run when Claude binary discovery fails', () =>
      Effect.gen(function* () {
        const parent = yield* setUp;
        mocks.findClaudeBinaryPath.mockReturnValue(
          Effect.fail(new Error('Claude binary lookup failed')),
        );

        const result = yield* ClaudeAgentTool.call({
          prompt: 'must not create a stale child',
        }).pipe(
          Effect.provide(
            toolLayer(new AgentCliSessionRegistry(noPluginHold), parent),
          ),
        );

        expect(result.status).toBe('error');
        expect(childrenOf(parent)).toEqual([]);
      }),
    );

    it.live('logs a detached run-loop rejection through the child trace', () =>
      Effect.gen(function* () {
        const parent = yield* setUp;
        mocks.query.mockImplementation(() =>
          answer({ subtype: 'error_during_execution', errors: ['crashed'] }),
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
          yield* ClaudeAgentTool.call({ prompt: 'launch Claude' }).pipe(
            Effect.provide(
              toolLayer(new AgentCliSessionRegistry(noPluginHold), parent),
            ),
          ),
        ).toMatchObject({ status: 'executed' });
        yield* untilStored(parent.storage, () =>
          logs.has(
            'ERROR',
            'childRunLoop',
            "Child 'claude_code' run loop failed after launch",
          ),
        );
        // The child reads as ended, not as running.
        const [child] = childrenOf(parent);
        expect(
          storedRows(parent.storage).find(
            (row) => row.run === child && row.type === 'run.end',
          )?.data,
        ).toContain("The run's end was not saved: injected appendAll fault");
      }),
    );

    it.live(
      'seeds the fallback launch with the stale session_id so the SDK resumes from disk',
      () =>
        Effect.gen(function* () {
          const parent = yield* setUp;
          mocks.query.mockImplementation(() =>
            succeeded('stale-session', 'Resumed and continued.'),
          );

          yield* ClaudeAgentTool.call({
            prompt: 'continue the refactor',
            session_id: 'stale-session',
          }).pipe(
            Effect.provide(
              toolLayer(new AgentCliSessionRegistry(noPluginHold), parent),
            ),
          );
          yield* untilQueried(parent.storage, 1);

          expect(childrenOf(parent)).toHaveLength(1);
          expect(queriedOptions()[0]?.resume).toBe('stale-session');
        }),
    );

    it.live(
      'sends the selected model id, its effort and adaptive thinking to the SDK',
      () =>
        Effect.gen(function* () {
          const parent = yield* setUp;
          mocks.query.mockImplementation(() => succeeded('model-session'));

          const result = yield* ClaudeAgentTool.call({
            prompt: 'review the proof',
            model: 'anthropic/claude-opus-5-5@high',
          }).pipe(
            Effect.provide(
              toolLayer(new AgentCliSessionRegistry(noPluginHold), parent),
            ),
          );
          expect(result).toMatchObject({ status: 'executed' });
          yield* untilQueried(parent.storage, 1);

          expect(queriedOptions()[0]).toMatchObject({
            model: 'claude-opus-5-5',
            effort: 'high',
            thinking: { type: 'adaptive' },
          });
          // The run's history label is the model's reference.
          const [child] = childrenOf(parent);
          expect(
            storedRows(parent.storage).find(
              (row) => row.run === child && row.type === 'run.config',
            )?.data,
          ).toContain('"model":"anthropic/claude-opus-5-5"');
        }),
    );

    it.live('refuses a model Claude Code cannot run before launching', () =>
      Effect.gen(function* () {
        const parent = yield* setUp;
        const result = yield* ClaudeAgentTool.call({
          prompt: 'review the proof',
          model: 'openai/gpt-6.1-sol',
        }).pipe(
          Effect.provide(
            toolLayer(new AgentCliSessionRegistry(noPluginHold), parent),
          ),
        );

        expect(result).toMatchObject({
          status: 'error',
          error: expect.stringContaining('Claude Code cannot run'),
        });
        expect(childrenOf(parent)).toEqual([]);
      }),
    );

    it.live('preserves legacy usage when a result has no modelUsage', () =>
      Effect.gen(function* () {
        const parent = yield* setUp;
        mocks.query.mockImplementation(() =>
          (async function* () {
            yield {
              type: 'result',
              subtype: 'error_during_execution',
              errors: ['failed before the first model call'],
              usage: { input_tokens: 12, output_tokens: 3 },
              total_cost_usd: 0,
            };
          })(),
        );

        yield* ClaudeAgentTool.call({ prompt: 'start Claude' }).pipe(
          Effect.provide(
            toolLayer(new AgentCliSessionRegistry(noPluginHold), parent),
          ),
        );
        const [child] = childrenOf(parent);
        // The turn publishes its own usage as it returns.
        yield* untilStored(parent.storage, (rows) =>
          rows.some(
            (row) =>
              row.run === child &&
              row.type === 'usage' &&
              row.data.includes('"inputTokens":12') &&
              row.data.includes('"outputTokens":3'),
          ),
        );
      }),
    );

    it.live(
      'launches one fallback loop when concurrent calls use the same stale session_id',
      () =>
        Effect.gen(function* () {
          const parent = yield* setUp;
          const envStarted = yield* Deferred.make<void>();
          const envReady = yield* Deferred.make<NodeJS.ProcessEnv>();
          const secondClaimLost = yield* Deferred.make<void>();
          const { registry, claim } = contendedRegistry(secondClaimLost);
          mocks.query.mockImplementation(() => succeeded('stale-session'));
          mocks.buildClaudeAgentEnv.mockImplementation(() =>
            Deferred.succeed(envStarted, undefined).pipe(
              Effect.andThen(Deferred.await(envReady)),
            ),
          );
          // The contention this case claims is a lost claim: the gate fires
          // from inside the second call's own failed `claim`, the step that
          // sends it into the fallback wait. Gating on anything earlier
          // would let the first launch promote the id before the second
          // call ever contended, and the follow-up assertions would pass on
          // the plain already-active path.
          const call = (prompt: string) =>
            ClaudeAgentTool.call({ prompt, session_id: 'stale-session' }).pipe(
              Effect.provide(toolLayer(registry, parent)),
            );

          const first = yield* Effect.forkChild(call('continue the refactor'));
          yield* Deferred.await(envStarted);
          const second = yield* Effect.forkChild(call('also update the tests'));
          yield* Deferred.await(secondClaimLost);

          expect(mocks.buildClaudeAgentEnv).toHaveBeenCalledTimes(1);
          expect(childrenOf(parent)).toEqual([]);

          // The first launch's loop runs its turn, which promotes the id;
          // the waiting call then queues onto that loop.
          yield* Deferred.succeed(envReady, {});
          expect((yield* Fiber.join(first)).status).toBe('executed');
          expect((yield* Fiber.join(second)).summary).toMatch(
            /Follow-up queued/,
          );
          yield* untilQueried(parent.storage, 2);

          expect(childrenOf(parent)).toHaveLength(1);
          expect(mocks.query.mock.calls.map(([args]) => args.prompt)).toEqual([
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

    it.live(
      'lets a waiting caller own the fallback after the first launch fails',
      () =>
        Effect.gen(function* () {
          const parent = yield* setUp;
          const firstEnvStarted = yield* Deferred.make<void>();
          const firstEnv = yield* Deferred.make<NodeJS.ProcessEnv>();
          const secondDispatching = yield* Deferred.make<void>();
          const { registry } = contendedRegistry(secondDispatching);
          mocks.query.mockImplementation(() => succeeded('stale-session'));
          mocks.buildClaudeAgentEnv
            .mockImplementationOnce(() =>
              // An env read that dies is a defect the tool surfaces as an
              // error result.
              Deferred.succeed(firstEnvStarted, undefined).pipe(
                Effect.andThen(Deferred.await(firstEnv)),
              ),
            )
            .mockReturnValueOnce(Effect.succeed({}));
          const call = (prompt: string) =>
            ClaudeAgentTool.call({ prompt, session_id: 'stale-session' }).pipe(
              Effect.provide(toolLayer(registry, parent)),
            );

          const first = yield* Effect.forkChild(call('first attempt'));
          yield* Deferred.await(firstEnvStarted);
          const second = yield* Effect.forkChild(call('retry from the waiter'));
          yield* Deferred.await(secondDispatching);

          yield* Deferred.die(firstEnv, new Error('first environment failed'));
          const [firstResult, secondResult] = yield* Effect.all([
            Fiber.join(first),
            Fiber.join(second),
          ]);

          expect(firstResult.status).toBe('error');
          expect(secondResult.status).toBe('executed');
          expect(secondResult.summary).toMatch(/Launched Claude Code CLI/);
          expect(mocks.buildClaudeAgentEnv).toHaveBeenCalledTimes(2);
          expect(childrenOf(parent)).toHaveLength(1);
        }),
    );

    it.live(
      'still enqueues a follow-up (no fresh launch) when session_id IS active in the registry',
      () =>
        Effect.gen(function* () {
          const parent = yield* setUp;
          const registry = new AgentCliSessionRegistry(noPluginHold);
          mocks.query.mockImplementation(() => succeeded('sess-resumed'));
          const call = (input: { prompt: string; session_id?: string }) =>
            ClaudeAgentTool.call(input).pipe(
              Effect.provide(toolLayer(registry, parent)),
            );
          yield* call({ prompt: 'start the session' });
          yield* untilStored(
            parent.storage,
            () => registry.lookup('sess-resumed') !== undefined,
          );

          const result = yield* call({
            prompt: 'one more follow-up',
            session_id: 'sess-resumed',
          });

          expect(result.status).toBe('executed');
          expect(result.summary).toMatch(/Follow-up queued/);
          yield* untilQueried(parent.storage, 2);
          expect(childrenOf(parent)).toHaveLength(1);
          expect(queriedOptions()[1]?.resume).toBe('sess-resumed');
        }),
    );

    it.live(
      'forks an active session into a distinct child and only forks its first turn',
      () =>
        Effect.gen(function* () {
          const parent = yield* setUp;
          const registry = new AgentCliSessionRegistry(noPluginHold);
          const sourceRunId = generateRunId();
          registry.register('source-session', { runId: sourceRunId });
          mocks.query.mockImplementation(() => succeeded('forked-session'));
          const call = (input: {
            prompt: string;
            session_id: string;
            fork_session?: boolean;
          }) =>
            ClaudeAgentTool.call(input).pipe(
              Effect.provide(toolLayer(registry, parent)),
            );

          const result = yield* call({
            prompt: 'try a different proof',
            session_id: 'source-session',
            fork_session: true,
          });
          expect(result.summary).toMatch(/Launched Claude Code CLI/);
          yield* untilStored(
            parent.storage,
            () => registry.lookup('forked-session') !== undefined,
          );
          // The fork's next turn continues the fork, not its source.
          expect(
            (yield* call({
              prompt: 'continue the fork',
              session_id: 'forked-session',
            })).summary,
          ).toMatch(/Follow-up queued/);
          yield* untilQueried(parent.storage, 2);

          expect(childrenOf(parent)).toHaveLength(1);
          expect(queriedOptions()[0]).toMatchObject({
            resume: 'source-session',
            forkSession: true,
          });
          expect(queriedOptions()[1]).toMatchObject({
            resume: 'forked-session',
          });
          expect(queriedOptions()[1]).not.toHaveProperty('forkSession');
          expect(registry.lookup('source-session')?.runId).toBe(sourceRunId);
        }),
    );

    it.live.each([
      { caseName: 'omits the new session id' },
      { caseName: 'echoes the source session id', sessionId: 'source-session' },
    ])('fails a fork that $caseName', ({ sessionId }) =>
      Effect.gen(function* () {
        const parent = yield* setUp;
        const registry = new AgentCliSessionRegistry(noPluginHold);
        registry.register('source-session', { runId: generateRunId() });
        mocks.query.mockImplementation(() =>
          (async function* () {
            yield {
              type: 'result',
              subtype: 'success',
              result: 'Malformed fork turn',
              ...(sessionId ? { session_id: sessionId } : {}),
              usage: { input_tokens: 7, output_tokens: 3 },
              total_cost_usd: 0.25,
            };
          })(),
        );

        const result = yield* ClaudeAgentTool.call({
          prompt: 'try a different proof',
          session_id: 'source-session',
          fork_session: true,
        }).pipe(Effect.provide(toolLayer(registry, parent)));
        expect(result.status).toBe('executed');

        // The failed fork ends its child, and its parent hears why and what
        // it cost; nothing resumes the source.
        const [child] = childrenOf(parent);
        yield* untilStored(parent.storage, (rows) =>
          rows.some((row) => row.run === child && row.type === 'run.end'),
        );
        const delivered = storedRows(parent.storage).filter(
          (row) =>
            row.run === parent.runId &&
            row.data.includes('Claude Code fork did not create a distinct'),
        );
        expect(delivered.map((row) => row.data).join('')).toContain(
          '<cost-usd>0.2500</cost-usd>',
        );
        expect(mocks.query).toHaveBeenCalledOnce();
        expect(queriedOptions()[0]).toMatchObject({
          resume: 'source-session',
          forkSession: true,
        });
      }),
    );

    it.live('rejects a fork from a live session owned by another run', () =>
      Effect.gen(function* () {
        const owner = yield* setUp;
        const registry = new AgentCliSessionRegistry(noPluginHold);
        mocks.query.mockImplementation(() => succeeded('foreign-session'));
        // A live Claude child of another root owns the session.
        const other = yield* parkedParent;
        yield* ClaudeAgentTool.call({ prompt: 'own the session' }).pipe(
          Effect.provide(toolLayer(registry, other)),
        );
        yield* untilStored(
          other.storage,
          () => registry.lookup('foreign-session') !== undefined,
        );

        const result = yield* ClaudeAgentTool.call({
          prompt: 'read a foreign branch',
          session_id: 'foreign-session',
          fork_session: true,
        }).pipe(Effect.provide(toolLayer(registry, owner)));

        expect(result).toMatchObject({
          status: 'error',
          error: expect.stringContaining('owned by a different session'),
        });
        expect(childrenOf(owner)).toEqual([]);
      }),
    );
  },
);
