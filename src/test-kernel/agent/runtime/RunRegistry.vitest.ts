// Third-party imports
import { it } from '@effect/vitest';
import { Cause, Deferred, Effect, Exit, Fiber, SubscriptionRef } from 'effect';
import { describe, expect, vi } from 'vitest';

// Local imports
import { RunRegistry, RunLive } from '@agent/runtime/runRegistry';
import type {
  SessionHandle,
  SessionLog,
  SessionTransaction,
} from '@agent/runtime/SessionHandle';
import { runStateAppend } from '@shared/session/runHistory';
import {
  aggregateTarget,
  RUN_PHASE,
  type RunId,
  type RunPhase,
  type SessionEventDraft,
} from '@shared/schemas';
import type { RunView, SessionView } from '@shared/session/sessionView';
import {
  startAwaited,
  admitInterruptibleRun,
  testRunFork,
  testRunPrograms,
} from '@test/support/runHandleFixtures';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { setupPlatform } from '@test/support/setupPlatform';
import { generateRunId } from '@utils/core';

// Local file imports

setupPlatform({ workspacePath: '/workspace' });

/**
 * Wires a registry over the default session. The registry holds no phase of
 * its own: `setPhase` states the phase the fold carries (`RunView.status`)
 * the way the session's tail does, and a committed `run.detach` folds the way
 * the view's does: the child's edge is gone.
 */
function createRegistry(): {
  setPhase: (runId: RunId, status: RunPhase) => void;
  registry: RunRegistry;
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
  const real = testDefaultSession();
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
  const session = {
    ...real,
    view: {
      ...real.view,
      ref: grantView,
      run: (runId: RunId) => views.get(runId),
    },
    log: {
      ...real.log,
      transact: ((work: unknown) =>
        typeof work === 'function'
          ? real.log.transact((tx) =>
              (work as (tx: SessionTransaction) => Effect.Effect<unknown>)({
                ...tx,
                append: ((drafts: readonly SessionEventDraft[]) =>
                  drafts.some((draft) => draft.type === 'run.detach')
                    ? Effect.as(fold(drafts), [])
                    : runStateAppend(tx.append)(
                        drafts,
                      )) as SessionTransaction['append'],
              }),
            )
          : Effect.succeed([])) as SessionLog['transact'],
      hold: () => Effect.void,
    },
  } as SessionHandle;
  const registry = new RunRegistry({
    session: () => session,
    fork: testRunFork,
    programs: testRunPrograms,
    wake: () => {},
  });
  return { setPhase, registry };
}

describe('runRegistry', () => {
  it.effect(
    "keeps shutdown draining after the run's terminal until run cleanup releases its lane",
    () =>
      Effect.gen(function* () {
        const { registry } = createRegistry();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
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
        expect(registry.get(runId)?.live === true).toBe(true);
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
        expect(registry.get(runId)?.live === true).toBe(false);
      }),
  );

  it.effect(
    "refuses a child under a stopped parent from the stop's request to its fold and on (issue #12442)",
    () =>
      Effect.gen(function* () {
        const { setPhase, registry } = createRegistry();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
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
            Effect.never.pipe(Effect.onInterrupt(() => Deferred.await(ended))),
          ),
          { startImmediately: true },
        );
        admitInterruptibleRun(registry, childRunId, childInterrupt, rootRunId);
        setPhase(rootRunId, RUN_PHASE.RUNNING);
        /** The refusal a child launched under the root meets, if any. */
        const refusal = (childRunId: RunId) =>
          Effect.map(
            Effect.exit(
              registry.start(childRunId, Effect.void, (run) => run, rootRunId),
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
        yield* registry.stop(rootRunId, {
          detachActiveChildren: true,
          reason: 'user',
        }).settlement;
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
});

it.effect(
  'refuses owned runs and reserves an idle deletion before a competing launch',
  () =>
    Effect.gen(function* () {
      const { registry } = createRegistry();
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
      const removal = registry.withInactiveRunStep(runId, Effect.sync(remove));
      // Admission before the launch callback begins must already see its slot.
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
