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
 * - concurrent calls on one stale id start two loops, spin on the claim, or
 *   strand the waiter when the first launch fails;
 * - a fork mutates its source session, or forks a session another run owns;
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
import type { RunId } from '@shared/schemas';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { openTestDefaultSession } from '@test/support/sessionEnd';
import {
  parkedRoot,
  REAL_RUN_TIMEOUT,
  storedRows,
  untilStored,
  validationHost,
} from '@test/support/storeFaults';
import { noPluginHold } from '@test/support/testPluginServices';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { ClaudeAgentSessions as ClaudeAgentSessionsService } from '@texra/tools/agentCliSessionStores';
import { AgentCliSessionRegistry } from '@texra/tools/agentCliSessionRegistry';
import { ClaudeAgentTool } from '@texra/tools/claudeAgent';

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
