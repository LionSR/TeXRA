// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';
import { describe, expect, vi } from 'vitest';

// Local imports
import type { AgentTrace } from '@agent/trace';
import { finalizeRun } from '@agent/storage/runLifecycle';
import type {
  RunHandle,
  LiveToolUseFlowContext,
} from '@agent/runtime/RunHandle';
import { RunRegistry } from '@agent/runtime/runRegistry';
import { RunLive, RunRoster } from '@agent/runtime/runRoster';
import { type SessionHandle } from '@agent/runtime/SessionHandle';
import { createSessionApprovals } from '@agent/runtime/runApprovalQueue';
import {
  aggregateId as qualifyAggregateId,
  RUN_OUTCOME,
  RUN_PHASE,
  RUN_SUBSTATE,
  type RunId,
  type RunPhase,
  type RunSubstate,
  AgentCategory,
  type SessionEventDraft,
} from '@shared/schemas';
import type { RunView } from '@shared/session/sessionView';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import {
  admitInterruptibleRun,
  testRunHandle,
} from '@test/support/runHandleFixtures';
import { setupPlatform } from '@test/support/setupPlatform';
import { generateRunId } from '@utils/core';

// Local file imports
import { eventsOfType } from '../progressTestUtils';

const storageMocks = vi.hoisted(() => ({
  finalizeRun: vi.fn(),
}));

// The registry deep-imports finalizeRun from runLifecycle
// (not the `@agent/storage` barrel), so the spy lives on that leaf module.
// Mocking both the barrel and the leaf with the same `vi.fn` whose
// implementation points at `importOriginal`'s barrel export recurses through
// the re-export and blows the stack.
vi.mock('@agent/storage/runLifecycle', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent/storage/runLifecycle')>();
  storageMocks.finalizeRun.mockImplementation(actual.finalizeRun);
  return {
    ...actual,
    finalizeRun: storageMocks.finalizeRun,
  };
});
vi.mock('@agent/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/storage')>();
  return {
    ...actual,
    finalizeRun: storageMocks.finalizeRun,
  };
});

setupPlatform({ workspacePath: '/workspace' });

type HandleOverrides = {
  agentName?: string;
  category?: AgentCategory;
  trace?: AgentTrace;
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
    category: overrides.category,
    trace: overrides.trace,
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
    approvals?: ReturnType<typeof createSessionApprovals>;
    commit?: (
      drafts: readonly SessionEventDraft[],
    ) => Effect.Effect<void, Error>;
  } = {},
): {
  events: PublishedEvents;
  phases: FoldedPhases;
  registry: RunRegistry;
} {
  // The session's publish path, in miniature: every draft the registry
  // publishes is appended in order, and a phase the fold moved reaches
  // the folded-stop sweep the way the session's committed tail does.
  const events: PublishedEvents = { published: [] };
  const views = new Map<RunId, RunView>();
  const phases: FoldedPhases = {
    set: (runId, status, extra = {}) => {
      // The three fields the registry reads off a run's view; the one
      // assertion stands for the rest of the projection no reader here
      // touches.
      views.set(runId, {
        status,
        substate: extra.substate ?? null,
        runStartedAt: extra.runStartedAt ?? null,
      } as RunView);
      registry.sweepChildrenOfFoldedStop(runId);
    },
  };
  const registry = new RunRegistry({
    runView: (runId) => views.get(runId),
    commit: (drafts) =>
      Effect.sync(() => {
        events.published.push(...drafts);
      }),
    approvals: createSessionApprovals(),
    finalizeRun: (input) => finalizeRun(testDefaultSession(), input),
    acquireRunClaim: () => Effect.succeed(Effect.void),
    ...options,
  });
  return { events, phases, registry };
}

interface PublishedEvents {
  readonly published: SessionEventDraft[];
}

/** Every draft published from this call on. */
function recordSessionEvents(events: PublishedEvents): {
  readonly events: SessionEventDraft[];
} {
  const start = events.published.length;
  return {
    get events() {
      return events.published.slice(start);
    },
  };
}

/** Tracks a handle whose run a stop reaches the way production stops a run:
 * a live generation fiber on the roster, interrupted by run id. The
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

/** The `LiveToolUseFlowContext` fixture shared by the tool-use-admission tests. */
function createLiveToolUseFlowContext(
  overrides: Partial<LiveToolUseFlowContext> = {},
): LiveToolUseFlowContext {
  return {
    ownerSession: {} as SessionHandle,
    requestImmediateCompaction: vi.fn(),
    modelSwitchDisabledReason: vi.fn(() => Effect.succeed(undefined)),
    switchModel: vi.fn(() => Effect.void),
    interrupt: vi.fn(),
    ...overrides,
  };
}

/** Run a stop's native settlement at the test boundary and report whether a
 * live target took it. */
function killRegistry(
  registry: RunRegistry,
  ...args: Parameters<RunRegistry['kill']>
): boolean {
  const stop = registry.kill(...args);
  Effect.runFork(stop.settlement);
  return stop.accepted();
}
function stopRegistry(
  registry: RunRegistry,
  ...args: Parameters<RunRegistry['stopAgentRun']>
): void {
  Effect.runFork(registry.stopAgentRun(...args));
}

describe('runRegistry', () => {
  it.effect(
    'retains and detaches a parent whose child is still activating',
    () =>
      Effect.gen(function* () {
        const { registry } = createRegistry();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        const runId = generateRunId();
        const parentRunId = generateRunId();

        registry.reserveChildActivation({
          runId,
          parent: { current: parentRunId },
          retainsTerminalParent: true,
          interrupt: vi.fn(),
        });

        expect(registry.hasActiveChildren(parentRunId)).toBe(true);
        yield* registry.detachActiveChildren(parentRunId);
        expect(registry.hasActiveChildren(parentRunId)).toBe(false);

        const handle = createHandle(runId, parentRunId);
        registry.track(handle);
        expect(handle.parent).toBeNull();
        expect(handle.deliveryTarget).toBeUndefined();
      }),
  );

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
          registry.launchRun(
            runId,
            Effect.sync(() => registry.track(createHandle(runId))).pipe(
              Effect.ensuring(
                Effect.gen(function* () {
                  registry.untrack(runId);
                  yield* Deferred.succeed(untracked, undefined);
                  yield* Deferred.await(release);
                }),
              ),
            ),
          ),
        );
        yield* Deferred.await(untracked);
        registry.closeAdmissions();
        expect(registry.getActiveIds()).toEqual([]);
        expect(registry.isLive(runId)).toBe(true);
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
        yield* Fiber.join(generation);
        yield* Fiber.join(drain);
        expect(registry.isLive(runId)).toBe(false);
      }),
  );

  it('drains a background-bash RunHandle on shutdown without disturbing a resumable agent run (issue #8155)', () => {
    // A background `bash` run is registered as an RunHandle (see
    // createChildRun in tools/bash.ts) with its OS-process kill reachable
    // only via the `backgroundProcess` slot a background-process child's
    // loop sets. The two RunHandles below are tracked concurrently,
    // mirroring the real interleaving at shutdown: a background bash child
    // run alongside an ordinary resumable agent run (e.g. a native subagent
    // loop, whose own run must stay untouched so restart recovery can resume
    // it). Drain must reach only the former.
    const { phases, registry } = createRegistry();
    const bashParentRunId = generateRunId();
    const bashRunId = generateRunId();
    const agentParentRunId = generateRunId();
    const agentRunId = generateRunId();
    const bashKill = vi.fn();

    try {
      // Background bash: an RunHandle whose strategy declared a live OS
      // process (mirrors background bash's child run).
      const bashHandle = createHandle(bashRunId, bashParentRunId, {
        agentName: 'bash',
      });
      bashHandle.backgroundProcess = { kill: bashKill };
      registry.track(bashHandle);
      phases.set(bashRunId, RUN_PHASE.RUNNING);

      // Ordinary agent run: no background-process slot, so shutdown drain
      // must leave it alone for restart recovery.
      const agentHandle = createHandle(agentRunId, agentParentRunId);
      registry.track(agentHandle);
      phases.set(agentRunId, RUN_PHASE.RUNNING);

      registry.killBackgroundProcesses();

      expect(bashKill).toHaveBeenCalledOnce();
      // Neither handle is untracked: killing a background OS process
      // bypasses the generic terminate()/kill() path, so restart recovery
      // still finds both handles exactly as it would have before shutdown.
      expect(registry.getHandle(bashRunId)).toBe(bashHandle);
      expect(registry.getHandle(agentRunId)).toBe(agentHandle);
    } finally {
      registry.dispose();
    }
  });

  it.effect('interrupts the run fiber when terminating agent handles', () =>
    Effect.gen(function* () {
      const { registry } = createRegistry();
      const parentRunId = generateRunId();
      const runId = generateRunId();
      const interrupt = vi.fn();

      try {
        trackInterruptibleHandle(
          registry,
          { runId, parent: parentRunId },
          interrupt,
        );

        const stop = registry.kill(runId);
        expect(stop.accepted()).toBe(true);
        yield* stop.settlement;

        expect(interrupt).toHaveBeenCalledOnce();
      } finally {
        registry.dispose();
      }
    }),
  );

  it('reports a failed kill for a tracked handle with neither an interrupt nor a suspension', () => {
    // Guards the fallback above: a handle that never parked must still no-op,
    // or the fallback could spuriously tear down a handle mid-completion, in
    // the narrow window between its own interrupt unregister and its own
    // untrack.
    const { registry } = createRegistry();
    const parentRunId = generateRunId();
    const runId = generateRunId();

    try {
      const handle = createHandle(runId, parentRunId);
      registry.track(handle);

      expect(killRegistry(registry, runId)).toBe(false);

      expect(registry.getHandle(runId)).toBe(handle);
    } finally {
      registry.dispose();
    }
  });

  it('leaves a never-suspended handle alone even while its run reads WAITING', () => {
    // The handle owns the suspension fact; the run phase is only a
    // projection of it. A stop landing in the narrow window between a live
    // turn's interrupt-handler detach and its own untrack must not abandon a
    // run that never parked, no matter what phase the run currently shows.
    const { phases, registry } = createRegistry();
    const parentRunId = generateRunId();
    const runId = generateRunId();

    try {
      const handle = createHandle(runId, parentRunId);
      registry.track(handle);
      phases.set(runId, RUN_PHASE.WAITING);

      expect(killRegistry(registry, runId)).toBe(false);

      expect(registry.getHandle(runId)).toBe(handle);
    } finally {
      registry.dispose();
    }
  });

  it.effect('owns visible run stop policy for root and children', () =>
    Effect.gen(function* () {
      const { registry } = createRegistry();
      const rootRunId = generateRunId();
      const childRunId = generateRunId();
      const rootInterrupt = vi.fn();
      const childInterrupt = vi.fn();
      const queuedChildInterrupt = vi.fn();

      try {
        registry.reserveChildActivation({
          runId: generateRunId(),
          parent: { current: rootRunId },
          retainsTerminalParent: true,
          interrupt: queuedChildInterrupt,
        });
        trackInterruptibleHandle(
          registry,
          { runId: rootRunId },
          rootInterrupt,
          {
            agentName: 'test-root',
          },
        );
        trackInterruptibleHandle(
          registry,
          { runId: childRunId, parent: rootRunId },
          childInterrupt,
        );

        yield* registry.stopAgentRun(rootRunId);

        expect(rootInterrupt).toHaveBeenCalledOnce();
        expect(childInterrupt).toHaveBeenCalledOnce();
        expect(queuedChildInterrupt).toHaveBeenCalledOnce();
      } finally {
        registry.dispose();
      }
    }),
  );

  it.effect('interrupts grandchildren when killing a subagent chain', () =>
    Effect.gen(function* () {
      const { registry } = createRegistry();
      const rootRunId = generateRunId();
      const childRunId = generateRunId();
      const grandchildRunId = generateRunId();
      const childInterrupt = vi.fn();
      const grandchildInterrupt = vi.fn();

      try {
        trackInterruptibleHandle(
          registry,
          { runId: childRunId, parent: rootRunId },
          childInterrupt,
        );
        trackInterruptibleHandle(
          registry,
          { runId: grandchildRunId, parent: childRunId },
          grandchildInterrupt,
          { agentName: 'test-grandchild' },
        );

        const stop = registry.kill(childRunId);
        expect(stop.accepted()).toBe(true);
        yield* stop.settlement;

        expect(childInterrupt).toHaveBeenCalledOnce();
        expect(grandchildInterrupt).toHaveBeenCalledOnce();
      } finally {
        registry.dispose();
      }
    }),
  );

  it.effect('detaches descendants when killing with detached subagents', () =>
    Effect.gen(function* () {
      const { events, registry } = createRegistry();
      const recorded = recordSessionEvents(events);
      const rootRunId = generateRunId();
      const childRunId = generateRunId();
      const grandchildRunId = generateRunId();
      const childInterrupt = vi.fn();
      const grandchildInterrupt = vi.fn();

      try {
        trackInterruptibleHandle(
          registry,
          { runId: childRunId, parent: rootRunId },
          childInterrupt,
        );
        trackInterruptibleHandle(
          registry,
          { runId: grandchildRunId, parent: childRunId },
          grandchildInterrupt,
          { agentName: 'test-grandchild' },
        );

        const stop = registry.kill(childRunId, {
          detachActiveChildren: true,
        });
        // A detaching stop admits the interrupt only once its detach batch
        // has committed, so the acceptance reads after the settlement.
        yield* stop.settlement;
        expect(stop.accepted()).toBe(true);

        expect(childInterrupt).toHaveBeenCalledOnce();
        expect(grandchildInterrupt).not.toHaveBeenCalled();
        expect(registry.getHandle(grandchildRunId)?.parent).toBeNull();
        expect(eventsOfType(recorded.events, 'run.detach')).toContainEqual({
          type: 'run.detach',
          aggregateId: qualifyAggregateId('run', grandchildRunId),
        });
      } finally {
        registry.dispose();
      }
    }),
  );

  it.effect('stops a detached process child through its loop signal', () =>
    Effect.gen(function* () {
      const { registry } = createRegistry();
      const runId = generateRunId();
      const loopInterrupt = vi.fn();
      const fiberInterrupt = vi.fn();
      try {
        // A process child whose parent edge a detach already cut: its OS turn
        // is reached only through the loop's signal, and its loop fiber has
        // to survive the stop to deliver and finalize.
        registry.reserveChildActivation({
          runId,
          parent: { current: null },
          retainsTerminalParent: false,
          interrupt: loopInterrupt,
        });
        trackInterruptibleHandle(registry, { runId }, fiberInterrupt);

        const stop = registry.kill(runId);
        yield* stop.settlement;
        expect(stop.accepted()).toBe(true);
        expect(loopInterrupt).toHaveBeenCalledOnce();
        expect(fiberInterrupt).not.toHaveBeenCalled();
      } finally {
        registry.dispose();
      }
    }),
  );

  it.effect(
    'detaches children when stopping a run with detached subagents',
    () =>
      Effect.gen(function* () {
        const { events, registry } = createRegistry();
        const recorded = recordSessionEvents(events);
        const rootRunId = generateRunId();
        const childRunId = generateRunId();
        const grandchildRunId = generateRunId();
        const rootInterrupt = vi.fn();
        const childInterrupt = vi.fn();
        const grandchildInterrupt = vi.fn();

        try {
          trackInterruptibleHandle(
            registry,
            { runId: rootRunId },
            rootInterrupt,
            {
              agentName: 'test-root',
            },
          );
          trackInterruptibleHandle(
            registry,
            { runId: childRunId, parent: rootRunId },
            childInterrupt,
          );
          trackInterruptibleHandle(
            registry,
            { runId: grandchildRunId, parent: childRunId },
            grandchildInterrupt,
            { agentName: 'test-grandchild' },
          );

          yield* registry.stopAgentRun(rootRunId, {
            detachActiveChildren: true,
          });

          expect(rootInterrupt).toHaveBeenCalledOnce();
          expect(childInterrupt).not.toHaveBeenCalled();
          expect(grandchildInterrupt).not.toHaveBeenCalled();
          expect(registry.hasActiveChildren(rootRunId)).toBe(false);
          expect(registry.getHandle(childRunId)?.parent).toBeNull();
          expect(registry.getHandle(grandchildRunId)?.parent).toBe(childRunId);
          expect(registry.hasActiveChildren(childRunId)).toBe(true);
          expect(eventsOfType(recorded.events, 'run.detach')).toContainEqual({
            type: 'run.detach',
            aggregateId: qualifyAggregateId('run', childRunId),
          });
        } finally {
          registry.dispose();
        }
      }),
  );

  it.effect('fails the stop when the detach batch is refused', () =>
    Effect.gen(function* () {
      const { registry } = createRegistry({
        commit: () => Effect.fail(new Error('detach batch refused')),
      });
      const rootRunId = generateRunId();
      const childRunId = generateRunId();

      try {
        trackInterruptibleHandle(registry, { runId: rootRunId }, vi.fn(), {
          agentName: 'test-root',
        });
        trackInterruptibleHandle(
          registry,
          { runId: childRunId, parent: rootRunId },
          vi.fn(),
        );

        const error = yield* Effect.flip(
          registry.stopAgentRun(rootRunId, { detachActiveChildren: true }),
        );
        expect(error.message).toBe('detach batch refused');
        expect(registry.getHandle(childRunId)?.isOwnedBy(rootRunId)).toBe(true);
      } finally {
        registry.dispose();
      }
    }),
  );

  it.effect(
    'interrupts the parent only once the detach has committed and severed',
    () =>
      Effect.gen(function* () {
        const commitStarted = yield* Deferred.make<void>();
        const allowCommit = yield* Deferred.make<void>();
        const { registry } = createRegistry({
          commit: () =>
            Deferred.succeed(commitStarted, undefined).pipe(
              Effect.andThen(Deferred.await(allowCommit)),
            ),
        });
        const rootRunId = generateRunId();
        const childRunId = generateRunId();
        const rootInterrupt = vi.fn();

        try {
          trackInterruptibleHandle(
            registry,
            { runId: rootRunId },
            rootInterrupt,
            { agentName: 'test-root' },
          );
          trackInterruptibleHandle(
            registry,
            { runId: childRunId, parent: rootRunId },
            vi.fn(),
          );

          const stopped = yield* Effect.forkChild(
            registry.stopAgentRun(rootRunId, { detachActiveChildren: true }),
          );
          yield* Deferred.await(commitStarted);
          expect(rootInterrupt).not.toHaveBeenCalled();

          yield* Deferred.succeed(allowCommit, undefined);
          yield* Fiber.join(stopped);

          expect(registry.getHandle(childRunId)?.parent).toBeNull();
          expect(rootInterrupt).toHaveBeenCalledOnce();
        } finally {
          registry.dispose();
        }
      }),
  );

  it.effect('refuses a child launched while the parent is stopping', () =>
    Effect.gen(function* () {
      const commitStarted = yield* Deferred.make<void>();
      const allowCommit = yield* Deferred.make<void>();
      const { registry } = createRegistry({
        commit: () =>
          Deferred.succeed(commitStarted, undefined).pipe(
            Effect.andThen(Deferred.await(allowCommit)),
          ),
      });
      const rootRunId = generateRunId();
      const childRunId = generateRunId();
      const lateChildRunId = generateRunId();

      try {
        trackInterruptibleHandle(registry, { runId: rootRunId }, vi.fn(), {
          agentName: 'test-root',
        });
        trackInterruptibleHandle(
          registry,
          { runId: childRunId, parent: rootRunId },
          vi.fn(),
        );

        const stopped = yield* Effect.forkChild(
          registry.stopAgentRun(rootRunId, { detachActiveChildren: true }),
        );
        yield* Deferred.await(commitStarted);

        expect(() =>
          registry.track(createHandle(lateChildRunId, rootRunId)),
        ).toThrow(/while that run is stopping/);
        expect(() =>
          registry.reserveChildActivation({
            retainsTerminalParent: true,
            runId: lateChildRunId,
            parent: { current: rootRunId },
            interrupt: vi.fn(),
          }),
        ).toThrow(/while that run is stopping/);

        yield* Deferred.succeed(allowCommit, undefined);
        yield* Fiber.join(stopped);

        expect(registry.getHandle(lateChildRunId)).toBeUndefined();
        expect(registry.hasActiveChildren(rootRunId)).toBe(false);
      } finally {
        registry.dispose();
      }
    }),
  );

  it.effect(
    'sweeps a child registered between the stop settlement and its fold, and refuses admission from the fold on (issue #12442)',
    () =>
      Effect.gen(function* () {
        const { phases, registry } = createRegistry();
        const rootRunId = generateRunId();
        const childRunId = generateRunId();
        const lateChildRunId = generateRunId();
        const postFoldChildRunId = generateRunId();
        const childInterrupt = vi.fn();
        const lateChildInterrupt = vi.fn();

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

          // The detaching stop settles completely — its children severed, its
          // in-flight token lifted — while the parent's `run.end` has not
          // folded yet. The window the token closed is open again, and the
          // child whose lineage read preceded the stop registers inside it.
          yield* registry.stopAgentRun(rootRunId, {
            detachActiveChildren: true,
          });
          expect(registry.getHandle(childRunId)?.parent).toBeNull();
          trackInterruptibleHandle(
            registry,
            { runId: lateChildRunId, parent: rootRunId },
            lateChildInterrupt,
          );
          expect(lateChildInterrupt).not.toHaveBeenCalled();

          // The parent's terminal fold closes the window: the child that
          // slipped in is stopped by the parent's own terminal fact, through
          // the same cascade the stop ran, while the detached child's sever
          // is preserved exactly.
          phases.set(rootRunId, RUN_PHASE.CANCELLED);
          expect(lateChildInterrupt).toHaveBeenCalledOnce();
          expect(childInterrupt).not.toHaveBeenCalled();
          expect(registry.getHandle(childRunId)?.parent).toBeNull();

          // From the fold on, admission itself refuses the stopped parent.
          expect(() =>
            registry.track(createHandle(postFoldChildRunId, rootRunId)),
          ).toThrow(/stop has already folded/);
          expect(() =>
            registry.reserveChildActivation({
              retainsTerminalParent: true,
              runId: postFoldChildRunId,
              parent: { current: rootRunId },
              interrupt: vi.fn(),
            }),
          ).toThrow(/stop has already folded/);
          expect(registry.getHandle(postFoldChildRunId)).toBeUndefined();
        } finally {
          registry.dispose();
        }
      }),
  );

  it.effect(
    'stops one child while preserving its owner, sibling, and agent descendants',
    () =>
      Effect.gen(function* () {
        const { registry } = createRegistry();
        const rootRunId = generateRunId();
        const childRunId = generateRunId();
        const siblingRunId = generateRunId();
        const descendantRunId = generateRunId();
        const rootInterrupt = vi.fn();
        const childInterrupt = vi.fn();
        const siblingInterrupt = vi.fn();
        const descendantInterrupt = vi.fn();

        try {
          const rootHandle = trackInterruptibleHandle(
            registry,
            { runId: rootRunId },
            rootInterrupt,
            { agentName: 'test-root' },
          );
          trackInterruptibleHandle(
            registry,
            { runId: childRunId, parent: rootRunId },
            childInterrupt,
          );
          const siblingHandle = trackInterruptibleHandle(
            registry,
            { runId: siblingRunId, parent: rootRunId },
            siblingInterrupt,
          );
          trackInterruptibleHandle(
            registry,
            { runId: descendantRunId, parent: childRunId },
            descendantInterrupt,
          );

          yield* registry.stopAgentRun(childRunId, {
            detachActiveChildren: true,
          });

          expect(childInterrupt).toHaveBeenCalledOnce();
          expect(rootInterrupt).not.toHaveBeenCalled();
          expect(siblingInterrupt).not.toHaveBeenCalled();
          expect(descendantInterrupt).not.toHaveBeenCalled();
          expect(registry.getHandle(rootRunId)).toBe(rootHandle);
          expect(registry.getHandle(siblingRunId)).toBe(siblingHandle);
          expect(registry.getHandle(descendantRunId)?.parent).toBeNull();
        } finally {
          registry.dispose();
        }
      }),
  );

  it.effect(
    'stops a child driver before it has a handle and leaves finalization to it',
    () =>
      Effect.gen(function* () {
        storageMocks.finalizeRun.mockClear();
        const { registry } = createRegistry();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        const interrupt = vi.fn();
        const runId = generateRunId();
        registry.reserveChildActivation({
          retainsTerminalParent: true,
          runId,
          parent: { current: generateRunId() },
          interrupt,
        });

        yield* registry.stopAgentRun(runId);

        expect(interrupt).toHaveBeenCalledOnce();
        expect(storageMocks.finalizeRun).not.toHaveBeenCalled();
        expect(registry.getActiveIds()).toContain(runId);
      }),
  );

  it.effect('cancels an ownerless run', () =>
    Effect.gen(function* () {
      storageMocks.finalizeRun.mockClear();
      const { registry } = createRegistry();
      const runId = generateRunId();

      try {
        // The start row is what lets the stop's typed failure be yielded here:
        // `finalizeOwnerlessStop` fails for a run that has none, and today the
        // registry's own runFork drops that failure.
        publishTestRunStart(testDefaultSession(), runId);
        yield* testDefaultSession().settlePublications();
        yield* registry.stopAgentRun(runId);

        // `run.end` is the run's whole terminal fact (one run model, 3.3), so
        // a stop that reached no live handle still writes it.
        expect(storageMocks.finalizeRun).toHaveBeenCalledWith(
          testDefaultSession(),
          expect.objectContaining({
            runId,
            outcome: RUN_OUTCOME.CANCELLED,
          }),
        );
      } finally {
        registry.dispose();
      }
    }),
  );

  it('reports agent status from its run-status owner', () => {
    const { phases, registry } = createRegistry();
    const parentRunId = generateRunId();
    const runId = generateRunId();

    try {
      phases.set(runId, RUN_PHASE.WAITING);
      const handle = createHandle(runId, parentRunId);
      registry.track(handle);

      expect(registry.getStatus(handle).status).toBe(RUN_PHASE.WAITING);
    } finally {
      registry.dispose();
    }
  });

  it('reports active elapsed from runStartedAt without a handle fallback', () => {
    vi.useFakeTimers({ now: 1_000 });
    const { phases, registry } = createRegistry();
    const parentRunId = generateRunId();
    const runId = generateRunId();
    const handle = createHandle(runId, parentRunId);

    try {
      registry.track(handle);
      vi.setSystemTime(10_000);
      phases.set(runId, RUN_PHASE.RUNNING, {
        runStartedAt: 6_000,
      });

      expect(registry.getStatus(handle)).toEqual({
        status: RUN_PHASE.RUNNING,
        elapsed: '4s',
      });
      phases.set(runId, RUN_PHASE.RUNNING);
      expect(registry.getStatus(handle).elapsed).toBeNull();
    } finally {
      vi.useRealTimers();
      registry.dispose();
    }
  });

  it('detaches children of an ownerless run and cancels it', () => {
    const { events, registry } = createRegistry();
    const recorded = recordSessionEvents(events);
    const parentRunId = generateRunId();
    const childRunId = generateRunId();
    const childInterrupt = vi.fn();

    try {
      // No root handle owns `parentRunId` — only a tracked child does.
      trackInterruptibleHandle(
        registry,
        { runId: childRunId, parent: parentRunId },
        childInterrupt,
      );

      stopRegistry(registry, parentRunId, {
        detachActiveChildren: true,
      });

      expect(childInterrupt).not.toHaveBeenCalled();
      expect(registry.getHandle(childRunId)?.parent).toBeNull();
      expect(eventsOfType(recorded.events, 'run.detach')).toContainEqual({
        type: 'run.detach',
        aggregateId: qualifyAggregateId('run', childRunId),
      });
    } finally {
      registry.dispose();
    }
  });

  it('registers a child without publishing its parent edge', () => {
    const { events, registry } = createRegistry();
    const recorded = recordSessionEvents(events);
    const parentRunId = generateRunId();
    const runId = generateRunId();

    try {
      const handle = createHandle(runId, parentRunId);

      registry.track(handle);
      expect(registry.hasActiveChildren(parentRunId)).toBe(true);
      registry.untrack(runId);

      // The parent edge is a `run.start` fact, so tracking publishes none.
      expect(recorded.events).toEqual([]);
      expect(registry.hasActiveChildren(parentRunId)).toBe(false);
    } finally {
      registry.dispose();
    }
  });

  it('clears live tool-use context while the handle remains tracked', () => {
    const { registry } = createRegistry();
    const runId = generateRunId();
    const context = createLiveToolUseFlowContext();

    try {
      const handle = createHandle(runId, null, {
        agentName: 'test-tool-use',
      });

      handle.attachToolUseFlow(context);
      registry.track(handle);

      expect(registry.getToolUseFlowContext(runId)).toBe(context);

      handle.detachToolUseFlow(context);

      expect(registry.getToolUseFlowContext(runId)).toBeUndefined();
      expect(registry.getHandle(runId)).toBe(handle);
    } finally {
      registry.dispose();
    }
  });

  it('owns manual compaction admission for active tool-use flows', () => {
    const { registry } = createRegistry();
    const runId = generateRunId();
    const requestImmediateCompaction = vi.fn();
    const ownerSession = {} as SessionHandle;
    const context = createLiveToolUseFlowContext({
      ownerSession,
      requestImmediateCompaction,
    });

    try {
      expect(registry.requestManualCompaction(undefined)).toEqual({
        kind: 'no_active_tool_use',
      });
      expect(registry.requestManualCompaction(runId)).toEqual({
        kind: 'no_active_tool_use',
        runId,
      });

      const handle = createHandle(runId, null, {
        agentName: 'test-tool-use',
      });
      handle.attachToolUseFlow(context);
      registry.track(handle);

      expect(registry.requestManualCompaction(runId)).toEqual({
        kind: 'requested',
        runId,
        session: ownerSession,
      });
      expect(requestImmediateCompaction).toHaveBeenCalledOnce();
    } finally {
      registry.dispose();
    }
  });

  it('owns tool-use follow-up admission from status, context, and children', () => {
    const { phases, registry } = createRegistry();
    const activeRunId = generateRunId();
    const resumingRunId = generateRunId();
    const waitingRunId = generateRunId();
    const stoppedRunId = generateRunId();
    const context = createLiveToolUseFlowContext();

    try {
      const activeHandle = createHandle(activeRunId, null, {
        agentName: 'test-tool-use',
      });
      activeHandle.attachToolUseFlow(context);
      registry.track(activeHandle);
      phases.set(activeRunId, RUN_PHASE.RUNNING);

      expect(registry.getToolUseFollowUpTarget(activeRunId)).toEqual({
        kind: 'active',
        context,
      });

      phases.set(resumingRunId, RUN_PHASE.RUNNING, {
        substate: RUN_SUBSTATE.RESUMING,
      });
      expect(registry.getToolUseFollowUpTarget(resumingRunId)).toEqual({
        kind: 'queue',
      });

      phases.set(waitingRunId, RUN_PHASE.WAITING);
      expect(registry.getToolUseFollowUpTarget(waitingRunId)).toEqual({
        kind: 'queue',
      });

      phases.set(stoppedRunId, RUN_PHASE.CANCELLED);
      expect(registry.getToolUseFollowUpTarget(stoppedRunId)).toEqual({
        kind: 'no_session',
        runStatus: RUN_PHASE.CANCELLED,
      });
    } finally {
      registry.dispose();
    }
  });

  it.effect('projects detach updates from session events', () =>
    Effect.gen(function* () {
      const { events, registry } = createRegistry();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const recorded = recordSessionEvents(events);
      const parentRunId = generateRunId();
      const runId = generateRunId();

      const handle = createHandle(runId, parentRunId);

      registry.track(handle);
      expect(handle.deliveryTarget).toBe(parentRunId);
      const sinceTrack = recordSessionEvents(events);
      yield* registry.detachActiveChildren(parentRunId);
      expect(handle.deliveryTarget).toBeUndefined();

      expect(sinceTrack.events.map((event) => event.type)).toEqual([
        'run.detach',
      ]);

      expect(eventsOfType(recorded.events, 'run.detach')).toContainEqual({
        type: 'run.detach',
        aggregateId: qualifyAggregateId('run', runId),
      });
      expect(registry.hasActiveChildren(parentRunId)).toBe(false);
    }),
  );

  it.effect('keeps a handle replacing a detached registration a root run', () =>
    Effect.gen(function* () {
      const { registry } = createRegistry();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const parentRunId = generateRunId();
      const runId = generateRunId();

      // The provisional registration a launch makes before it prepares, and
      // the parent's detaching stop landing while that preparation runs.
      const provisional = createHandle(runId, parentRunId);
      registry.track(provisional);
      yield* registry.detachActiveChildren(parentRunId);

      // The lifecycle's handle, built from the edge the launch started with.
      const lifecycle = createHandle(runId, parentRunId);
      registry.track(lifecycle);

      expect(lifecycle.deliveryTarget).toBeUndefined();
      expect(registry.hasActiveChildren(parentRunId)).toBe(false);
    }),
  );

  it.effect('preserves child approvals when detaching it from its parent', () =>
    Effect.gen(function* () {
      const approvals = createSessionApprovals();
      const { registry } = createRegistry({ approvals });
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const parentRunId = generateRunId();
      const childRunId = generateRunId();
      const handle = createHandle(childRunId, parentRunId);

      approvals.toolEdit.bypass.setBypass(parentRunId, true);
      approvals.registerRunParent(childRunId, parentRunId);
      registry.track(handle);

      yield* registry.detachActiveChildren(parentRunId);
      approvals.toolEdit.bypass.setBypass(parentRunId, false);

      expect(approvals.toolEdit.bypass.isBypassed(childRunId)).toBe(true);
      expect(handle.deliveryTarget).toBeUndefined();
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
        registry.launchRun(
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
      registry.untrack(runId);

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
        registry.launchRun(runId, Effect.promise(launch)),
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

it.effect('holds a run against launches without making it a stop target', () =>
  Effect.gen(function* () {
    const claimed = yield* Deferred.make<void>();
    const released = vi.fn();
    const roster = new RunRoster(createSessionApprovals(), () =>
      Deferred.await(claimed).pipe(Effect.as(Effect.sync(released))),
    );
    const runId = 'abcd13' as RunId;
    const hold = yield* Effect.forkChild(
      Effect.scoped(
        Effect.gen(function* () {
          yield* roster.holdInactive(runId);
          yield* Effect.never;
        }),
      ),
      { startImmediately: true },
    );
    // The hold is registered before its claim lands: a launch while the
    // claim is still in flight is refused, not started beside it.
    expect(roster.isLive(runId)).toBe(true);
    expect(
      yield* Effect.flip(roster.launch(runId, Effect.void)),
    ).toBeInstanceOf(RunLive);
    // A run only held is not running: a stop by run id reaches nothing.
    expect(roster.interrupt(runId)).toBe(false);
    yield* Deferred.succeed(claimed, undefined);
    yield* Fiber.interrupt(hold);
    expect(released).toHaveBeenCalledOnce();
    expect(roster.isLive(runId)).toBe(false);
  }),
);
