import '@test/support/defaultSessionTestSetup';
// Third-party imports
import { it as effectIt } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { getRunRecords } from '@agent/storage';
import type { AgentTrace } from '@agent/trace';
import { finalizeRun } from '@agent/storage/runLifecycle';
import type {
  RunHandle,
  LiveToolUseFlowContext,
} from '@agent/runtime/RunHandle';
import { finalizeRunTerminal } from '@agent/runtime/AgentRunLifecycle';
import { RunRegistry } from '@agent/runtime/runRegistry';
import { RunBusy } from '@agent/runtime/runLanes';
import {
  defaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { statusDraft } from '@agent/runtime/SessionEvents';
import { RunStatusMachine } from '@agent/runtime/RunStatusService';
import { createSessionApprovals } from '@agent/runtime/runApprovalQueue';
import {
  aggregateId as qualifyAggregateId,
  RUN_OUTCOME,
  RUN_PHASE,
  RUN_SUBSTATE,
  type RunId,
  AgentCategory,
  type SessionEventDraft,
} from '@shared/schemas';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { createDeferred } from '@test/support/asyncTestUtils';
import { testRunHandle } from '@test/support/runHandleFixtures';
import { setupPlatform } from '@test/support/setupPlatform';
import { seedRunStatusForTest } from '@test/support/runStatusTestUtils';
import { generateRunId } from '@utils/core';
import { ensureError } from '@utils/errors/errorMessage';

// Local file imports
import { eventsOfType, recordChildRosters } from '../progressTestUtils';

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

/** Wires the events/runStatus/registry trio most tests drive kills through. */
function createRegistry(
  options: {
    approvals?: ReturnType<typeof createSessionApprovals>;
    releaseRootRunLease?: (runId: RunId) => Effect.Effect<void, Error>;
  } = {},
): {
  events: PublishedEvents;
  runStatus: RunStatusMachine;
  registry: RunRegistry;
} {
  // The session's publish path, in miniature: the machine's status facts
  // reach the registry's `handleStatus` before they land, and every draft
  // the registry or the machine publishes is appended in order.
  const events: PublishedEvents = { published: [] };
  const runStatus = new RunStatusMachine(
    (event) => {
      registry.handleStatus(event.runId);
      events.published.push(statusDraft(event));
    },
    () => {},
  );
  const registry = new RunRegistry({
    runStatus,
    publish: (drafts) => events.published.push(...drafts),
    approvals: createSessionApprovals({ setApprovalBypassState() {} }),
    releaseRootRunLease: () => Effect.void,
    finalizeRun: (input) => finalizeRun(defaultSession(), input),
    ...options,
  });
  return { events, runStatus, registry };
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
    modelHandler: { supportsManualCompaction: true },
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
  runStatus: RunStatusMachine,
  options: {
    runId: RunId;
    parent?: RunId | null;
    cleanup?: () => void | Promise<void>;
    overrides?: HandleOverrides;
  },
): RunHandle {
  const handle = createHandle(
    options.runId,
    options.parent ?? null,
    options.overrides,
  );
  registry.track(handle);
  handle.suspend(
    Effect.tryPromise({
      try: async () => {
        await options.cleanup?.();
      },
      catch: ensureError,
    }),
  );
  seedRunStatusForTest(runStatus, options.runId, {
    phase: RUN_PHASE.WAITING,
  });
  return handle;
}

/** Exercise synchronous stop admission and run its native settlement at the test boundary. */
function killRegistry(
  registry: RunRegistry,
  ...args: Parameters<RunRegistry['kill']>
): boolean {
  const stop = registry.kill(...args);
  Effect.runFork(stop.settlement);
  return stop.accepted;
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
      registry.detachActiveChildren(parentRunId);
      expect(registry.hasActiveChildren(parentRunId)).toBe(false);

      const handle = createHandle(runId, parentRunId);
      registry.track(handle);
      expect(handle.parent).toBeNull();
      expect(handle.deliveryTarget).toBeUndefined();
    } finally {
      registry.dispose();
    }
  });

  it('lets exactly one stop claim a suspended run and reports its teardown', async () => {
    const handle = createHandle(generateRunId());
    const cleanupFinished = createDeferred();
    handle.suspend(Effect.promise(() => cleanupFinished.promise));

    const teardown = handle.beginSuspendedTermination();
    expect(teardown).toBeDefined();
    expect(handle.suspendedTerminationStarted).toBe(true);
    // A second stop of the same suspended run finds the claim taken, so it
    // cannot start a second teardown or publish a second terminal outcome.
    expect(handle.beginSuspendedTermination()).toBeUndefined();
    let observedCompletion = false;
    const observation =
      teardown &&
      Effect.runPromise(
        teardown.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              observedCompletion = true;
            }),
          ),
        ),
      );
    await Promise.resolve();
    expect(observedCompletion).toBe(false);

    cleanupFinished.resolve();
    await observation;
    expect(observedCompletion).toBe(true);
  });

  it('drains a background-bash RunHandle on shutdown without disturbing a resumable agent run (issue #8155)', () => {
    // A background `bash` run is registered as an RunHandle (see
    // createChildRun in tools/bash.ts) with its OS-process kill reachable
    // only via the interrupt handler a background-process child attaches. The two
    // RunHandles below are tracked concurrently, mirroring the real
    // interleaving at shutdown: a background bash child run alongside an
    // ordinary resumable agent run (e.g. a native subagent loop, whose
    // own loop-level interrupt handler must stay untouched so restart recovery
    // can resume it). Drain must reach only the former.
    const { runStatus, registry } = createRegistry();
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
      registry.trackAgentRun(bashHandle, {
        status: RUN_PHASE.RUNNING,
      });

      // Ordinary agent run (e.g. a native-subagent loop's own
      // loop-level interrupt handler): no ownsBackgroundProcess flag, so
      // shutdown drain must leave it alone for restart recovery.
      const agentHandle = createHandle(agentRunId, agentParentRunId);
      agentHandle.attachInterruptHandler({ interrupt: agentInterrupt });
      registry.trackAgentRun(agentHandle, {
        status: RUN_PHASE.RUNNING,
      });

      registry.killBackgroundProcesses();

      expect(bashInterrupt).toHaveBeenCalledOnce();
      expect(agentInterrupt).not.toHaveBeenCalled();
      // Neither RunHandle's tracked status changes: killing a
      // background OS process bypasses the generic terminate()/kill() path
      // (and its cancelRunStatus side effect) so restart recovery still
      // finds both handles exactly as it would have before shutdown.
      expect(runStatus.get(bashRunId)).toBe(RUN_PHASE.RUNNING);
      expect(runStatus.get(agentRunId)).toBe(RUN_PHASE.RUNNING);
      expect(registry.getHandle(bashRunId)).toBe(bashHandle);
      expect(registry.getHandle(agentRunId)).toBe(agentHandle);
    } finally {
      registry.dispose();
    }
  });

  it('uses the handle interrupt target when terminating agent handles', () => {
    const { runStatus, registry } = createRegistry();
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
      expect(runStatus.get(runId)).toBe(RUN_PHASE.CANCELLED);
    } finally {
      registry.dispose();
    }
  });

  it('falls back to the parked teardown when a suspended handle has no live interrupt (issue #7287)', async () => {
    // A native subagent suspended at WAITING has already had its live
    // interrupt context detached (runToolUseFlow's finally), while the handle
    // stays tracked for resume. With no interrupt target left, terminate()
    // must fall back to the parked teardown rather than no-op and strand the
    // handle registered forever.
    const { runStatus, registry } = createRegistry();
    const parentRunId = generateRunId();
    const runId = generateRunId();
    const cleanup = vi.fn();

    try {
      // No handle interrupt target: mirrors a suspended subagent whose live
      // tool-use session has already been disposed. The run phase follows
      // the same suspension, as it does in production.
      trackSuspendedWaitingHandle(registry, runStatus, {
        runId,
        parent: parentRunId,
        cleanup,
      });

      const stop = registry.kill(runId);
      expect(stop.accepted).toBe(true);
      await Effect.runPromise(stop.settlement);

      expect(cleanup).toHaveBeenCalledOnce();
      expect(runStatus.get(runId)).toBe(RUN_PHASE.CANCELLED);
      expect(registry.getHandle(runId)).toBeUndefined();
    } finally {
      registry.dispose();
    }
  });

  it('writes the cancelled `run.end` row when killing a suspended WAITING handle', async () => {
    // terminateWaitingHandle bypasses runFlowWithLifecycle (the flow never
    // resumes), so it writes the terminal row itself — otherwise session
    // subscribers silently miss a user-initiated stop of a suspended native
    // subagent. The turn's own trace is already torn down by the time a kill
    // runs, so the row, not an emit, is what reaches them.
    storageMocks.finalizeRun.mockClear();
    const { runStatus, registry } = createRegistry();
    const parentRunId = generateRunId();
    const runId = generateRunId();

    try {
      trackSuspendedWaitingHandle(registry, runStatus, {
        runId,
        parent: parentRunId,
      });

      const stop = registry.kill(runId);
      expect(stop.accepted).toBe(true);
      await Effect.runPromise(stop.settlement);

      expect(storageMocks.finalizeRun).toHaveBeenCalledExactlyOnceWith(
        defaultSession(),
        {
          runId,
          outcome: RUN_OUTCOME.CANCELLED,
          output: EMPTY_TOOL_USE_OUTPUT,
          flowRecord: 'preserve',
        },
      );
    } finally {
      registry.dispose();
    }
  });

  it('publishes a waiting cancellation after its transcript cleanup settles', async () => {
    const order: string[] = [];
    storageMocks.finalizeRun.mockClear();
    storageMocks.finalizeRun.mockImplementationOnce(() => {
      order.push('finalize');
      return Effect.succeed({ ok: true, outcomePersisted: true });
    });
    const { runStatus, registry } = createRegistry();
    const runId = generateRunId();
    let finishCleanup = (): void => undefined;
    const cleanupGate = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });

    try {
      const handle = trackSuspendedWaitingHandle(registry, runStatus, {
        runId,
        parent: generateRunId(),
        cleanup: async () => {
          await cleanupGate;
          order.push('cleanup');
        },
      });

      const stop = registry.kill(runId);
      expect(stop.accepted).toBe(true);
      const settled = Effect.runPromise(stop.settlement);
      await Promise.resolve();
      expect(storageMocks.finalizeRun).not.toHaveBeenCalled();
      expect(registry.getHandle(runId)).toBe(handle);
      expect(runStatus.get(runId)).toBe(RUN_PHASE.WAITING);

      finishCleanup();
      await settled;
      expect(order).toEqual(['cleanup', 'finalize']);
      expect(registry.getHandle(runId)).toBeUndefined();
      expect(runStatus.get(runId)).toBe(RUN_PHASE.CANCELLED);
    } finally {
      registry.dispose();
    }
  });

  it('hands a waiting stop to a successor tracked during cleanup', async () => {
    storageMocks.finalizeRun.mockClear();
    const { runStatus, registry } = createRegistry();
    const parentRunId = generateRunId();
    const runId = generateRunId();
    let finishCleanup = (): void => undefined;
    const cleanupGate = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });

    try {
      trackSuspendedWaitingHandle(registry, runStatus, {
        runId,
        parent: parentRunId,
        cleanup: () => cleanupGate,
      });

      const stop = registry.kill(runId);
      expect(stop.accepted).toBe(true);
      const settled = Effect.runPromise(stop.settlement);

      const successorInterrupt = vi.fn();
      const successor = trackInterruptibleHandle(
        registry,
        { runId, parent: parentRunId },
        successorInterrupt,
      );

      expect(successorInterrupt).toHaveBeenCalledOnce();
      finishCleanup();
      await settled;

      expect(registry.getHandle(runId)).toBe(successor);
      expect(storageMocks.finalizeRun).not.toHaveBeenCalled();
      expect(runStatus.get(runId)).toBe(RUN_PHASE.WAITING);
    } finally {
      registry.dispose();
    }
  });

  it('settles waiting termination when the terminal row write throws', async () => {
    storageMocks.finalizeRun.mockImplementationOnce(() => {
      throw new Error('terminal row write failed');
    });
    const { runStatus, registry } = createRegistry();
    const runId = generateRunId();

    try {
      trackSuspendedWaitingHandle(registry, runStatus, {
        runId,
        parent: generateRunId(),
      });

      const stop = registry.kill(runId);
      expect(stop.accepted).toBe(true);
      await Effect.runPromise(stop.settlement);
      expect(registry.getHandle(runId)).toBeUndefined();
      expect(runStatus.get(runId)).toBe(RUN_PHASE.CANCELLED);
    } finally {
      registry.dispose();
    }
  });

  it('settles and untracks a waiting handle when terminal metadata persistence fails', async () => {
    const { runStatus, registry } = createRegistry();
    const parentRunId = generateRunId();
    const runId = generateRunId();
    const durabilityError = new Error('metadata disk write failed');
    storageMocks.finalizeRun.mockReturnValueOnce(
      Effect.succeed({
        ok: false,
        outcomePersisted: false,
        error: durabilityError,
      }),
    );
    channelTraceMocks.warn.mockClear();

    try {
      trackSuspendedWaitingHandle(registry, runStatus, {
        runId,
        parent: parentRunId,
      });

      const stop = registry.kill(runId);
      expect(stop.accepted).toBe(true);
      await Effect.runPromise(stop.settlement);

      expect(registry.getHandle(runId)).toBeUndefined();
      expect(runStatus.get(runId)).toBe(RUN_PHASE.CANCELLED);
      await vi.waitFor(() => {
        expect(channelTraceMocks.warn).toHaveBeenCalledExactlyOnceWith(
          'Failed to finalize stopped waiting run',
          {
            data: {
              runId,
              outcomePersisted: false,
              error: durabilityError,
            },
          },
        );
      });
    } finally {
      registry.dispose();
    }
  });

  it('persists a waiting stop after transcript cleanup fails', async () => {
    const { runStatus, registry } = createRegistry();
    const runId = generateRunId();
    const cleanupError = new Error('transcript reload failed');
    storageMocks.finalizeRun.mockReturnValueOnce(Effect.succeed({ ok: true }));
    channelTraceMocks.warn.mockClear();

    try {
      trackSuspendedWaitingHandle(registry, runStatus, {
        runId,
        parent: generateRunId(),
        cleanup: () => Promise.reject(cleanupError),
      });

      expect(killRegistry(registry, runId)).toBe(true);

      await vi.waitFor(() => {
        expect(storageMocks.finalizeRun).toHaveBeenCalledWith(
          defaultSession(),
          {
            runId,
            outcome: RUN_OUTCOME.CANCELLED,
            output: EMPTY_TOOL_USE_OUTPUT,
            // A stopped WAITING run keeps its checkpoint: this is precisely the
            // run a user resumes (#11315).
            flowRecord: 'preserve',
          },
        );
      });
      expect(channelTraceMocks.warn).toHaveBeenCalledWith(
        'Waiting-run cleanup failed; continuing terminal persistence',
        { data: { runId, error: cleanupError } },
      );
    } finally {
      registry.dispose();
    }
  });

  it('persists a waiting stop when only flow-record retention fails', async () => {
    const { runStatus, registry } = createRegistry();
    const runId = generateRunId();
    const cleanupError = new Error('flow retention failed');
    storageMocks.finalizeRun.mockReturnValueOnce(
      Effect.succeed({
        ok: false,
        outcomePersisted: true,
        error: cleanupError,
      }),
    );
    channelTraceMocks.warn.mockClear();

    try {
      trackSuspendedWaitingHandle(registry, runStatus, {
        runId,
        parent: generateRunId(),
      });

      expect(killRegistry(registry, runId)).toBe(true);

      await vi.waitFor(() => {
        expect(storageMocks.finalizeRun).toHaveBeenCalledWith(
          defaultSession(),
          {
            runId,
            outcome: RUN_OUTCOME.CANCELLED,
            output: EMPTY_TOOL_USE_OUTPUT,
            // A stopped WAITING run keeps its checkpoint: this is precisely the
            // run a user resumes (#11315).
            flowRecord: 'preserve',
          },
        );
      });
      expect(channelTraceMocks.warn).toHaveBeenCalledExactlyOnceWith(
        'Failed to finalize stopped waiting run',
        {
          data: {
            runId,
            outcomePersisted: true,
            error: cleanupError,
          },
        },
      );
    } finally {
      registry.dispose();
    }
  });

  it('reports a failed kill for a tracked handle with neither an interrupt nor a suspension', () => {
    // Guards the fallback above: a handle that never parked must still no-op,
    // or the fallback could spuriously tear down a handle mid-completion, in
    // the narrow window between its own interrupt unregister and its own
    // untrack.
    const { runStatus, registry } = createRegistry();
    const parentRunId = generateRunId();
    const runId = generateRunId();

    try {
      const handle = createHandle(runId, parentRunId);
      registry.track(handle);

      expect(killRegistry(registry, runId)).toBe(false);

      expect(runStatus.get(runId)).toBeUndefined();
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
    const { runStatus, registry } = createRegistry();
    const parentRunId = generateRunId();
    const runId = generateRunId();

    try {
      const handle = createHandle(runId, parentRunId);
      registry.track(handle);
      seedRunStatusForTest(runStatus, runId, {
        phase: RUN_PHASE.WAITING,
      });

      expect(killRegistry(registry, runId)).toBe(false);

      expect(registry.getHandle(runId)).toBe(handle);
      expect(runStatus.get(runId)).toBe(RUN_PHASE.WAITING);
    } finally {
      registry.dispose();
    }
  });

  it('refuses a waiting stop once a terminal finalize has claimed the run', async () => {
    // Both terminal writers claim the same gate, so a kill landing while
    // `finalizeRunTerminal` is parked at its persist await cannot run the
    // suspended teardown, publish a second `result`, or persist a second
    // terminal status over the finalizer's outcome.
    const { runStatus, registry } = createRegistry();
    const parentRunId = generateRunId();
    const runId = generateRunId();
    const teardown = vi.fn();
    storageMocks.finalizeRun.mockClear();
    let releasePersist: (() => void) | undefined;
    storageMocks.finalizeRun.mockImplementationOnce(() =>
      Effect.promise(
        () =>
          new Promise((resolve) => {
            releasePersist = () => resolve({ ok: true });
          }),
      ),
    );

    try {
      const handle = trackSuspendedWaitingHandle(registry, runStatus, {
        runId,
        parent: parentRunId,
        cleanup: teardown,
      });

      const session = {
        runs: registry,
        status: runStatus,
        flushArtifacts: async () => {},
      } as unknown as SessionHandle;
      const finalized = Effect.runPromise(
        finalizeRunTerminal({
          session,
          handle,
          outcome: RUN_OUTCOME.COMPLETED,
          flowRecord: 'delete',
        }),
      );
      await vi.waitFor(() => expect(releasePersist).toBeDefined());

      expect(killRegistry(registry, runId)).toBe(false);

      releasePersist?.();
      await finalized;
      expect(teardown).not.toHaveBeenCalled();
      expect(storageMocks.finalizeRun).toHaveBeenCalledExactlyOnceWith(
        session,
        expect.objectContaining({
          runId,
          outcome: RUN_OUTCOME.COMPLETED,
          flowRecord: 'delete',
        }),
      );
      expect(registry.getHandle(runId)).toBeUndefined();
      expect(runStatus.get(runId)).toBe(RUN_PHASE.COMPLETED);
    } finally {
      registry.dispose();
    }
  });

  it('tears down and aligns a suspended handle killed during RESUMING', async () => {
    // Regression: `resumeQueuedToolUseFromResumeData` flips `runStatus` to
    // RUNNING with a RESUMING substate *before* the resumed run installs its
    // own interrupt context. The handle it is resuming is still parked from
    // the earlier genuine WAITING suspension, so a kill landing in that window
    // tears it down off that fact alone — no phase or substate is consulted.
    const { runStatus, registry } = createRegistry();
    const runId = 'eec-abcdef' as RunId;
    const parentRunId = generateRunId();
    const cleanup = vi.fn();
    const store = getRunRecords(defaultSession(), runId);

    try {
      publishTestRunStart(defaultSession(), runId);
      await defaultSession().settlePublications();
      await Effect.runPromise(
        store.writeResultMeta({
          producer: 'subagent',
          agentName: 'test-subagent',
          wallTimeMs: 1,
          output: {
            category: 'toolUse',
            response: 'interim response',
            files: [],
          },
        }),
      );
      const handle = createHandle(runId, parentRunId);
      registry.track(handle);
      handle.suspend(Effect.sync(cleanup));
      // Mirrors resumeQueuedToolUseFromResumeData's status flip that runs ahead of
      // the resumed run's own context — RUNNING phase, RESUMING substate.
      seedRunStatusForTest(runStatus, runId, {
        phase: RUN_PHASE.RUNNING,
        substate: RUN_SUBSTATE.RESUMING,
      });

      const stop = registry.kill(runId);
      expect(stop.accepted).toBe(true);
      await Effect.runPromise(stop.settlement);

      expect(cleanup).toHaveBeenCalledOnce();
      expect(registry.getHandle(runId)).toBeUndefined();
      await vi.waitFor(async () => {
        await expect(
          Effect.runPromise(store.readRunEnd()),
        ).resolves.toMatchObject({
          outcome: RUN_OUTCOME.CANCELLED,
        });
        await expect(
          Effect.runPromise(store.readResultMeta()),
        ).resolves.toMatchObject({
          output: { response: 'interim response' },
        });
      });
    } finally {
      registry.dispose();
    }
  });

  it('owns visible run stop policy for root and children', () => {
    const { events, runStatus, registry } = createRegistry();
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
      expect(runStatus.get(rootRunId)).toBe(RUN_PHASE.CANCELLED);
      expect(runStatus.get(childRunId)).toBe(RUN_PHASE.CANCELLED);
      // The terminal phase rides `run.end`, so no status row carries it.
      expect(eventsOfType(recorded.events, 'status')).toEqual([]);
    } finally {
      registry.dispose();
    }
  });

  it('interrupts grandchildren when killing a subagent chain', () => {
    const { runStatus, registry } = createRegistry();
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
      expect(runStatus.get(childRunId)).toBe(RUN_PHASE.CANCELLED);
      expect(runStatus.get(grandchildRunId)).toBe(RUN_PHASE.CANCELLED);
    } finally {
      registry.dispose();
    }
  });

  it('detaches descendants when killing with detached subagents', () => {
    const { events, runStatus, registry } = createRegistry();
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
      expect(runStatus.get(childRunId)).toBe(RUN_PHASE.CANCELLED);
      expect(runStatus.get(grandchildRunId)).toBeUndefined();
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
    const { events, runStatus, registry } = createRegistry();
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
      expect(registry.getActiveChildren(rootRunId)).toHaveLength(0);
      expect(registry.getHandle(childRunId)?.parent).toBeNull();
      expect(registry.getHandle(grandchildRunId)?.parent).toBe(childRunId);
      expect(registry.getActiveChildren(childRunId)).toEqual([
        expect.objectContaining({ childRunId: grandchildRunId }),
      ]);
      expect(runStatus.get(rootRunId)).toBe(RUN_PHASE.CANCELLED);
      expect(runStatus.get(childRunId)).toBeUndefined();
      expect(runStatus.get(grandchildRunId)).toBeUndefined();
      expect(eventsOfType(recorded.events, 'run.detach')).toContainEqual({
        type: 'run.detach',
        aggregateId: qualifyAggregateId('run', childRunId),
      });
    } finally {
      registry.dispose();
    }
  });

  it('stops one child while preserving its owner, sibling, and agent descendants', () => {
    const { runStatus, registry } = createRegistry();
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
      expect(runStatus.get(childRunId)).toBe(RUN_PHASE.CANCELLED);
      expect(runStatus.get(rootRunId)).toBeUndefined();
      expect(runStatus.get(siblingRunId)).toBeUndefined();
      expect(runStatus.get(descendantRunId)).toBeUndefined();
    } finally {
      registry.dispose();
    }
  });

  it('cancels an ownerless run', () => {
    const { events, runStatus, registry } = createRegistry();
    const recorded = recordSessionEvents(events);
    const runId = generateRunId();

    try {
      stopRegistry(registry, runId);

      expect(runStatus.get(runId)).toBe(RUN_PHASE.CANCELLED);
      // The terminal phase rides `run.end`, so no status row carries it.
      expect(eventsOfType(recorded.events, 'status')).toEqual([]);
    } finally {
      registry.dispose();
    }
  });

  it('leaves an already-terminal run phase untouched', () => {
    const { runStatus, registry } = createRegistry();
    const runId = generateRunId();

    try {
      seedRunStatusForTest(runStatus, runId, {
        phase: RUN_PHASE.COMPLETED,
      });

      stopRegistry(registry, runId);

      expect(runStatus.get(runId)).toBe(RUN_PHASE.COMPLETED);
    } finally {
      registry.dispose();
    }
  });

  it('reports agent status from its run-status owner', () => {
    const { runStatus, registry } = createRegistry();
    const parentRunId = generateRunId();
    const runId = generateRunId();

    try {
      seedRunStatusForTest(runStatus, runId, {
        phase: RUN_PHASE.WAITING,
      });
      registry.track(createHandle(runId, parentRunId));

      expect(registry.getActiveChildren(parentRunId)).toEqual([
        expect.objectContaining({
          childRunId: runId,
          status: RUN_PHASE.WAITING,
        }),
      ]);
    } finally {
      registry.dispose();
    }
  });

  it('reports active elapsed from runStartedAt without a handle fallback', () => {
    vi.useFakeTimers({ now: 1_000 });
    const { runStatus, registry } = createRegistry();
    const parentRunId = generateRunId();
    const runId = generateRunId();
    const handle = createHandle(runId, parentRunId);

    try {
      registry.track(handle);
      vi.setSystemTime(10_000);
      seedRunStatusForTest(runStatus, runId, {
        phase: RUN_PHASE.RUNNING,
        runStartedAt: 6_000,
      });

      expect(registry.getStatus(handle)).toEqual({
        status: RUN_PHASE.RUNNING,
        elapsed: '4s',
      });
      expect(registry.getActiveChildren(parentRunId)[0]?.startedAt).toBe(1_000);

      seedRunStatusForTest(runStatus, runId, {
        phase: RUN_PHASE.RUNNING,
      });
      expect(registry.getStatus(handle).elapsed).toBeNull();
    } finally {
      vi.useRealTimers();
      registry.dispose();
    }
  });

  it('publishes initial status when tracking an agent run', () => {
    const { runStatus, registry } = createRegistry();
    const parentRunId = generateRunId();
    const runId = generateRunId();

    try {
      registry.trackAgentRun(createHandle(runId, parentRunId), {
        status: RUN_PHASE.RUNNING,
      });

      expect(runStatus.get(runId)).toBe(RUN_PHASE.RUNNING);
      expect(registry.getActiveChildren(parentRunId)).toEqual([
        expect.objectContaining({
          childRunId: runId,
          status: RUN_PHASE.RUNNING,
        }),
      ]);
    } finally {
      registry.dispose();
    }
  });

  it('updates live agent status without reviving stopped or stale handles', () => {
    const { runStatus, registry } = createRegistry();
    const parentRunId = generateRunId();
    const runId = generateRunId();
    const handle = createHandle(runId, parentRunId);

    try {
      registry.trackAgentRun(handle, { status: RUN_PHASE.RUNNING });

      expect(registry.updateAgentRunStatus(handle, RUN_PHASE.WAITING)).toBe(
        true,
      );
      expect(runStatus.get(runId)).toBe(RUN_PHASE.WAITING);

      seedRunStatusForTest(runStatus, runId, {
        phase: RUN_PHASE.CANCELLED,
      });
      expect(registry.getActiveChildren(parentRunId)).toEqual([
        expect.objectContaining({
          childRunId: runId,
          status: RUN_PHASE.CANCELLED,
        }),
      ]);
      expect(registry.updateAgentRunStatus(handle, RUN_PHASE.RUNNING)).toBe(
        false,
      );
      expect(runStatus.get(runId)).toBe(RUN_PHASE.CANCELLED);

      registry.untrack(runId);
      seedRunStatusForTest(runStatus, runId, {
        phase: RUN_PHASE.WAITING,
      });
      expect(registry.updateAgentRunStatus(handle, RUN_PHASE.RUNNING)).toBe(
        false,
      );
      expect(runStatus.get(runId)).toBe(RUN_PHASE.WAITING);
    } finally {
      registry.dispose();
    }
  });

  it('detaches children of an ownerless run and cancels it', () => {
    const { events, runStatus, registry } = createRegistry();
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
      expect(runStatus.get(parentRunId)).toBe(RUN_PHASE.CANCELLED);
      expect(runStatus.get(childRunId)).toBeUndefined();
    } finally {
      registry.dispose();
    }
  });

  it('projects handle updates from session events', () => {
    const { events, registry } = createRegistry();
    const recorded = recordSessionEvents(events);
    const rosters = recordChildRosters(registry);
    const parentRunId = generateRunId();
    const runId = generateRunId();

    try {
      const handle = createHandle(runId, parentRunId);

      registry.track(handle);
      registry.untrack(runId);

      const childActivity = rosters.rosters;
      expect(childActivity[0]).toMatchObject({
        parentRunId,
        items: [
          {
            childRunId: runId,
            agentName: 'test-subagent',
          },
        ],
      });
      // The parent edge is a `run.start` fact, so tracking publishes none.
      expect(recorded.events).toEqual([]);
      expect(childActivity.at(-1)).toMatchObject({
        parentRunId,
        items: [],
      });
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
    const unsupportedRunId = generateRunId();
    const requestImmediateCompaction = vi.fn();
    const ownerSession = {} as SessionHandle;
    const context = createLiveToolUseFlowContext({
      ownerSession,
      requestImmediateCompaction,
    });
    const unsupportedContext: LiveToolUseFlowContext = {
      ...context,
      modelHandler: {
        supportsManualCompaction: false,
      },
      requestImmediateCompaction: vi.fn(),
    };

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

      const unsupportedHandle = createHandle(unsupportedRunId, null, {
        agentName: 'test-tool-use',
      });
      unsupportedHandle.attachToolUseFlow(unsupportedContext);
      registry.track(unsupportedHandle);

      expect(registry.requestManualCompaction(unsupportedRunId)).toEqual({
        kind: 'unsupported',
        runId: unsupportedRunId,
      });
      expect(
        unsupportedContext.requestImmediateCompaction,
      ).not.toHaveBeenCalled();

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
    const { runStatus, registry } = createRegistry();
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
      seedRunStatusForTest(runStatus, activeRunId, {
        phase: RUN_PHASE.RUNNING,
      });

      expect(registry.getToolUseFollowUpTarget(activeRunId)).toEqual({
        kind: 'active',
        context,
      });

      seedRunStatusForTest(runStatus, resumingRunId, {
        phase: RUN_PHASE.RUNNING,
        substate: RUN_SUBSTATE.RESUMING,
      });
      expect(registry.getToolUseFollowUpTarget(resumingRunId)).toEqual({
        kind: 'queue',
      });

      seedRunStatusForTest(runStatus, waitingRunId, {
        phase: RUN_PHASE.WAITING,
      });
      expect(registry.getToolUseFollowUpTarget(waitingRunId)).toEqual({
        kind: 'queue',
      });

      seedRunStatusForTest(runStatus, stoppedRunId, {
        phase: RUN_PHASE.CANCELLED,
      });
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
    const rosters = recordChildRosters(registry);
    const parentRunId = generateRunId();
    const runId = generateRunId();

    try {
      const handle = createHandle(runId, parentRunId);

      registry.track(handle);
      expect(handle.deliveryTarget).toBe(parentRunId);
      const sinceTrack = recordSessionEvents(events);
      registry.detachActiveChildren(parentRunId);
      expect(handle.deliveryTarget).toBeUndefined();

      expect(sinceTrack.events.map((event) => event.type)).toEqual([
        'run.detach',
      ]);

      expect(eventsOfType(recorded.events, 'run.detach')).toContainEqual({
        type: 'run.detach',
        aggregateId: qualifyAggregateId('run', runId),
      });
      expect(rosters.rosters.at(-1)).toMatchObject({
        parentRunId,
        items: [],
      });
    } finally {
      registry.dispose();
    }
  });

  it('preserves child approvals when detaching it from its parent', () => {
    const approvals = createSessionApprovals({ setApprovalBypassState() {} });
    const { registry } = createRegistry({ approvals });
    const parentRunId = generateRunId();
    const childRunId = generateRunId();
    const handle = createHandle(childRunId, parentRunId);

    try {
      approvals.toolEdit.bypass.setBypass(parentRunId, true);
      approvals.registerRunParent(childRunId, parentRunId);
      registry.track(handle);

      registry.detachActiveChildren(parentRunId);
      approvals.toolEdit.bypass.setBypass(parentRunId, false);

      expect(approvals.toolEdit.bypass.isBypassed(childRunId)).toBe(true);
      expect(handle.deliveryTarget).toBeUndefined();
    } finally {
      registry.dispose();
    }
  });

  it('ignores status facts once disposed', () => {
    const { events, runStatus, registry } = createRegistry();
    const parentRunId = generateRunId();
    const runId = generateRunId();

    registry.track(createHandle(runId, parentRunId));
    const rosters = recordChildRosters(registry);
    registry.dispose();
    const recorded = recordSessionEvents(events);

    runStatus.transition(runId, RUN_PHASE.RUNNING, 'lifecycle');

    // Only the status machine's own fact remains; the registry contributes
    // no roster emission once its subscription is gone.
    expect(rosters.rosters).toEqual([]);
    expect(eventsOfType(recorded.events, 'status')).toHaveLength(1);
  });
});

effectIt.effect(
  'refuses owned runs and reserves an idle deletion before a competing launch',
  () =>
    Effect.gen(function* () {
      const { registry } = createRegistry();
      const runId = 'abcd12' as RunId;
      const started = createDeferred<void>();
      const finish = createDeferred<void>();
      const generation = yield* Effect.forkChild(
        registry.launchRun(
          runId,
          Effect.promise(async () => {
            started.resolve();
            await finish.promise;
          }),
        ),
        { startImmediately: true },
      );
      const remove = vi.fn();
      const removal = registry.withInactiveRunStep(runId, Effect.sync(remove));
      try {
        // Admission before the launch callback begins must already see its slot.
        expect(yield* Effect.flip(removal)).toBeInstanceOf(RunBusy);
        yield* Effect.promise(() => started.promise);
        expect(yield* Effect.flip(removal)).toBeInstanceOf(RunBusy);
        expect(remove).not.toHaveBeenCalled();
      } finally {
        finish.resolve();
      }
      yield* Fiber.join(generation);
      yield* Effect.yieldNow;

      // A parked turn may have no running generation, but its handle retains ownership.
      const parked = createHandle(runId, generateRunId());
      registry.track(parked);
      expect(yield* Effect.flip(removal)).toBeInstanceOf(RunBusy);
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
