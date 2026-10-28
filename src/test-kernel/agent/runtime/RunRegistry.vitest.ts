// Third-party imports
import { it } from '@effect/vitest';
import { Cause, Deferred, Effect, Exit, Fiber, SubscriptionRef } from 'effect';
import { describe, expect, vi } from 'vitest';

// Local imports
import type { RunHandle } from '@agent/runtime/RunHandle';
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
  testRunHandle,
} from '@test/support/runHandleFixtures';
import { untrackRun } from '@test/support/sessionEnd';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { setupPlatform } from '@test/support/setupPlatform';
import { generateRunId } from '@utils/core';

// Local file imports

setupPlatform({ workspacePath: '/workspace' });

/** Builds a `RunHandle` for a toolUse test-subagent, the shape most tests need. */
function createHandle(runId: RunId, parent: RunId | null = null): RunHandle {
  return testRunHandle({ runId, parent, agent: 'test-subagent' });
}

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

/** Tracks a handle whose run a stop reaches the way production stops a run:
 * a live generation fiber on the run registry, interrupted by run id. */
function trackInterruptibleHandle(
  registry: RunRegistry,
  runId: RunId,
  parent: RunId | null,
  interrupt: () => void,
): void {
  registry.track(createHandle(runId, parent));
  admitInterruptibleRun(registry, runId, interrupt);
}

describe('runRegistry', () => {
  it.effect(
    'keeps shutdown draining after terminal untrack until run cleanup releases its lane',
    () =>
      Effect.gen(function* () {
        const { registry } = createRegistry();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        const runId = generateRunId();
        const untracked = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const drained = yield* Deferred.make<void>();
        const generation = yield* Effect.forkChild(
          startAwaited(
            registry,
            runId,
            Effect.sync(() => registry.track(createHandle(runId))).pipe(
              Effect.ensuring(
                Effect.gen(function* () {
                  untrackRun(registry, runId);
                  yield* Deferred.succeed(untracked, undefined);
                  yield* Deferred.await(release);
                }),
              ),
            ),
          ),
        );
        yield* Deferred.await(untracked);
        yield* registry.stopAll();
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
        registry.track(createHandle(rootRunId));
        const root = yield* Effect.forkChild(
          startAwaited(
            registry,
            rootRunId,
            Effect.never.pipe(Effect.onInterrupt(() => Deferred.await(ended))),
          ),
          { startImmediately: true },
        );
        trackInterruptibleHandle(
          registry,
          childRunId,
          rootRunId,
          childInterrupt,
        );
        setPhase(rootRunId, RUN_PHASE.RUNNING);

        // The detaching stop settles completely, its children severed,
        // while the parent's `run.end` has not folded yet. The stop still
        // stands on the parent's activation, so a child whose lineage read
        // preceded the stop is refused as it registers.
        yield* registry.stop(rootRunId, {
          detachActiveChildren: true,
          reason: 'user',
        }).settlement;
        expect(registry.parentOf(childRunId)).toBeNull();
        expect(() =>
          registry.track(createHandle(lateChildRunId, rootRunId)),
        ).toThrow(/that run was stopped/);
        expect(registry.get(lateChildRunId)?.handle).toBeUndefined();

        // The fold changes nothing for the detached child: its sever stands.
        setPhase(rootRunId, RUN_PHASE.CANCELLED);
        yield* Deferred.succeed(ended, undefined);
        yield* Fiber.await(root);
        expect(childInterrupt).not.toHaveBeenCalled();
        expect(registry.parentOf(childRunId)).toBeNull();

        // From the fold on, admission itself refuses the stopped parent.
        expect(() =>
          registry.track(createHandle(postFoldChildRunId, rootRunId)),
        ).toThrow(/that run was stopped/);
        const launched = yield* Effect.exit(
          registry.start(
            postFoldChildRunId,
            Effect.void,
            (run) => run,
            rootRunId,
          ),
        );
        expect(
          Exit.isFailure(launched) && Cause.squash(launched.cause),
        ).toMatchObject({
          message: expect.stringMatching(/that run was stopped/),
        });
        expect(registry.get(postFoldChildRunId)?.handle).toBeUndefined();
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

      // A parked turn may have no running generation, but its handle retains ownership.
      const parked = createHandle(runId, generateRunId());
      registry.track(parked);
      expect(yield* Effect.flip(removal)).toBeInstanceOf(RunLive);
      untrackRun(registry, runId);

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
