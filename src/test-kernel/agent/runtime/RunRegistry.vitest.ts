// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';
import { describe, expect, vi } from 'vitest';

// Local imports
import { getRunRecords } from '@agent/storage';
import type { AgentTrace } from '@agent/trace';
import { finalizeRun } from '@agent/storage/runLifecycle';
import type {
  RunHandle,
  LiveToolUseFlowContext,
} from '@agent/runtime/RunHandle';
import { finalizeRunTerminal } from '@agent/runtime/AgentRunLifecycle';
import { RunRegistry, Runs } from '@agent/runtime/runRegistry';
import { RunLive } from '@agent/runtime/runRoster';
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
  testParkedFibers,
  testRunHandle,
} from '@test/support/runHandleFixtures';
import { setupPlatform } from '@test/support/setupPlatform';
import { generateRunId } from '@utils/core';
import { ensureError } from '@utils/errors/errorMessage';

// Local file imports
import { eventsOfType } from '../progressTestUtils';

const storageMocks = vi.hoisted(() => ({
  finalizeRun: vi.fn(),
}));

const channelTraceMocks = vi.hoisted(() => ({
  warn: vi.fn(),
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

vi.mock('@agent/trace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/trace')>();
  return {
    ...actual,
    createChannelTrace: vi.fn(() => ({
      ...actual.noopTrace,
      warn: channelTraceMocks.warn,
    })),
  };
});

setupPlatform({ workspacePath: '/workspace' });

/** What a tool-use run that produced no output ends with on its `run.end`. */
const EMPTY_TOOL_USE_OUTPUT = {
  category: 'toolUse',
  response: '',
  files: [],
} as const;

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
 * being told that a phase moved, which {@link FoldedPhases.set} does the way
 * the session's tail does.
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
  // `handleStatus` the way the session's committed tail does.
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
      registry.handleStatus(runId);
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
    parked: testParkedFibers(),
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

/** Tracks a handle with a live interrupt handler attached. */
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
  handle.attachInterruptHandler({ interrupt });
  registry.track(handle);
  return handle;
}

/** The `LiveToolUseFlowContext` fixture shared by the tool-use-admission tests. */
function createLiveToolUseFlowContext(
  overrides: Partial<LiveToolUseFlowContext> = {},
): LiveToolUseFlowContext {
  return {
    ownerSession: {} as SessionHandle,
    requestImmediateCompaction: vi.fn(),
    modelSwitchDisabledReason: vi.fn(),
    switchModel: vi.fn(),
    interrupt: vi.fn(),
    ...overrides,
  };
}

/** Tracks a handle genuinely suspended at WAITING, the state every waiting-kill test starts from. */
function trackSuspendedWaitingHandle(
  registry: RunRegistry,
  phases: FoldedPhases,
  options: {
    runId: RunId;
    parent?: RunId | null;
    cleanup?: () => void | Promise<void>;
    /** The parked teardown itself; when given it wins and `cleanup` is ignored. */
    teardown?: Effect.Effect<void, Error>;
    overrides?: HandleOverrides;
  },
): RunHandle {
  const handle = createHandle(
    options.runId,
    options.parent ?? null,
    options.overrides,
  );
  registry.track(handle);
  parkWaitingHandle(
    registry,
    handle,
    options.teardown ??
      Effect.tryPromise({
        try: async () => {
          await options.cleanup?.();
        },
        catch: ensureError,
      }),
  );
  phases.set(options.runId, RUN_PHASE.WAITING);
  return handle;
}

/**
 * Park a tracked handle the way `runFlowWithLifecycle`'s WAITING branch does:
 * the stage close this run still owes (`teardown` here, guarded so an
 * independent durable fact cannot cost the row), the guard that leaves a
 * resumed successor alone, then the ordinary terminal path — all on the fiber
 * the stop wakes. The cascade itself is the lifecycle's and is covered there;
 * what these tests read off it is the registry's half of the park.
 */
function parkWaitingHandle(
  registry: RunRegistry,
  handle: RunHandle,
  teardown: Effect.Effect<void, Error>,
): void {
  Effect.runSync(
    registry.park(
      handle,
      Deferred.makeUnsafe<void>(),
      Effect.gen(function* () {
        yield* teardown.pipe(Effect.catch(() => Effect.void));
        if (registry.getHandle(handle.runId) !== handle) return;
        yield* finalizeRunTerminal({
          session: testDefaultSession(),
          handle,
          outcome: RUN_OUTCOME.CANCELLED,
        });
      }).pipe(
        Effect.catchCause(() =>
          Effect.sync(() => {
            registry.untrackIfCurrent(handle);
          }),
        ),
        Effect.provideService(Runs, registry),
      ),
    ),
  );
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
  it('retains and detaches a parent whose child is still activating', () => {
    const { registry } = createRegistry();
    const runId = generateRunId();
    const parentRunId = generateRunId();
    let detached = false;

    try {
      registry.reserveChildActivation({
        runId,
        parentRunId,
        interrupt: vi.fn(),
        detach: () => {
          detached = true;
        },
        isDetached: () => detached,
      });

      expect(registry.hasActiveChildren(parentRunId)).toBe(true);
      Effect.runSync(registry.detachActiveChildren(parentRunId));
      expect(registry.hasActiveChildren(parentRunId)).toBe(false);

      const handle = createHandle(runId, parentRunId);
      registry.track(handle);
      expect(handle.parent).toBeNull();
      expect(handle.deliveryTarget).toBeUndefined();
    } finally {
      registry.dispose();
    }
  });

  // The drain's re-check arm, which is the whole of `awaitDrained` that a
  // bare wait loop lacks: `waitForAnyChange` registers its listeners a step
  // after the active set was read, so a run that leaves inside that window
  // wakes nobody. A session close would block until its budget; the desktop
  // project close, which has no budget, hung forever.
  it.effect(
    'drains when the last run leaves inside the listener-registration window',
    () =>
      Effect.gen(function* () {
        const { registry } = createRegistry();
        const runId = generateRunId();
        registry.track(createHandle(runId));
        const register = registry.waitForAnyChange.bind(registry);
        vi.spyOn(registry, 'waitForAnyChange').mockImplementation((ids) => {
          // The departure lands after the active read and before the listener
          // that would have reported it.
          registry.untrack(runId);
          return register(ids);
        });
        try {
          yield* registry.awaitDrained();
          expect(registry.getActiveIds()).toEqual([]);
        } finally {
          registry.dispose();
        }
      }),
    { timeout: 2000 },
  );

  it('drains a background-bash RunHandle on shutdown without disturbing a resumable agent run (issue #8155)', () => {
    // A background `bash` run is registered as an RunHandle (see
    // createChildRun in tools/bash.ts) with its OS-process kill reachable
    // only via the interrupt handler a background-process child attaches. The two
    // RunHandles below are tracked concurrently, mirroring the real
    // interleaving at shutdown: a background bash child run alongside an
    // ordinary resumable agent run (e.g. a native subagent loop, whose
    // own loop-level interrupt handler must stay untouched so restart recovery
    // can resume it). Drain must reach only the former.
    const { phases, registry } = createRegistry();
    const bashParentRunId = generateRunId();
    const bashRunId = generateRunId();
    const agentParentRunId = generateRunId();
    const agentRunId = generateRunId();
    const bashInterrupt = vi.fn();
    const agentInterrupt = vi.fn();

    try {
      // Background bash: an RunHandle whose attached interrupt
      // handler owns a live OS process (mirrors background bash's child run).
      const bashHandle = createHandle(bashRunId, bashParentRunId, {
        agentName: 'bash',
      });
      bashHandle.attachInterruptHandler({
        interrupt: bashInterrupt,
        ownsBackgroundProcess: true,
      });
      registry.track(bashHandle);
      phases.set(bashRunId, RUN_PHASE.RUNNING);

      // Ordinary agent run (e.g. a native-subagent loop's own
      // loop-level interrupt handler): no ownsBackgroundProcess flag, so
      // shutdown drain must leave it alone for restart recovery.
      const agentHandle = createHandle(agentRunId, agentParentRunId);
      agentHandle.attachInterruptHandler({ interrupt: agentInterrupt });
      registry.track(agentHandle);
      phases.set(agentRunId, RUN_PHASE.RUNNING);

      registry.killBackgroundProcesses();

      expect(bashInterrupt).toHaveBeenCalledOnce();
      expect(agentInterrupt).not.toHaveBeenCalled();
      // Neither handle is untracked: killing a background OS process
      // bypasses the generic terminate()/kill() path, so restart recovery
      // still finds both handles exactly as it would have before shutdown.
      expect(registry.getHandle(bashRunId)).toBe(bashHandle);
      expect(registry.getHandle(agentRunId)).toBe(agentHandle);
    } finally {
      registry.dispose();
    }
  });

  it('uses the handle interrupt target when terminating agent handles', () => {
    const { phases, registry } = createRegistry();
    const parentRunId = generateRunId();
    const runId = generateRunId();
    const interrupt = vi.fn();

    try {
      trackInterruptibleHandle(
        registry,
        { runId, parent: parentRunId },
        interrupt,
      );

      expect(killRegistry(registry, runId)).toBe(true);

      expect(interrupt).toHaveBeenCalledOnce();
    } finally {
      registry.dispose();
    }
  });

  it.effect(
    'falls back to the parked teardown when a suspended handle has no live interrupt (issue #7287)',
    () =>
      Effect.gen(function* () {
        // A native subagent suspended at WAITING has already had its live
        // interrupt context detached (runToolUseFlow's finally), while the handle
        // stays tracked for resume. With no interrupt target left, terminate()
        // must fall back to the parked teardown rather than no-op and strand the
        // handle registered forever.
        const { phases, registry } = createRegistry();
        const parentRunId = generateRunId();
        const runId = generateRunId();
        const cleanup = vi.fn();

        try {
          // No handle interrupt target: mirrors a suspended subagent whose live
          // tool-use session has already been disposed. The run phase follows
          // the same suspension, as it does in production.
          trackSuspendedWaitingHandle(registry, phases, {
            runId,
            parent: parentRunId,
            cleanup,
          });

          const stop = registry.kill(runId);
          expect(stop.accepted()).toBe(true);
          yield* stop.settlement;

          expect(cleanup).toHaveBeenCalledOnce();
          expect(registry.getHandle(runId)).toBeUndefined();
        } finally {
          registry.dispose();
        }
      }),
  );

  it.effect(
    'writes the cancelled `run.end` row when killing a suspended WAITING handle',
    () =>
      Effect.gen(function* () {
        // terminateWaitingHandle bypasses runFlowWithLifecycle (the flow never
        // resumes), so it writes the terminal row itself — otherwise session
        // subscribers silently miss a user-initiated stop of a suspended native
        // subagent. The turn's own trace is already torn down by the time a kill
        // runs, so the row, not an emit, is what reaches them.
        storageMocks.finalizeRun.mockClear();
        const { phases, registry } = createRegistry();
        const parentRunId = generateRunId();
        const runId = generateRunId();

        try {
          trackSuspendedWaitingHandle(registry, phases, {
            runId,
            parent: parentRunId,
          });

          const stop = registry.kill(runId);
          expect(stop.accepted()).toBe(true);
          yield* stop.settlement;

          expect(storageMocks.finalizeRun).toHaveBeenCalledExactlyOnceWith(
            testDefaultSession(),
            {
              runId,
              outcome: RUN_OUTCOME.CANCELLED,
              output: EMPTY_TOOL_USE_OUTPUT,
            },
          );
        } finally {
          registry.dispose();
        }
      }),
  );

  it.effect(
    'publishes a waiting cancellation after its transcript cleanup settles',
    () =>
      Effect.gen(function* () {
        const order: string[] = [];
        storageMocks.finalizeRun.mockClear();
        storageMocks.finalizeRun.mockImplementationOnce(() => {
          order.push('finalize');
          return Effect.succeed({ ok: true, outcomePersisted: true });
        });
        const { phases, registry } = createRegistry();
        const runId = generateRunId();
        const cleanupEntered = yield* Deferred.make<void>();
        const cleanupGate = yield* Deferred.make<void>();

        try {
          const handle = trackSuspendedWaitingHandle(registry, phases, {
            runId,
            parent: generateRunId(),
            teardown: Deferred.succeed(cleanupEntered, undefined).pipe(
              Effect.andThen(Deferred.await(cleanupGate)),
              Effect.andThen(
                Effect.sync(() => {
                  order.push('cleanup');
                }),
              ),
            ),
          });

          const stop = registry.kill(runId);
          expect(stop.accepted()).toBe(true);
          const settled = yield* Effect.forkChild(stop.settlement);
          // Awaiting the gate the teardown itself opens proves the settlement is
          // parked inside cleanup, so both assertions below are facts.
          yield* Deferred.await(cleanupEntered);
          expect(storageMocks.finalizeRun).not.toHaveBeenCalled();
          expect(registry.getHandle(runId)).toBe(handle);

          yield* Deferred.succeed(cleanupGate, undefined);
          yield* Fiber.join(settled);
          expect(order).toEqual(['cleanup', 'finalize']);
          expect(registry.getHandle(runId)).toBeUndefined();
        } finally {
          registry.dispose();
        }
      }),
  );

  it.effect('hands a waiting stop to a successor tracked during cleanup', () =>
    Effect.gen(function* () {
      storageMocks.finalizeRun.mockClear();
      const { phases, registry } = createRegistry();
      const parentRunId = generateRunId();
      const runId = generateRunId();
      const cleanupEntered = yield* Deferred.make<void>();
      const cleanupGate = yield* Deferred.make<void>();

      try {
        trackSuspendedWaitingHandle(registry, phases, {
          runId,
          parent: parentRunId,
          teardown: Deferred.succeed(cleanupEntered, undefined).pipe(
            Effect.andThen(Deferred.await(cleanupGate)),
          ),
        });

        const stop = registry.kill(runId);
        expect(stop.accepted()).toBe(true);
        const settled = yield* Effect.forkChild(stop.settlement);
        // The successor is tracked while the teardown is still running, which
        // the gate the teardown opens makes a fact rather than a hope.
        yield* Deferred.await(cleanupEntered);

        const successorInterrupt = vi.fn();
        const successor = trackInterruptibleHandle(
          registry,
          { runId, parent: parentRunId },
          successorInterrupt,
        );

        expect(successorInterrupt).toHaveBeenCalledOnce();
        yield* Deferred.succeed(cleanupGate, undefined);
        yield* Fiber.join(settled);

        expect(registry.getHandle(runId)).toBe(successor);
        expect(storageMocks.finalizeRun).not.toHaveBeenCalled();
      } finally {
        registry.dispose();
      }
    }),
  );

  it.effect(
    'settles waiting termination when the terminal row write throws',
    () =>
      Effect.gen(function* () {
        storageMocks.finalizeRun.mockImplementationOnce(() => {
          throw new Error('terminal row write failed');
        });
        const { phases, registry } = createRegistry();
        const runId = generateRunId();

        try {
          trackSuspendedWaitingHandle(registry, phases, {
            runId,
            parent: generateRunId(),
          });

          const stop = registry.kill(runId);
          expect(stop.accepted()).toBe(true);
          yield* stop.settlement;
          expect(registry.getHandle(runId)).toBeUndefined();
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
    const { phases, registry } = createRegistry();
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

  it.effect(
    'keeps one terminal publisher when a stop wakes a claimed parked run',
    () =>
      Effect.gen(function* () {
        // The stop still reaches the parked fiber and runs its termination —
        // the registry holds no terminal claim of its own. The claim inside
        // `finalizeRunTerminal` is what keeps the publication to one: a kill
        // landing while an earlier finalizer is parked at its persist await
        // cannot publish a second `result` or persist a second terminal
        // status over that finalizer's outcome.
        const { phases, registry } = createRegistry();
        const parentRunId = generateRunId();
        const runId = generateRunId();
        const teardown = vi.fn();
        storageMocks.finalizeRun.mockClear();
        const parked = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        storageMocks.finalizeRun.mockImplementationOnce(() =>
          Deferred.succeed(parked, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as({ ok: true, outcome: RUN_OUTCOME.COMPLETED }),
          ),
        );

        try {
          const handle = trackSuspendedWaitingHandle(registry, phases, {
            runId,
            parent: parentRunId,
            cleanup: teardown,
          });

          const session = {
            settlePublications: () => Effect.void,
          } as unknown as SessionHandle;
          const finalized = yield* Effect.forkChild(
            finalizeRunTerminal({
              session,
              handle,
              outcome: RUN_OUTCOME.COMPLETED,
            }).pipe(Effect.provideService(Runs, registry)),
          );
          // The finalizer claims the run before it reaches its persist, so a
          // settlement parked at the persist proves the claim already landed.
          yield* Deferred.await(parked);
          expect(storageMocks.finalizeRun).toHaveBeenCalledOnce();

          const stop = registry.kill(runId);
          expect(stop.accepted()).toBe(true);
          yield* stop.settlement;

          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(finalized);
          // The park's own termination ran to its terminal step and stopped
          // there: the claim was gone, so no second row was written.
          expect(teardown).toHaveBeenCalledOnce();
          expect(storageMocks.finalizeRun).toHaveBeenCalledExactlyOnceWith(
            session,
            expect.objectContaining({
              runId,
              outcome: RUN_OUTCOME.COMPLETED,
            }),
          );
          expect(registry.getHandle(runId)).toBeUndefined();
        } finally {
          registry.dispose();
        }
      }),
  );

  it.effect(
    'tears down and aligns a suspended handle killed during RESUMING',
    () =>
      Effect.gen(function* () {
        // Regression: `resumeQueuedToolUseFromResumeData` flips `runStatus` to
        // RUNNING with a RESUMING substate *before* the resumed run installs its
        // own interrupt context. The handle it is resuming is still parked from
        // the earlier genuine WAITING suspension, so a kill landing in that window
        // tears it down off that fact alone — no phase or substate is consulted.
        const { phases, registry } = createRegistry();
        const runId = 'eec-abcdef' as RunId;
        const parentRunId = generateRunId();
        const cleanup = vi.fn();
        const store = getRunRecords(testDefaultSession(), runId);

        try {
          publishTestRunStart(testDefaultSession(), runId);
          yield* testDefaultSession().settlePublications();
          yield* store.writeResultMeta({
            producer: 'subagent',
            agentName: 'test-subagent',
            wallTimeMs: 1,
            output: {
              category: 'toolUse',
              response: 'interim response',
              files: [],
            },
          });
          const handle = createHandle(runId, parentRunId);
          registry.track(handle);
          parkWaitingHandle(registry, handle, Effect.sync(cleanup));
          // Mirrors resumeQueuedToolUseFromResumeData's status flip that runs ahead of
          // the resumed run's own context — RUNNING phase, RESUMING substate.
          phases.set(runId, RUN_PHASE.RUNNING, {
            substate: RUN_SUBSTATE.RESUMING,
          });

          const stop = registry.kill(runId);
          expect(stop.accepted()).toBe(true);
          yield* stop.settlement;

          expect(cleanup).toHaveBeenCalledOnce();
          expect(registry.getHandle(runId)).toBeUndefined();
          // Both reads fold committed rows, which the settlement wrote before it
          // resolved; a null here would be a durability finding, not a race.
          expect(yield* store.readRunEnd()).toMatchObject({
            outcome: RUN_OUTCOME.CANCELLED,
          });
          expect(yield* store.readResultMeta()).toMatchObject({
            output: { response: 'interim response' },
          });
        } finally {
          registry.dispose();
        }
      }),
  );

  it('owns visible run stop policy for root and children', () => {
    const { events, phases, registry } = createRegistry();
    const recorded = recordSessionEvents(events);
    const rootRunId = generateRunId();
    const childRunId = generateRunId();
    const rootInterrupt = vi.fn();
    const childInterrupt = vi.fn();
    const queuedChildInterrupt = vi.fn();

    try {
      registry.reserveChildActivation({
        runId: generateRunId(),
        parentRunId: rootRunId,
        interrupt: queuedChildInterrupt,
        detach: vi.fn(),
        isDetached: () => false,
      });
      trackInterruptibleHandle(registry, { runId: rootRunId }, rootInterrupt, {
        agentName: 'test-root',
      });
      trackInterruptibleHandle(
        registry,
        { runId: childRunId, parent: rootRunId },
        childInterrupt,
      );

      stopRegistry(registry, rootRunId);

      expect(rootInterrupt).toHaveBeenCalledOnce();
      expect(childInterrupt).toHaveBeenCalledOnce();
      expect(queuedChildInterrupt).toHaveBeenCalledOnce();
    } finally {
      registry.dispose();
    }
  });

  it('interrupts grandchildren when killing a subagent chain', () => {
    const { phases, registry } = createRegistry();
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

      expect(killRegistry(registry, childRunId)).toBe(true);

      expect(childInterrupt).toHaveBeenCalledOnce();
      expect(grandchildInterrupt).toHaveBeenCalledOnce();
    } finally {
      registry.dispose();
    }
  });

  it('detaches descendants when killing with detached subagents', () => {
    const { events, phases, registry } = createRegistry();
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

      expect(
        killRegistry(registry, childRunId, {
          detachActiveChildren: true,
        }),
      ).toBe(true);

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
  });

  it('detaches children when stopping a run with detached subagents', () => {
    const { events, phases, registry } = createRegistry();
    const recorded = recordSessionEvents(events);
    const rootRunId = generateRunId();
    const childRunId = generateRunId();
    const grandchildRunId = generateRunId();
    const rootInterrupt = vi.fn();
    const childInterrupt = vi.fn();
    const grandchildInterrupt = vi.fn();

    try {
      trackInterruptibleHandle(registry, { runId: rootRunId }, rootInterrupt, {
        agentName: 'test-root',
      });
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

      stopRegistry(registry, rootRunId, {
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
  });

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
            runId: lateChildRunId,
            parentRunId: rootRunId,
            interrupt: vi.fn(),
            detach: vi.fn(),
            isDetached: () => false,
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

  it('stops one child while preserving its owner, sibling, and agent descendants', () => {
    const { phases, registry } = createRegistry();
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

      stopRegistry(registry, childRunId, {
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
  });

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
    const { events, phases, registry } = createRegistry();
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

  it('projects detach updates from session events', () => {
    const { events, registry } = createRegistry();
    const recorded = recordSessionEvents(events);
    const parentRunId = generateRunId();
    const runId = generateRunId();

    try {
      const handle = createHandle(runId, parentRunId);

      registry.track(handle);
      expect(handle.deliveryTarget).toBe(parentRunId);
      const sinceTrack = recordSessionEvents(events);
      Effect.runSync(registry.detachActiveChildren(parentRunId));
      expect(handle.deliveryTarget).toBeUndefined();

      expect(sinceTrack.events.map((event) => event.type)).toEqual([
        'run.detach',
      ]);

      expect(eventsOfType(recorded.events, 'run.detach')).toContainEqual({
        type: 'run.detach',
        aggregateId: qualifyAggregateId('run', runId),
      });
      expect(registry.hasActiveChildren(parentRunId)).toBe(false);
    } finally {
      registry.dispose();
    }
  });

  it('keeps a handle replacing a detached registration a root run', () => {
    const { registry } = createRegistry();
    const parentRunId = generateRunId();
    const runId = generateRunId();

    try {
      // The provisional registration a launch makes before it prepares, and
      // the parent's detaching stop landing while that preparation runs.
      const provisional = createHandle(runId, parentRunId);
      registry.track(provisional);
      Effect.runSync(registry.detachActiveChildren(parentRunId));

      // The lifecycle's handle, built from the edge the launch started with.
      const lifecycle = createHandle(runId, parentRunId);
      registry.track(lifecycle);

      expect(lifecycle.deliveryTarget).toBeUndefined();
      expect(registry.hasActiveChildren(parentRunId)).toBe(false);
    } finally {
      registry.dispose();
    }
  });

  it('preserves child approvals when detaching it from its parent', () => {
    const approvals = createSessionApprovals();
    const { registry } = createRegistry({ approvals });
    const parentRunId = generateRunId();
    const childRunId = generateRunId();
    const handle = createHandle(childRunId, parentRunId);

    try {
      approvals.toolEdit.bypass.setBypass(parentRunId, true);
      approvals.registerRunParent(childRunId, parentRunId);
      registry.track(handle);

      Effect.runSync(registry.detachActiveChildren(parentRunId));
      approvals.toolEdit.bypass.setBypass(parentRunId, false);

      expect(approvals.toolEdit.bypass.isBypassed(childRunId)).toBe(true);
      expect(handle.deliveryTarget).toBeUndefined();
    } finally {
      registry.dispose();
    }
  });
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
