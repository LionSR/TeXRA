// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber, type Scope, SubscriptionRef } from 'effect';
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
import { type ApprovalGrants } from '@shared/approvalBypassKind';
import {
  aggregateTarget,
  RUN_PHASE,
  type RunId,
  type RunPhase,
  type RunSubstate,
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

type HandleOverrides = {
  agentName?: string;
};

/** Builds a `RunHandle` for a toolUse test-subagent, the shape most tests need. */
function createHandle(
  runId: RunId,
  parent: RunId | null = null,
  overrides: HandleOverrides = {},
): RunHandle {
  const handle = testRunHandle({
    runId,
    parent,
    agent: overrides.agentName ?? 'test-subagent',
  });
  return handle;
}

/**
 * The phase the registry reads, stated the way the fold carries it
 * (`RunView.status`, ruling A9-2). The registry holds no phase of its own, so
 * a test that needs one puts it here; the only half the registry owns is
 * being told that a run ended, which {@link FoldedPhases.set} does the way
 * the session's tail does (on every phase: the sweep reads the fold).
 */
interface FoldedPhases {
  readonly set: (
    runId: RunId,
    status: RunPhase,
    extra?: {
      readonly substate?: RunSubstate;
      readonly runStartedAt?: number;
    },
  ) => void;
}

/** Wires the events/phases/registry trio most tests drive kills through. */
function createRegistry(
  options: {
    commit?: (
      drafts: readonly SessionEventDraft[],
    ) => Effect.Effect<void, Error>;
    holdRunClaim?: (runId: RunId) => Effect.Effect<void, Error, Scope.Scope>;
    borrowRunClaim?: (runId: RunId) => Effect.Effect<void, Error, Scope.Scope>;
  } = {},
): {
  events: PublishedEvents;
  phases: FoldedPhases;
  registry: RunRegistry;
  grants: {
    readonly runs: Map<RunId, { readonly parentId: RunId | null }>;
    readonly policy: Map<RunId, ApprovalGrants>;
  };
} {
  // The session's publish path, in miniature: every draft the registry
  // publishes is appended in order, and a phase the fold moved is what the
  // registry reads of the run's view.
  const events: PublishedEvents = { published: [] };
  const views = new Map<RunId, RunView>();
  const phases: FoldedPhases = {
    set: (runId, status, extra = {}) => {
      // The fields the registry reads off a run's view (these runs are
      // roots); the one assertion stands for the rest of the projection no
      // reader here touches.
      views.set(runId, {
        status,
        substate: extra.substate ?? null,
        runStartedAt: extra.runStartedAt ?? null,
        parentId: null,
      } as RunView);
    },
  };
  // What the registry reads of its session: the run's view, the grants a
  // detached child keeps, the claims (no-ops unless a test passes its own),
  // and its own `run.detach` batches, which land in `events`. Everything
  // else, a run's end among it, is the default session's.
  const real = testDefaultSession();
  const grants = {
    runs: new Map<RunId, { readonly parentId: RunId | null }>(),
    policy: new Map<RunId, ApprovalGrants>(),
  };
  const grantView = Effect.runSync(
    SubscriptionRef.make(grants as unknown as SessionView),
  );
  const commit =
    options.commit ??
    ((drafts: readonly SessionEventDraft[]) =>
      Effect.sync(() => {
        events.published.push(...drafts);
      }));
  // A committed `run.detach` folds the way the view's does: the child's
  // edge is gone.
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
      // A detach job's batch lands in `events`; every other write (a run's
      // end) is the default session's.
      transact: ((work: unknown) =>
        typeof work === 'function'
          ? real.log.transact((tx) =>
              (work as (tx: SessionTransaction) => Effect.Effect<unknown>)({
                ...tx,
                // cast: a refused detach fails as the test's own error.
                append: ((drafts: readonly SessionEventDraft[]) =>
                  drafts.some((draft) => draft.type === 'run.detach')
                    ? Effect.as(
                        Effect.andThen(commit(drafts), fold(drafts)),
                        [],
                      )
                    : runStateAppend(tx.append)(
                        drafts,
                      )) as SessionTransaction['append'],
              }),
            )
          : Effect.as(
              commit(work as readonly SessionEventDraft[]),
              [],
            )) as SessionLog['transact'],
      hold: (runId: RunId, hold?: { readonly ends?: boolean }) =>
        (hold?.ends === true ? options.holdRunClaim : options.borrowRunClaim)?.(
          runId,
        ) ?? Effect.void,
    },
  } as SessionHandle;
  const registry = new RunRegistry({
    session: () => session,
    fork: testRunFork,
    programs: testRunPrograms,
    wake: () => {},
  });
  return { events, phases, registry, grants };
}

interface PublishedEvents {
  readonly published: SessionEventDraft[];
}

/** Tracks a handle whose run a stop reaches the way production stops a run:
 * a live generation fiber on the run registry, interrupted by run id. The
 * interrupt has observably landed once the stop's settlement resolves. */
function trackInterruptibleHandle(
  registry: RunRegistry,
  ids: {
    runId: RunId;
    parent?: RunId | null;
  },
  interrupt: () => void,
  overrides?: HandleOverrides,
): RunHandle {
  const handle = createHandle(ids.runId, ids.parent ?? null, overrides);
  registry.track(handle);
  admitInterruptibleRun(registry, ids.runId, interrupt);
  return handle;
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
        expect(registry.get(runId)?.handle).toBeUndefined();
        expect(registry.get(runId)?.live === true).toBe(true);
        const drain = yield* Effect.forkChild(
          registry
            .awaitDrained()
            .pipe(Effect.andThen(Deferred.succeed(drained, undefined))),
          { startImmediately: true },
        );
        try {
          yield* Effect.yieldNow;
          expect(yield* Deferred.isDone(drained)).toBe(false);
        } finally {
          yield* Deferred.succeed(release, undefined);
        }
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
        const { phases, registry } = createRegistry();
        const rootRunId = generateRunId();
        const childRunId = generateRunId();
        const lateChildRunId = generateRunId();
        const postFoldChildRunId = generateRunId();
        const childInterrupt = vi.fn();

        try {
          trackInterruptibleHandle(registry, { runId: rootRunId }, vi.fn(), {
            agentName: 'test-root',
          });
          trackInterruptibleHandle(
            registry,
            { runId: childRunId, parent: rootRunId },
            childInterrupt,
          );
          phases.set(rootRunId, RUN_PHASE.RUNNING);

          // The detaching stop settles completely, its children severed,
          // while the parent's `run.end` has not folded yet. The stop still
          // stands on the parent's entry, so a child whose lineage read
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
          phases.set(rootRunId, RUN_PHASE.CANCELLED);
          expect(childInterrupt).not.toHaveBeenCalled();
          expect(registry.parentOf(childRunId)).toBeNull();

          // From the fold on, admission itself refuses the stopped parent.
          expect(() =>
            registry.track(createHandle(postFoldChildRunId, rootRunId)),
          ).toThrow(/that run was stopped/);
          expect(() =>
            registry.reserveChildActivation({
              runId: postFoldChildRunId,
              launchParent: rootRunId,
              interrupt: vi.fn(),
            }),
          ).toThrow(/that run was stopped/);
          expect(registry.get(postFoldChildRunId)?.handle).toBeUndefined();
        } finally {
          registry.dispose();
        }
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
      try {
        // Admission before the launch callback begins must already see its slot.
        expect(yield* Effect.flip(removal)).toBeInstanceOf(RunLive);
        yield* Deferred.await(started);
        expect(yield* Effect.flip(removal)).toBeInstanceOf(RunLive);
        expect(remove).not.toHaveBeenCalled();
      } finally {
        yield* Deferred.succeed(finish, undefined);
      }
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
