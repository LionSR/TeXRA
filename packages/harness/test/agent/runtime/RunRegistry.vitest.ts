// Third-party imports
import { layer } from '@effect/vitest';
import { Context, Deferred, Effect, Fiber, Layer, Schema } from 'effect';
import { expect } from 'vitest';

// Local imports
import { AgentConfigSchema, generateRunId } from '@texra-ai/harness/schemas';
import {
  RunRegistry,
  SessionRunRegistry,
  type RunRegistryInit,
} from '@agent/runtime/runRegistry';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { registrationRows } from '@agent/storage/runLifecycle';
import { SessionRoots } from '@platform/rootedFs';
import { SessionLog, SessionViewAccess } from '@shared/session/runHistory';
import {
  startAwaited,
  testRunFork,
  testRunInSession,
} from '@test/support/runHandleFixtures';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import {
  FakeHost,
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';

/** The file's default session: the block's session over the process roots. */
const defaultSession = Effect.flatMap(TestSession, sessionHandleOf);

const CONFIG = Schema.decodeUnknownSync(AgentConfigSchema)({
  agent: 'chat',
  model: 'deepseek/deepseek-v4-flash',
  instruction: 'Check the proof.',
});

/**
 * A registry of its own over the default session, whose runs start on
 * `fork`: its close (`stopAll`) is the test's, not the session's. Its stops
 * commit on the session; the process services are the caller's.
 */
function createRegistry(
  session: Context.Context<SessionServices>,
  fork: RunRegistryInit['fork'],
): SessionRunRegistry {
  return new SessionRunRegistry({
    roots: Context.get(session, SessionRoots),
    view: Context.get(session, SessionViewAccess),
    log: Context.get(session, SessionLog),
    runsHere: () => {},
    inSession: (effect) => testRunInSession(Effect.provide(effect, session)),
    fork,
    wake: () => {},
  });
}

// The default session lives for the file; each case runs over a fresh host.
// Live clock: a stop's rows and the registry's forks run on real event-loop
// turns, as on the process runtime.
layer(Layer.provideMerge(TestSession.layer(), SessionGraph.hosted), {
  excludeTestServices: true,
})('runRegistry', (it) => {
  it.layer(FakeHost.layer({ workspaceRoot: '/workspace' }), {
    buildPerTest: true,
  })((it) => {
    it.effect(
      "keeps shutdown draining after the run's terminal until run cleanup releases its lane",
      () =>
        Effect.gen(function* () {
          const registry = createRegistry(
            yield* defaultSession,
            yield* testRunFork,
          );
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => registry.dispose()),
          );
          const runId = generateRunId();
          const ended = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const drained = yield* Deferred.make<void>();
          const generation = yield* Effect.forkChild(
            startAwaited(
              registry,
              runId,
              Effect.void.pipe(
                Effect.ensuring(
                  Deferred.succeed(ended, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                  ),
                ),
              ),
            ),
          );
          yield* Deferred.await(ended);
          yield* registry.stopAll();
          expect(registry.get(runId)).toBeDefined();
          const drain = yield* Effect.forkChild(
            registry
              .awaitDrained()
              .pipe(Effect.andThen(Deferred.succeed(drained, undefined))),
            { startImmediately: true },
          );
          yield* Effect.yieldNow;
          expect(yield* Deferred.isDone(drained)).toBe(false);
          yield* Deferred.succeed(release, undefined);
          // The close stopped the generation: it ends interrupted.
          yield* Fiber.await(generation);
          yield* Fiber.join(drain);
          expect(registry.get(runId)).toBeUndefined();
        }),
    );

    it.effect(
      "refuses a child under a stopped parent from the stop's row on (issue #12442)",
      () =>
        Effect.gen(function* () {
          const session = yield* defaultSession;
          const runs = Context.get(session, RunRegistry);
          const rootRunId = yield* publishTestRunStart(session);
          const root = yield* Effect.forkChild(
            startAwaited(runs, rootRunId, Effect.never),
            { startImmediately: true },
          );
          // The stop's `run.stop` row stands on the parent before any end
          // of it: a child registering from then on reads the stop, whether
          // or not the parent's end has followed it (here it never does).
          expect(yield* runs.stop(rootRunId, 'user')).toBe(true);
          yield* Fiber.await(root);
          const refusal = yield* Effect.flip(
            registrationRows(generateRunId(), CONFIG, {
              identity: { kind: 'agent', agent: 'chat' },
              parentRunId: rootRunId,
            }).pipe(Effect.provide(session)),
          );
          expect(refusal.message).toMatch(/that run was stopped/);
        }),
    );
  });
});
