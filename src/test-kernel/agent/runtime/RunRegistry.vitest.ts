// Third-party imports
import { layer } from '@effect/vitest';
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  SubscriptionRef,
  Context,
} from 'effect';
import { expect, vi } from 'vitest';

// Local imports
import {
  generateRunId,
  RUN_PHASE,
  type RunId,
  type RunPhase,
  type RunView,
  type SessionEventDraft,
  type SessionView,
} from '@texra-ai/harness/schemas';
import {
  RunRegistry,
  RunLive,
  type RunRegistryInit,
} from '@agent/runtime/runRegistry';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { SessionRoots } from '@platform/rootedFs';
import {
  runStateAppend,
  SessionLog,
  SessionViewAccess,
} from '@shared/session/runHistory';
import { aggregateTarget } from '@shared/schemas';
import {
  startAwaited,
  admitInterruptibleRun,
  testRunFork,
  testRunPrograms,
} from '@test/support/runHandleFixtures';
import {
  FakeHost,
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';

/** The file's default session: the block's session over the process roots. */
const defaultSession = Effect.flatMap(TestSession, sessionHandleOf);

/**
 * Wires a registry over the default session, whose runs start on `fork`.
 * The registry holds no phase of its own: `setPhase` states the phase the
 * fold carries (`RunView.status`) the way the session's tail does, and a
 * committed `run.detach` folds the way the view's does: the child's edge is
 * gone.
 */
function createRegistry(
  real: Context.Context<SessionServices>,
  fork: RunRegistryInit['fork'],
): {
  setPhase: (runId: RunId, status: RunPhase) => void;
  registry: RunRegistry;
  session: Context.Context<SessionServices>;
} {
  const views = new Map<RunId, RunView>();
  const setPhase = (runId: RunId, status: RunPhase) => {
    // The fields the registry reads off a run's view (these runs are roots).
    views.set(runId, {
      status,
      substate: null,
      runStartedAt: null,
      parentId: null,
    } as RunView);
  };
  // What the registry reads of its session: the run's view, the grants a
  // detached child keeps, and its own `run.detach` batches. Everything else,
  // a run's end among it, is the default session's.
  const grantView = Effect.runSync(
    SubscriptionRef.make({
      runs: new Map(),
      policy: new Map(),
    } as unknown as SessionView),
  );
  const fold = (drafts: readonly SessionEventDraft[]) =>
    Effect.sync(() => {
      for (const draft of drafts)
        if (draft.type === 'run.detach') {
          const id = aggregateTarget(draft.aggregateId).id as RunId;
          views.set(id, { ...views.get(id), parentId: null } as RunView);
        }
    });
  const view: SessionViewAccess['Service'] = {
    ...Context.get(real, SessionViewAccess),
    ref: grantView,
    run: (runId: RunId) => views.get(runId),
  };
  const log: SessionLog['Service'] = {
    ...Context.get(real, SessionLog),
    transact: ((work: unknown) =>
      typeof work === 'function'
        ? Context.get(real, SessionLog).transact((tx) =>
            (work as (job: typeof tx) => Effect.Effect<unknown>)({
              ...tx,
              append: ((drafts: readonly SessionEventDraft[]) =>
                drafts.some((draft) => draft.type === 'run.detach')
                  ? Effect.as(fold(drafts), [])
                  : runStateAppend(tx.append)(drafts)) as typeof tx.append,
            }),
          )
        : Effect.succeed([])) as SessionLog['Service']['transact'],
    hold: () => Effect.void,
  };
  const registry = new RunRegistry({
    roots: Context.get(real, SessionRoots),
    view,
    log,
    fork,
    programs: testRunPrograms,
    wake: () => {},
  });
  // The session the registry's stops end runs over: the real one, with the
  // view and log the registry reads.
  const session = Context.add(
    Context.add(real, SessionViewAccess, view),
    SessionLog,
    log,
  );
  return { setPhase, registry, session };
}

// The default session lives for the file; each case runs over a fresh host.
// Live clock: a stop's settlement and the registry's forks run on real
// event-loop turns, as on the process runtime.
layer(Layer.provideMerge(TestSession.layer(), SessionGraph.layer), {
  excludeTestServices: true,
})('runRegistry', (it) => {
  it.layer(FakeHost.layer({ workspacePath: '/workspace' }), {
    buildPerTest: true,
  })((it) => {
    it.effect(
      "keeps shutdown draining after the run's terminal until run cleanup releases its lane",
      () =>
        Effect.gen(function* () {
          const { registry } = createRegistry(
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
          registry.stopAll();
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
      "refuses a child under a stopped parent from the stop's request to its fold and on (issue #12442)",
      () =>
        Effect.gen(function* () {
          const { setPhase, registry, session } = createRegistry(
            yield* defaultSession,
            yield* testRunFork,
          );
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => registry.dispose()),
          );
          const rootRunId = generateRunId();
          const childRunId = generateRunId();
          const lateChildRunId = generateRunId();
          const postFoldChildRunId = generateRunId();
          const childInterrupt = vi.fn();

          // The parent's generation unwinds from its stop until `ended`, as a
          // terminal writing its `run.end` does.
          const ended = yield* Deferred.make<void>();
          const root = yield* Effect.forkChild(
            startAwaited(
              registry,
              rootRunId,
              Effect.never.pipe(
                Effect.onInterrupt(() => Deferred.await(ended)),
              ),
            ),
            { startImmediately: true },
          );
          admitInterruptibleRun(
            registry,
            childRunId,
            childInterrupt,
            rootRunId,
          );
          setPhase(rootRunId, RUN_PHASE.RUNNING);
          /** The refusal a child launched under the root meets, if any. */
          const refusal = (childRunId: RunId) =>
            Effect.map(
              Effect.exit(
                registry.start(
                  childRunId,
                  Effect.void,
                  (run) => run,
                  rootRunId,
                ),
              ),
              (exit) => Exit.isFailure(exit) && Cause.squash(exit.cause),
            );
          const stopped = {
            message: expect.stringMatching(/that run was stopped/),
          };

          // The detaching stop settles completely, its children severed,
          // while the parent's `run.end` has not folded yet. The stop still
          // stands on the parent's activation, so a child whose lineage read
          // preceded the stop is refused as it registers.
          yield* registry
            .stop(rootRunId, {
              detachActiveChildren: true,
              reason: 'user',
            })
            .settlement.pipe(Effect.provide(session));
          expect(registry.bornDetached(childRunId)).toBe(true);
          expect(yield* refusal(lateChildRunId)).toMatchObject(stopped);

          // The fold changes nothing for the detached child: its sever stands.
          setPhase(rootRunId, RUN_PHASE.CANCELLED);
          yield* Deferred.succeed(ended, undefined);
          yield* Fiber.await(root);
          expect(childInterrupt).not.toHaveBeenCalled();
          expect(registry.bornDetached(childRunId)).toBe(true);

          // From the fold on, admission itself refuses the stopped parent.
          expect(yield* refusal(postFoldChildRunId)).toMatchObject(stopped);
        }),
    );

    it.effect(
      'refuses owned runs and reserves an idle deletion before a competing launch',
      () =>
        Effect.gen(function* () {
          const { registry } = createRegistry(
            yield* defaultSession,
            yield* testRunFork,
          );
          const runId = 'abcd12' as RunId;
          const started = yield* Deferred.make<void>();
          const finish = yield* Deferred.make<void>();
          const generation = yield* Effect.forkChild(
            startAwaited(
              registry,
              runId,
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(finish)),
              ),
            ),
            { startImmediately: true },
          );
          const remove = vi.fn();
          const removal = registry.withInactiveRunStep(
            runId,
            Effect.sync(remove),
          );
          // Admission before the launch callback begins must already see its
          // slot.
          expect(yield* Effect.flip(removal)).toBeInstanceOf(RunLive);
          yield* Deferred.await(started);
          expect(yield* Effect.flip(removal)).toBeInstanceOf(RunLive);
          expect(remove).not.toHaveBeenCalled();
          yield* Deferred.succeed(finish, undefined);
          yield* Fiber.join(generation);
          yield* Effect.yieldNow;

          const admitted = yield* Deferred.make<void>();
          const collected = yield* Deferred.make<void>();
          const deleting = yield* Effect.forkChild(
            registry.withInactiveRunStep(
              runId,
              Effect.gen(function* () {
                yield* Deferred.succeed(admitted, undefined);
                yield* Deferred.await(collected);
                remove();
              }),
            ),
          );
          yield* Deferred.await(admitted);
          const launch = vi.fn(async () => {});
          const next = yield* Effect.forkChild(
            startAwaited(registry, runId, Effect.promise(launch)),
            { startImmediately: true },
          );
          expect(launch).not.toHaveBeenCalled();
          yield* Deferred.succeed(collected, undefined);
          yield* Fiber.join(deleting);
          yield* Fiber.join(next);
          expect(remove).toHaveBeenCalledOnce();
          expect(launch).toHaveBeenCalledOnce();
          registry.dispose();
        }),
    );
  });
});
