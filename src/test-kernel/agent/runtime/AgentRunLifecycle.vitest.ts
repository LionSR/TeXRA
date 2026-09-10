import { Effect } from 'effect';
import '@test/support/defaultSessionTestSetup';

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { noopTrace, TraceEmitter } from '@agent/trace';
import type { FinalizeRunResult } from '@agent/storage/runLifecycle';
import {
  acquireResumedRunLease,
  inspectRunLease,
  releaseOwnedRunLease,
} from '@agent/storage/runLease';
import { RunStatusMachine } from '@agent/runtime/RunStatusService';
import {
  RunHandle,
  type AgentRunHandle,
} from '@agent/runtime/RunHandle';
import { defaultSession } from '@agent/runtime/SessionHandle';
import {
  finalizeRunTerminal,
  runFlowWithLifecycle,
} from '@agent/runtime/AgentRunLifecycle';
import {
  type ToolUseFlowResult,
  type WaitingToolUseFlowResult,
  type WorkflowFlowResult,
} from '@agent/runtime/AgentFlowResult';
import type { AgentLaunchContext } from '@agent/runtime/AgentLaunchContext';
import { platform } from '@platform/platform';
import {
  aggregateId as qualifyAggregateId,
  RUN_OUTCOME,
  RUN_PHASE,
  RUN_SUBSTATE,
  agentKey,
  AgentCategory,
} from '@shared/schemas';
import type { RunId, RunOutcome, RunId } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { testRunHandle } from '@test/support/runHandleFixtures';
import { installPlatform } from '@test/support/setupPlatform';
import {
  clearRunStatusForTest,
  seedRunStatusForTest,
} from '@test/support/runStatusTestUtils';

import {
  eventsOfType,
  recordChildRosters,
  recordSessionEvents,
} from '../progressTestUtils';
import { createTestLaunchContext } from './launchContextTestUtils';

const storageMocks = vi.hoisted(() => ({
  // Echoes the requested outcome, as the real finalizer does whenever there
  // is no existing outcome to retain.
  finalizeRun: vi.fn(
    (
      _session: unknown,
      input: {
        outcome: RunOutcome;
      },
    ): Effect.Effect<FinalizeRunResult> =>
      Effect.succeed({
        ok: true,
        outcome: input.outcome,
      }),
  ),
}));

const channelTraceMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

// AgentRunLifecycle deep-imports finalizeRun from runLifecycle
// (not the `@agent/storage` barrel). Spy only that leaf to avoid re-export
// recursion through a dual mock.
vi.mock('@agent/storage/runLifecycle', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@agent/storage/runLifecycle')
  >()),
  finalizeRun: storageMocks.finalizeRun,
}));
vi.mock('@agent/storage', () => ({
  finalizeRun: storageMocks.finalizeRun,
}));

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

beforeEach(() => {
  storageMocks.finalizeRun.mockClear();
  channelTraceMocks.warn.mockClear();
});

async function initLifecycleTestPlatform(firstRunDone: boolean) {
  await installPlatform({
    globalState: {
      [GlobalStateKey.ONBOARDING_FIRST_RUN_DONE]: firstRunDone,
    },
  });
  return platform();
}

let lifecycleFixtureCounter = 0;

function lifecycleFixture(
  slug: string,
  agent = 'test-agent',
  category: AgentCategory = AgentCategory.ToolUse,
): {
  runId: RunId;
  runId: RunId;
  runStatus: RunStatusMachine;
  ctx: AgentLaunchContext;
} {
  const runId =
    `e${(lifecycleFixtureCounter++).toString(16).padStart(5, '0')}` as RunId;
  const runId = `stream-${slug}` as RunId;
  return {
    runId,
    runId,
    runStatus: defaultSession().status,
    ctx: createTestLaunchContext({ runId, runId, agent, category }),
  };
}

function toolUseResult(
  runId: RunId,
  runId: RunId,
  outcome: RunOutcome,
): ToolUseFlowResult {
  return { category: 'toolUse', outcome, runId, runId };
}

function workflowResult(
  runId: RunId,
  runId: RunId,
  outcome: RunOutcome,
): WorkflowFlowResult {
  return {
    category: 'workflow',
    outcome,
    runId,
    runId,
    outputs: [],
    compileFailures: [],
  };
}

function waitingResult(
  runId: RunId,
  runId: RunId,
): WaitingToolUseFlowResult {
  return {
    category: 'toolUse',
    outcome: RUN_PHASE.WAITING,
    runId,
    runId,
  };
}

/**
 * Returns the suspended handle for a run that reported WAITING.
 *
 * The fake runners below return the WAITING outcome without driving the real
 * `transitionToWaiting()`, so the stream phase never reaches WAITING here —
 * which is the point: the handle's own suspension is what makes a stop tear
 * the run down, so no phase seeding is needed to reach that path.
 */
function takeWaitingHandle(runId: RunId): RunHandle {
  const handle = defaultSession().runs.getHandle(runId);
  expect(handle).toBeInstanceOf(RunHandle);
  if (!(handle instanceof RunHandle)) {
    throw new Error('Expected a suspended agent run handle.');
  }
  return handle;
}

/** Gate the next finalizeRun call on an explicit release. */
function parkNextFinalize(): { started: () => boolean; release: () => void } {
  let releasePersist: (() => void) | undefined;
  storageMocks.finalizeRun.mockImplementationOnce((_session, input) =>
    Effect.promise(
      () =>
        new Promise((resolve) => {
          releasePersist = () => resolve({ ok: true, outcome: input.outcome });
        }),
    ),
  );
  return {
    started: () => releasePersist !== undefined,
    release: () => releasePersist?.(),
  };
}

/** Publish the run and open stage that a suspended teardown must close. */
function seedOpenRunGroup(
  ctx: AgentLaunchContext,
  runId: RunId,
): string {
  const parentStageId = ctx.parentStage.id;
  if (!parentStageId)
    throw new Error('The fixture parent stage must carry an id.');
  const session = ctx.runScope.session;
  publishTestRunStart(session, runId, ctx.runScope.runId);
  session.publishRunEvent(runId, {
    type: 'stage.start',
    id: parentStageId,
    label: 'run',
    kind: 'run',
  });
  return parentStageId;
}

describe('runFlowWithLifecycle', () => {
  // The run's category reaches the handle and the terminal `result` through
  // the one descriptor the lifecycle builds, so a workflow run reports
  // `workflow` on both without either side re-deriving the string.
  it('reports the config agent category on the handle and terminal result', async () => {
    await initLifecycleTestPlatform(true);
    const { runId, runId, runStatus, ctx } = lifecycleFixture(
      'lifecycle-workflow-category',
      'polish',
      AgentCategory.Workflow,
    );
    let terminalResult: AgentRunHandle['result'] | undefined;

    try {
      const result = await Effect.runPromise(
        runFlowWithLifecycle(
          ctx,
          async () =>
            workflowResult(runId, runId, RUN_OUTCOME.COMPLETED),
          {
            onRun: async (handle) => {
              expect(handle.category).toBe('workflow');
              terminalResult = handle.result;
            },
          },
        ),
      );

      expect(result.outcome).toBe(RUN_OUTCOME.COMPLETED);
      await expect(Effect.runPromise(terminalResult!)).resolves.toMatchObject({
        category: 'workflow',
        agentName: 'polish',
      });
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('stops the Lean servers attributed to a run when the run ends', async () => {
    await initLifecycleTestPlatform(true);
    const { runId, runId, runStatus, ctx } = lifecycleFixture(
      'lifecycle-lean-server-stop',
    );
    const stopSessionsForRun = vi.fn(async (_runId: RunId) => {});

    try {
      const result = await Effect.runPromise(
        runFlowWithLifecycle(
          ctx,
          async () =>
            toolUseResult(runId, runId, RUN_OUTCOME.COMPLETED),
          { onRunEnd: stopSessionsForRun },
        ),
      );

      expect(result.outcome).toBe(RUN_OUTCOME.COMPLETED);
      expect(stopSessionsForRun).toHaveBeenCalledWith(runId);
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('does not stop the Lean servers when a tool-use run parks at WAITING', async () => {
    const { runId, runId, runStatus, ctx } = lifecycleFixture(
      'lifecycle-lean-server-stop-waiting',
    );
    const stopSessionsForRun = vi.fn(async (_runId: RunId) => {});

    try {
      const result = await Effect.runPromise(
        runFlowWithLifecycle(
          ctx,
          async () => waitingResult(runId, runId),
          { onRunEnd: stopSessionsForRun },
        ),
      );

      // WAITING is a suspension, not a terminal run end: the server must
      // survive the parked run so a resume reuses it instead of paying a cold
      // spawn.
      expect(result.outcome).toBe(RUN_PHASE.WAITING);
      expect(stopSessionsForRun).not.toHaveBeenCalled();
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });

  // A completed session marks first-run onboarding done, except for the
  // built-in setup agent, which must leave the flag untouched.
  const onboardingCases = [
    {
      label:
        'does not complete first-run onboarding for qualified setup sessions',
      slug: 'setup-agent',
      agent: agentKey('builtInToolUse', SETUP_AGENT_NAME),
      expectedDone: false,
    },
    {
      label: 'completes first-run onboarding for non-setup completed sessions',
      slug: 'non-setup-agent',
      agent: 'assistant',
      expectedDone: true,
    },
  ] as const;

  for (const { label, slug, agent, expectedDone } of onboardingCases) {
    it(label, async () => {
      const fake = await initLifecycleTestPlatform(false);
      const { runId, runId, runStatus, ctx } = lifecycleFixture(
        `lifecycle-${slug}`,
        agent,
      );

      try {
        await Effect.runPromise(
          runFlowWithLifecycle(ctx, async () =>
            toolUseResult(runId, runId, RUN_OUTCOME.COMPLETED),
          ),
        );

        expect(
          fake.globalState.get(GlobalStateKey.ONBOARDING_FIRST_RUN_DONE),
        ).toBe(expectedDone);
      } finally {
        clearRunStatusForTest(runStatus, runId);
      }
    });
  }

  it('persists terminal state before updating onboarding state', async () => {
    const fake = await initLifecycleTestPlatform(false);
    const { runId, runId, runStatus, ctx } = lifecycleFixture(
      'terminal-before-onboarding',
      'assistant',
    );
    const updateOnboarding = vi.spyOn(fake.globalState, 'update');

    try {
      await Effect.runPromise(
        runFlowWithLifecycle(ctx, async () =>
          toolUseResult(runId, runId, RUN_OUTCOME.COMPLETED),
        ),
      );

      expect(storageMocks.finalizeRun).toHaveBeenCalledOnce();
      expect(updateOnboarding).toHaveBeenCalledWith(
        GlobalStateKey.ONBOARDING_FIRST_RUN_DONE,
        true,
      );
      expect(storageMocks.finalizeRun.mock.invocationCallOrder[0]).toBeLessThan(
        updateOnboarding.mock.invocationCallOrder[0] ??
          Number.POSITIVE_INFINITY,
      );
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('finalizes the status machine owned by the run session', async () => {
    const { runId, runId, runStatus, ctx } = lifecycleFixture(
      'lifecycle-status-owner',
    );

    try {
      // The lifecycle owns the whole transition (RUNNING on entry, terminal
      // on exit) against the run session's one status machine.
      expect(runStatus).toBe(ctx.runScope.session.status);
      await Effect.runPromise(
        runFlowWithLifecycle(ctx, async () =>
          toolUseResult(runId, runId, RUN_OUTCOME.COMPLETED),
        ),
      );

      expect(runStatus.get(runId)).toBe(RUN_PHASE.COMPLETED);
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('projects run config before the RUNNING status projection', async () => {
    const { runId, runId, runStatus, ctx } = lifecycleFixture(
      'lifecycle-run-config-before-running',
    );
    publishTestRunStart(ctx.runScope.session, runId, runId);
    const trace = new TraceEmitter();
    const detachTrace = ctx.runScope.session.attachRunTrace(trace, runId);
    // One plane in commit order: run.config and the status fact both land
    // on it, so the ordering assertion reads one log.
    const recorded = recordSessionEvents(ctx.runScope.session);
    ctx.logger = trace;
    ctx.disposeTrace = detachTrace;

    try {
      await Effect.runPromise(
        runFlowWithLifecycle(ctx, async () =>
          toolUseResult(runId, runId, RUN_OUTCOME.COMPLETED),
        ),
      );

      const runConfigIndex = (await recorded.read()).findIndex(
        (event) => event.type === 'run.config',
      );
      const runningIndex = (await recorded.read()).findIndex(
        (event) =>
          event.type === 'status' &&
          event.aggregateId === qualifyAggregateId('stream', runId) &&
          event.phase === RUN_PHASE.RUNNING,
      );

      expect(runConfigIndex).toBeGreaterThanOrEqual(0);
      expect(runningIndex).toBeGreaterThanOrEqual(0);
      expect(runConfigIndex).toBeLessThan(runningIndex);
    } finally {
      detachTrace();
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('admits run start from a stale terminal phase via resume semantics', async () => {
    const { runId, runId, runStatus, ctx } = lifecycleFixture(
      'lifecycle-stale-terminal-start',
    );

    try {
      seedRunStatusForTest(runStatus, runId, {
        phase: RUN_PHASE.FAILED,
      });

      await Effect.runPromise(
        runFlowWithLifecycle(ctx, async () => {
          expect(runStatus.get(runId)).toBe(RUN_PHASE.RUNNING);
          return toolUseResult(runId, runId, RUN_OUTCOME.COMPLETED);
        }),
      );

      expect(runStatus.get(runId)).toBe(RUN_PHASE.COMPLETED);
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('clears a stale resuming substate when a resumed run starts', async () => {
    const { runId, runId, runStatus, ctx } = lifecycleFixture(
      'lifecycle-resuming-substate-start',
    );

    try {
      seedRunStatusForTest(runStatus, runId, {
        phase: RUN_PHASE.RUNNING,
        substate: RUN_SUBSTATE.RESUMING,
      });

      await Effect.runPromise(
        runFlowWithLifecycle(ctx, async () => {
          expect(runStatus.get(runId)).toBe(RUN_PHASE.RUNNING);
          expect(runStatus.getSubstate(runId)).toBeUndefined();
          return toolUseResult(runId, runId, RUN_OUTCOME.COMPLETED);
        }),
      );

      expect(runStatus.get(runId)).toBe(RUN_PHASE.COMPLETED);
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('does not emit a status event when starting an already-running stream with no substate', async () => {
    const { runId, runId, runStatus, ctx } = lifecycleFixture(
      'lifecycle-steady-running-no-substate',
    );

    const recorded = recordSessionEvents(ctx.runScope.session);
    try {
      seedRunStatusForTest(runStatus, runId, {
        phase: RUN_PHASE.RUNNING,
      });

      await Effect.runPromise(
        runFlowWithLifecycle(ctx, async () => {
          expect(runStatus.get(runId)).toBe(RUN_PHASE.RUNNING);
          expect(runStatus.getSubstate(runId)).toBeUndefined();
          expect(eventsOfType(await recorded.read(), 'status')).toEqual([]);
          return toolUseResult(runId, runId, RUN_OUTCOME.COMPLETED);
        }),
      );

      expect(runStatus.get(runId)).toBe(RUN_PHASE.COMPLETED);
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('delivers subagent aborts through the terminal callback', async () => {
    const { runId, runId, runStatus, ctx } = lifecycleFixture(
      'lifecycle-subagent-abort',
    );
    ctx.attachedMemoryMisses = [
      { path: '/memories/missing.md', reason: 'not found' },
    ];
    const onError = vi.fn();

    try {
      const result = await Effect.runPromise(
        runFlowWithLifecycle(
          ctx,
          async () => {
            throw new DOMException('Request aborted', 'AbortError');
          },
          { isSubagent: true, onError },
        ),
      );

      expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
      expect(result.memoryMisses).toEqual(ctx.attachedMemoryMisses);
      expect(runStatus.get(runId)).toBe(RUN_PHASE.CANCELLED);
      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0][1]).toEqual(result);
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('keeps subagent errors registered until terminal delivery runs', async () => {
    const { runId, runId, runStatus, ctx } = lifecycleFixture(
      'lifecycle-subagent-error-registered',
    );
    const onError = vi.fn(() => {
      expect(defaultSession().runs.getHandle(runId)).toBeDefined();
    });

    try {
      const result = await Effect.runPromise(
        runFlowWithLifecycle(
          ctx,
          async () => {
            throw new Error('subagent failed');
          },
          { isSubagent: true, onError },
        ),
      );

      expect(result.outcome).toBe(RUN_OUTCOME.FAILED);
      expect(runStatus.get(runId)).toBe(RUN_PHASE.FAILED);
      expect(onError).toHaveBeenCalledOnce();
      expect(
        defaultSession().runs.getHandle(runId),
      ).toBeUndefined();
    } finally {
      defaultSession().runs.untrack(runId);
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('keeps native subagent WAITING results registered and nonterminal', async () => {
    const { runId, runId, runStatus, ctx } = lifecycleFixture(
      'lifecycle-subagent-waiting',
    );
    const onError = vi.fn();
    await acquireResumedRunLease(runId);

    try {
      const result = await Effect.runPromise(
        runFlowWithLifecycle(
          ctx,
          async () => {
            expect(runStatus.get(runId)).toBe(RUN_PHASE.RUNNING);
            expect(
              runStatus.transition(runId, RUN_PHASE.WAITING, 'wait'),
            ).toBe(true);
            return waitingResult(runId, runId);
          },
          { isSubagent: true, onError },
        ),
      );

      expect(result.outcome).toBe(RUN_PHASE.WAITING);
      expect(storageMocks.finalizeRun).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(runStatus.get(runId)).toBe(RUN_PHASE.WAITING);
      expect(defaultSession().runs.getHandle(runId)).toBeDefined();
      await expect(inspectRunLease(runId)).resolves.toMatchObject({
        status: 'owned',
      });
    } finally {
      await releaseOwnedRunLease(runId);
      defaultSession().runs.untrack(runId);
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('does not let a stop abandon a run that completes without suspending', async () => {
    // The window a stop could once fall into: the run has returned, its live
    // interrupt context is detached, and its own finalize is parked at the
    // persist await with the handle still tracked. Only the WAITING branch
    // parks a handle, so there is no suspension for the stop to find and
    // nothing the exit has to remember to clear.
    const { runId, runId, runStatus, ctx } = lifecycleFixture(
      'lifecycle-completed-not-suspended',
    );
    const parked = parkNextFinalize();

    try {
      const running = Effect.runPromise(
        runFlowWithLifecycle(
          ctx,
          async () =>
            toolUseResult(runId, runId, RUN_OUTCOME.COMPLETED),
          { isSubagent: true },
        ),
      );
      await vi.waitFor(() => expect(parked.started()).toBe(true));

      const stop = defaultSession().runs.kill(runId);

      expect(stop.accepted).toBe(false);

      await Effect.runPromise(stop.settlement);

      parked.release();
      const result = await running;
      expect(result.outcome).toBe(RUN_OUTCOME.COMPLETED);
      expect(runStatus.get(runId)).toBe(RUN_PHASE.COMPLETED);
      expect(
        defaultSession().runs.getHandle(runId),
      ).toBeUndefined();
    } finally {
      defaultSession().runs.untrack(runId);
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('carries workflowPhase on the first child roster emission', async () => {
    const { runId, runId, runStatus, ctx } = lifecycleFixture(
      'lifecycle-workflow-phase',
    );
    const parentRunId = 'parent-lifecycle-workflow-phase' as RunId;
    const rosters = recordChildRosters(ctx.runScope.session.runs);
    // `track()` emits the roster synchronously, so onRun — which fires after
    // tracking — is structurally too late to stamp a display field.
    let rosterEmissionsBeforeOnRun = -1;

    try {
      await Effect.runPromise(
        runFlowWithLifecycle(
          ctx,
          async () =>
            toolUseResult(runId, runId, RUN_OUTCOME.COMPLETED),
          {
            isSubagent: true,
            parentRunId,
            workflowPhase: 'Reduce',
            onRun: async () => {
              rosterEmissionsBeforeOnRun = rosters.rosters.length;
            },
          },
        ),
      );

      const [firstRoster] = rosters.rosters;
      expect(firstRoster?.items).toEqual([
        expect.objectContaining({
          runId,
          childRunId: runId,
          workflowPhase: 'Reduce',
        }),
      ]);
      expect(rosterEmissionsBeforeOnRun).toBeGreaterThan(0);
    } finally {
      defaultSession().runs.untrack(runId);
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('carries a stop requested by onRun on the run signal', async () => {
    const { runId, runId, ctx } = lifecycleFixture(
      'lifecycle-early-stop',
    );

    const result = await Effect.runPromise(
      runFlowWithLifecycle(
        ctx,
        async () => {
          expect(defaultSession().status.get(runId)).toBe(
            RUN_PHASE.CANCELLED,
          );
          // linkAbortSignals has separate pre-aborted replay coverage; this
          // lifecycle test proves the signal already carries the early stop.
          expect(ctx.runScope.signal.aborted).toBe(true);
          return toolUseResult(runId, runId, RUN_OUTCOME.CANCELLED);
        },
        {
          onRun: async () => {
            const stop = defaultSession().runs.kill(runId);
            expect(stop.accepted).toBe(true);
            await Effect.runPromise(stop.settlement);
          },
        },
      ),
    );

    expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
  });

  // The stream is reused across runs, so a run that never claims it inherits
  // whatever the last one left. A stop landing in the track()-to-start window
  // is refused by the phase table while that leftover is terminal, so without
  // the start-time claim this run would adopt the previous run's COMPLETED as
  // its own verdict and drop its abort facts.
  it('does not adopt a previous run terminal phase when a stop lands before start', async () => {
    const { runId, runId, runStatus, ctx } = lifecycleFixture(
      'lifecycle-stale-phase-early-stop',
    );
    let terminalResult: AgentRunHandle['result'] | undefined;

    try {
      seedRunStatusForTest(runStatus, runId, {
        phase: RUN_PHASE.COMPLETED,
      });

      const result = await Effect.runPromise(
        runFlowWithLifecycle(
          ctx,
          async (handle) => {
            expect(ctx.runScope.signal.aborted).toBe(true);
            throw new DOMException('Request aborted', 'AbortError');
          },
          {
            onRun: async (handle) => {
              terminalResult = handle.result;
              const stop = defaultSession().runs.kill(runId);
              expect(stop.accepted).toBe(true);
              await Effect.runPromise(stop.settlement);
            },
          },
        ),
      );

      expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
      expect(runStatus.get(runId)).toBe(RUN_PHASE.CANCELLED);
      expect(storageMocks.finalizeRun).toHaveBeenCalledWith(
        defaultSession(),
        expect.objectContaining({
          outcome: RUN_OUTCOME.CANCELLED,
          flowRecord: 'preserve',
        }),
      );
      await expect(Effect.runPromise(terminalResult!)).resolves.toMatchObject({
        outcome: RUN_OUTCOME.CANCELLED,
        error: { kind: 'abort' },
      });
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });

  // The claim above is a repair for an inherited phase, not a second start: a
  // stop that already reads CANCELLED on the stream is this run's outcome too,
  // so a run that never ran must not publish a RUNNING blip on the way out.
  it('publishes no RUNNING blip when the stop that beat run start already cancelled the stream', async () => {
    const { runId, runId, runStatus, ctx } = lifecycleFixture(
      'lifecycle-early-stop-no-blip',
    );
    publishTestRunStart(ctx.runScope.session, runId, runId);
    const recorded = recordSessionEvents(ctx.runScope.session, {
      aggregateId: qualifyAggregateId('stream', runId),
    });

    try {
      const result = await Effect.runPromise(
        runFlowWithLifecycle(
          ctx,
          async () => {
            throw new DOMException('Request aborted', 'AbortError');
          },
          {
            onRun: async () => {
              const stop = defaultSession().runs.kill(runId);
              expect(stop.accepted).toBe(true);
              await Effect.runPromise(stop.settlement);
            },
          },
        ),
      );

      expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
      await ctx.runScope.session.settlePublications();
      expect(
        eventsOfType(await recorded.read(), 'status').map(
          (event) => event.phase,
        ),
      ).toEqual([RUN_PHASE.CANCELLED]);
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });

  // Outcome and flow-record disposition are one decision: a run the phase says
  // was interrupted keeps the record that makes it resumable, even when its own
  // report reached completion first.
  it('keeps the flow record of a stopped run whose report says completed', async () => {
    const { runId, runId, runStatus, ctx } = lifecycleFixture(
      'lifecycle-stop-during-completion',
    );

    try {
      const result = await Effect.runPromise(
        runFlowWithLifecycle(ctx, async () => {
          const stop = defaultSession().runs.kill(runId);
          expect(stop.accepted).toBe(true);
          await Effect.runPromise(stop.settlement);
          expect(runStatus.get(runId)).toBe(RUN_PHASE.CANCELLED);
          return toolUseResult(runId, runId, RUN_OUTCOME.COMPLETED);
        }),
      );

      // The caller receives the same verdict persistence carries: the stop
      // won on the stream, so the flow's COMPLETED report is relabeled.
      expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
      expect(storageMocks.finalizeRun).toHaveBeenCalledExactlyOnceWith(
        defaultSession(),
        expect.objectContaining({
          outcome: RUN_OUTCOME.CANCELLED,
          flowRecord: 'preserve',
        }),
      );
      expect(runStatus.get(runId)).toBe(RUN_PHASE.CANCELLED);
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });

  // The parent's delivery is a projection of the same terminal fact as the
  // persisted history, so a stopped child never arrives formatted as a failure.
  it('delivers a stopped subagent as cancelled when its flow reports a failure', async () => {
    const { runId, runId, runStatus, ctx } = lifecycleFixture(
      'lifecycle-subagent-stop-then-failure',
    );
    const onError = vi.fn();

    try {
      const result = await Effect.runPromise(
        runFlowWithLifecycle(
          ctx,
          async () => {
            const stop = defaultSession().runs.kill(runId);
            expect(stop.accepted).toBe(true);
            await Effect.runPromise(stop.settlement);
            throw new Error('child exited with code 143');
          },
          { isSubagent: true, onError },
        ),
      );

      expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
      expect(runStatus.get(runId)).toBe(RUN_PHASE.CANCELLED);
      expect(storageMocks.finalizeRun).toHaveBeenCalledWith(
        defaultSession(),
        expect.objectContaining({
          outcome: RUN_OUTCOME.CANCELLED,
        }),
      );
      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0][1]).toEqual(result);
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('lets a stop/kill tear down a subagent suspended at WAITING (issue #7287)', async () => {
    const { runId, runId, ctx } = lifecycleFixture(
      'lifecycle-subagent-waiting-kill',
    );
    const parentStageId = seedOpenRunGroup(ctx, runId);
    const recorded = recordSessionEvents(ctx.runScope.session, {
      aggregateId: qualifyAggregateId('stream', runId),
    });
    const followUpsTerminalize = vi.spyOn(
      ctx.runScope.session.followUps,
      'terminalize',
    );

    try {
      const result = await Effect.runPromise(
        runFlowWithLifecycle(
          ctx,
          async () => waitingResult(runId, runId),
          { isSubagent: true },
        ),
      );

      expect(result.outcome).toBe(RUN_PHASE.WAITING);
      expect(defaultSession().runs.getHandle(runId)).toBeDefined();
      expect(followUpsTerminalize).not.toHaveBeenCalled();
      expect(storageMocks.finalizeRun).not.toHaveBeenCalled();
      // The fixture's ctx.logger is noopTrace, and the run handle carries it
      // as its trace channel.
      const traceEmit = vi.spyOn(noopTrace, 'emit');

      const waitingHandle = takeWaitingHandle(runId);

      // runToolUseFlow's finally detaches this stream's interrupt handler but
      // preserves the follow-up queue for WAITING — it does not dispose the
      // session — by the time a native subagent suspends at WAITING (not
      // reproduced by this fake runner, but true in production — see
      // runToolUseFlow.ts). With no interrupt target left, `runs.kill()`
      // falls back to the teardown the WAITING branch parked and tears the
      // run down.
      const stop = defaultSession().runs.kill(runId);
      expect(stop.accepted).toBe(true);
      await Effect.runPromise(stop.settlement);
      await Effect.runPromise(waitingHandle.result);

      // The bypassed runFlowWithLifecycle can't emit the terminal result, so
      // terminateWaitingHandle must — trace subscribers would otherwise miss
      // the stop entirely.
      expect(traceEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'result',
          outcome: 'cancelled',
          runId,
        }),
      );
      traceEmit.mockRestore();

      expect(
        defaultSession().runs.getHandle(runId),
      ).toBeUndefined();
      expect(defaultSession().status.get(runId)).toBe(
        RUN_PHASE.CANCELLED,
      );
      expect(followUpsTerminalize).toHaveBeenCalledWith(runId);
      await vi.waitFor(() =>
        expect(storageMocks.finalizeRun).toHaveBeenCalledWith(
          defaultSession(),
          {
            runId,
            outcome: RUN_OUTCOME.CANCELLED,
            // Killing a WAITING subagent leaves the checkpoint that makes it
            // resumable (#11315).
            flowRecord: 'preserve',
          },
        ),
      );
      // The detached trace cannot publish this close. The suspended owner
      // must append it to the same session event stream before releasing.
      await ctx.runScope.session.settlePublications();
      expect(eventsOfType(await recorded.read(), 'stage.end')).toContainEqual(
        expect.objectContaining({
          id: parentStageId,
          status: RUN_OUTCOME.CANCELLED,
        }),
      );
    } finally {
      defaultSession().runs.untrack(runId);
      clearRunStatusForTest(defaultSession().status, runId);
    }
  });

  it('runs run-end cleanup when waiting stage publication fails', async () => {
    const { runId, runId, ctx } = lifecycleFixture(
      'lifecycle-waiting-transcript-failure-run-end',
    );
    const stopSessionsForRun = vi.fn(async (_runId: RunId) => {});
    seedOpenRunGroup(ctx, runId);
    await ctx.runScope.session.settlePublications();
    vi.spyOn(ctx.runScope.session, 'settlePublications').mockRejectedValueOnce(
      new Error('stage publication failed'),
    );

    try {
      const result = await Effect.runPromise(
        runFlowWithLifecycle(
          ctx,
          async () => waitingResult(runId, runId),
          { onRunEnd: stopSessionsForRun },
        ),
      );
      expect(result.outcome).toBe(RUN_PHASE.WAITING);
      const waitingHandle = takeWaitingHandle(runId);

      const stop = defaultSession().runs.kill(runId);

      expect(stop.accepted).toBe(true);

      await Effect.runPromise(stop.settlement);
      await Effect.runPromise(waitingHandle.result);

      expect(stopSessionsForRun).toHaveBeenCalledWith(runId);
    } finally {
      defaultSession().runs.untrack(runId);
      clearRunStatusForTest(defaultSession().status, runId);
    }
  });

  it('projects returned outcomes to terminal status, stage end, and stream status', async () => {
    const cases = [
      {
        outcome: RUN_OUTCOME.COMPLETED,
        stream: RUN_PHASE.COMPLETED,
      },
      {
        outcome: RUN_OUTCOME.CANCELLED,
        stream: RUN_PHASE.CANCELLED,
      },
      {
        outcome: RUN_OUTCOME.FAILED,
        stream: RUN_PHASE.FAILED,
      },
    ] as const;

    for (const expected of cases) {
      const { runId, runId, runStatus, ctx } = lifecycleFixture(
        `outcome-${expected.outcome}`,
      );
      const stageEnd = vi.spyOn(ctx.parentStage, 'end');

      try {
        const result = await Effect.runPromise(
          runFlowWithLifecycle(ctx, async () =>
            toolUseResult(runId, runId, expected.outcome),
          ),
        );

        expect(result.outcome).toBe(expected.outcome);
        expect(storageMocks.finalizeRun).toHaveBeenCalledWith(
          defaultSession(),
          {
            runId,
            outcome: expected.outcome,
            flowRecord:
              expected.outcome === RUN_OUTCOME.COMPLETED
                ? 'delete'
                : 'preserve',
          },
        );
        expect(stageEnd).toHaveBeenCalledWith(expected.outcome);
        expect(runStatus.get(runId)).toBe(expected.stream);
      } finally {
        clearRunStatusForTest(runStatus, runId);
      }
    }
  });

  it('finalizes an outcome-only failure without fabricating provider error facts', async () => {
    const { runId, runId, runStatus, ctx } = lifecycleFixture(
      'outcome-only-failure',
    );
    const stageEnd = vi.spyOn(ctx.parentStage, 'end');
    const emit = vi.spyOn(ctx.logger, 'emit');
    const onError = vi.fn();

    try {
      const carriedResult = toolUseResult(
        runId,
        runId,
        RUN_OUTCOME.FAILED,
      );
      const result = await Effect.runPromise(
        runFlowWithLifecycle(ctx, async () => carriedResult, {
          isSubagent: true,
          onError,
        }),
      );

      expect(result).toEqual(carriedResult);
      expect(storageMocks.finalizeRun).toHaveBeenCalledWith(defaultSession(), {
        runId,
        outcome: RUN_OUTCOME.FAILED,
        flowRecord: 'preserve',
      });
      expect(stageEnd).toHaveBeenCalledWith(RUN_OUTCOME.FAILED);
      expect(runStatus.get(runId)).toBe(RUN_PHASE.FAILED);
      const resultEvent = emit.mock.calls
        .map(([event]) => event)
        .find((event) => event.type === 'result');
      expect(resultEvent).toMatchObject({
        type: 'result',
        outcome: RUN_OUTCOME.FAILED,
      });
      expect(resultEvent).not.toHaveProperty('error');
      expect(onError).not.toHaveBeenCalled();
    } finally {
      emit.mockRestore();
      defaultSession().runs.untrack(runId);
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('projects a thrown abort as cancelled on its own stage outcome', async () => {
    const { runId, runId, runStatus, ctx } = lifecycleFixture(
      'outcome-thrown-abort',
    );
    const stageEnd = vi.spyOn(ctx.parentStage, 'end');

    try {
      const result = await Effect.runPromise(
        runFlowWithLifecycle(ctx, async () => {
          throw new DOMException('Request aborted', 'AbortError');
        }),
      );

      expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
      expect(storageMocks.finalizeRun).toHaveBeenCalledWith(defaultSession(), {
        runId,
        outcome: RUN_OUTCOME.CANCELLED,
        flowRecord: 'preserve',
      });
      expect(stageEnd).toHaveBeenCalledWith(RUN_OUTCOME.CANCELLED);
      expect(runStatus.get(runId)).toBe(RUN_PHASE.CANCELLED);
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('projects an unexpected throw as failed', async () => {
    const { runId, runId, runStatus, ctx } = lifecycleFixture(
      'outcome-thrown-error',
    );
    const stageEnd = vi.spyOn(ctx.parentStage, 'end');

    try {
      await expect(
        Effect.runPromise(
          runFlowWithLifecycle(ctx, async () => {
            throw new Error('model exploded');
          }),
        ),
      ).rejects.toThrow('model exploded');

      expect(storageMocks.finalizeRun).toHaveBeenCalledWith(defaultSession(), {
        runId,
        outcome: RUN_OUTCOME.FAILED,
        flowRecord: 'preserve',
      });
      expect(stageEnd).toHaveBeenCalledWith(RUN_OUTCOME.FAILED);
      expect(runStatus.get(runId)).toBe(RUN_PHASE.FAILED);
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('terminalizes a waiting stream when the lifecycle catch path fails', async () => {
    const { runId, runStatus, ctx } = lifecycleFixture(
      'outcome-waiting-thrown-error',
    );

    try {
      await expect(
        Effect.runPromise(
          runFlowWithLifecycle(ctx, async () => {
            expect(
              runStatus.transition(runId, RUN_PHASE.WAITING, 'wait'),
            ).toBe(true);
            throw new Error('wait node failed');
          }),
        ),
      ).rejects.toThrow('wait node failed');

      expect(runStatus.get(runId)).toBe(RUN_PHASE.FAILED);
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('passes flow-carried terminal results to subagent error delivery', async () => {
    const { runId, runId, runStatus, ctx } = lifecycleFixture(
      'lifecycle-subagent-flow-error',
    );
    const carriedResult = {
      category: 'toolUse' as const,
      outcome: RUN_OUTCOME.FAILED,
      runId,
      runId,
      totalCostUsd: 0.73,
      error: { message: 'subagent failed', userRetryable: false },
    };
    const onError = vi.fn();

    try {
      seedRunStatusForTest(runStatus, runId, {
        phase: RUN_PHASE.RUNNING,
      });

      const result = await Effect.runPromise(
        runFlowWithLifecycle(ctx, async () => carriedResult, {
          isSubagent: true,
          onError,
        }),
      );

      expect(result).toEqual(carriedResult);
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'subagent failed' }),
        carriedResult,
      );
    } finally {
      defaultSession().runs.untrack(runId);
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('publishes the structured error facts a flow carried out on its result', async () => {
    const { runId, runId, runStatus, ctx } = lifecycleFixture(
      'lifecycle-carried-flow-error',
    );
    const stageEnd = vi.spyOn(ctx.parentStage, 'end');
    const emit = vi.spyOn(ctx.logger, 'emit');

    try {
      await expect(
        Effect.runPromise(
          runFlowWithLifecycle(ctx, async () => ({
            category: 'toolUse' as const,
            outcome: RUN_OUTCOME.FAILED,
            runId,
            runId,
            response: 'partial answer',
            error: {
              message: 'provider exploded',
              userRetryable: true,
              statusCode: 503,
            },
          })),
        ),
      ).rejects.toThrow('provider exploded');

      // A carried failure is exactly as loud as a thrown one: same terminal
      // status, same stage outcome, same classified error on the result event.
      expect(storageMocks.finalizeRun).toHaveBeenCalledWith(defaultSession(), {
        runId,
        outcome: RUN_OUTCOME.FAILED,
        flowRecord: 'preserve',
      });
      expect(stageEnd).toHaveBeenCalledWith(RUN_OUTCOME.FAILED);
      expect(runStatus.get(runId)).toBe(RUN_PHASE.FAILED);
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'result',
          outcome: RUN_OUTCOME.FAILED,
          error: expect.objectContaining({
            kind: 'unexpected',
            statusCode: 503,
            userRetryable: true,
          }),
        }),
      );
    } finally {
      emit.mockRestore();
      defaultSession().runs.untrack(runId);
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('classifies a carried missing-api-key failure through the canonical discriminant', async () => {
    const { runId, runId, ctx } = lifecycleFixture(
      'lifecycle-carried-missing-key',
    );
    const emit = vi.spyOn(ctx.logger, 'emit');

    try {
      await expect(
        Effect.runPromise(
          runFlowWithLifecycle(ctx, async () => ({
            category: 'toolUse' as const,
            outcome: RUN_OUTCOME.FAILED,
            runId,
            runId,
            response: '',
            // The retry-state flatten drops the Error and its Symbol marker;
            // the canonical classification keeps the kind reachable here.
            error: {
              message: 'Missing OpenRouter API key.',
              userRetryable: false,
              classification: { kind: 'missing-api-key' as const },
            },
          })),
        ),
      ).rejects.toThrow('Missing OpenRouter API key.');

      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'result',
          outcome: RUN_OUTCOME.FAILED,
          error: expect.objectContaining({ kind: 'missing-api-key' }),
        }),
      );
    } finally {
      emit.mockRestore();
      defaultSession().runs.untrack(runId);
    }
  });
});

/** The handle, status machine, and untrack spy every finalize test drives. */
function finalizeFixture(slug: string): {
  runId: string;
  runId: RunId;
  runStatus: RunStatusMachine;
  handle: ReturnType<typeof testRunHandle>;
  untrack: Mock<(runId: string) => void>;
} {
  const runId = `exec-${slug}`;
  const runId = `stream-${slug}` as RunId;
  return {
    runId,
    runId,
    runStatus: new RunStatusMachine(
      () => {},
      () => {},
    ),
    handle: testRunHandle({
      runId,
      parentRunId: runId,
      agent: 'test-agent',
      trace: noopTrace,
    }),
    untrack: vi.fn<(runId: string) => void>(),
  };
}

describe('finalizeRunTerminal', () => {
  // The exactly-once guard must be an atomic, synchronous claim — not a
  // check-then-await on the settled flag. Two finalizers racing across the
  // persist await (e.g. a lifecycle arm vs a concurrent finalize of the same
  // handle) would otherwise both pass the check before the first settles and
  // double-publish persist/emit/settle/untrack.
  it('finalizes exactly once when two callers race across the persist await', async () => {
    const { runId, runId, runStatus, handle, untrack } =
      finalizeFixture('finalize-race');
    const traceEmit = vi.spyOn(noopTrace, 'emit');
    // Park the first caller at its persist await so the second caller arrives
    // while the first has not yet emitted or settled anything.
    const parked = parkNextFinalize();

    try {
      seedRunStatusForTest(runStatus, runId, {
        phase: RUN_PHASE.RUNNING,
      });
      const params = {
        session: defaultSession(),
        handle,
        executions: { untrack },
        runStatus,
        outcome: RUN_OUTCOME.COMPLETED,
        isSubagent: false,
        trace: noopTrace,
        persistence: { kind: 'finalize', flowRecord: 'delete' },
      } as const;

      const first = Effect.runPromise(finalizeRunTerminal(params));
      const second = Effect.runPromise(finalizeRunTerminal(params));

      // The loser no-ops without waiting on (or duplicating) the persist.
      await expect(second).resolves.toBeUndefined();
      expect(parked.started()).toBe(true);
      parked.release();
      const event = await first;

      expect(event).toMatchObject({
        event: {
          type: 'result',
          outcome: RUN_OUTCOME.COMPLETED,
          runId,
          runId,
        },
      });
      expect(storageMocks.finalizeRun).toHaveBeenCalledTimes(1);
      // The stream-status transition also emits on the trace; the terminal
      // `result` event itself must be published exactly once.
      expect(
        traceEmit.mock.calls.filter(
          ([emitted]) => (emitted as { type: string }).type === 'result',
        ),
      ).toHaveLength(1);
      expect(untrack).toHaveBeenCalledTimes(1);
      await expect(Effect.runPromise(handle.result)).resolves.toBe(
        event?.event,
      );
      expect(runStatus.get(runId)).toBe(RUN_PHASE.COMPLETED);
    } finally {
      traceEmit.mockRestore();
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('flushes display artifacts before publishing and untracking', async () => {
    const { runId, runId, runStatus, handle, untrack } =
      finalizeFixture('finalize-artifact-order');
    let releaseFlush: (() => void) | undefined;
    const flushArtifacts = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseFlush = resolve;
        }),
    );
    let resultSettled = false;
    void Effect.runPromise(handle.result).then(() => {
      resultSettled = true;
    });

    try {
      seedRunStatusForTest(runStatus, runId, {
        phase: RUN_PHASE.RUNNING,
      });
      const finalization = Effect.runPromise(
        finalizeRunTerminal({
          session: defaultSession(),
          handle,
          executions: { untrack },
          runStatus,
          outcome: RUN_OUTCOME.COMPLETED,
          isSubagent: false,
          trace: noopTrace,
          persistence: { kind: 'skip' },
          flushArtifacts,
        }),
      );

      await vi.waitFor(() => expect(flushArtifacts).toHaveBeenCalledOnce());
      expect(resultSettled).toBe(false);
      expect(untrack).not.toHaveBeenCalled();

      releaseFlush?.();
      await finalization;

      expect(resultSettled).toBe(true);
      expect(untrack).toHaveBeenCalledExactlyOnceWith(runId);
      expect(runStatus.get(runId)).toBe(RUN_PHASE.COMPLETED);
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('settles and untracks once while reporting terminal metadata failure', async () => {
    const { runId, runId, runStatus, handle, untrack } =
      finalizeFixture('finalize-metadata-failure');
    const durabilityError = new Error('metadata disk write failed');
    storageMocks.finalizeRun.mockReturnValueOnce(
      Effect.succeed({
        ok: false,
        outcomePersisted: false,
        error: durabilityError,
      }),
    );

    try {
      seedRunStatusForTest(runStatus, runId, {
        phase: RUN_PHASE.RUNNING,
      });

      const event = await Effect.runPromise(
        finalizeRunTerminal({
          session: defaultSession(),
          handle,
          executions: { untrack },
          runStatus,
          outcome: RUN_OUTCOME.FAILED,
          isSubagent: false,
          trace: noopTrace,
          persistence: { kind: 'finalize', flowRecord: 'preserve' },
        }),
      );

      expect(event).toMatchObject({
        event: {
          type: 'result',
          outcome: RUN_OUTCOME.FAILED,
          runId,
        },
      });
      await expect(Effect.runPromise(handle.result)).resolves.toBe(
        event?.event,
      );
      expect(untrack).toHaveBeenCalledExactlyOnceWith(runId);
      expect(runStatus.get(runId)).toBe(RUN_PHASE.FAILED);
      expect(channelTraceMocks.warn).toHaveBeenCalledExactlyOnceWith(
        'Failed to finalize durable run state',
        {
          data: {
            agentIdentifier: 'test-agent',
            runId,
            outcomePersisted: false,
            error: durabilityError,
          },
        },
      );
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });

  // The stream phase is the single owner of a run's terminal outcome. A
  // stop/kill transitions the phase behind the run's back, and the run it
  // killed then reports its own non-zero exit as a failure — so the phase, not
  // the report, has to decide, and no caller may cross-check it for itself.
  it('resolves the terminal outcome from an already-cancelled stream phase', async () => {
    const { runId, runId, runStatus, handle, untrack } =
      finalizeFixture('finalize-stopped');
    const stage = { end: vi.fn() };

    try {
      seedRunStatusForTest(runStatus, runId, {
        phase: RUN_PHASE.CANCELLED,
      });

      const finalized = await Effect.runPromise(
        finalizeRunTerminal({
          session: defaultSession(),
          handle,
          executions: { untrack },
          runStatus,
          outcome: RUN_OUTCOME.FAILED,
          error: { kind: 'unexpected', message: 'exited with code 143' },
          isSubagent: false,
          stage,
          trace: noopTrace,
          persistence: { kind: 'finalize', flowRecord: 'delete' },
        }),
      );

      expect(finalized?.event).toMatchObject({
        type: 'result',
        outcome: RUN_OUTCOME.CANCELLED,
        runId,
        runId,
      });
      // Error facts classified for a failure that the phase says never
      // happened must not ride the cancelled result.
      expect(finalized?.event.error).toBeUndefined();
      await expect(Effect.runPromise(handle.result)).resolves.toBe(
        finalized?.event,
      );
      expect(stage.end).toHaveBeenCalledExactlyOnceWith(RUN_OUTCOME.CANCELLED);
      expect(storageMocks.finalizeRun).toHaveBeenCalledWith(
        defaultSession(),
        expect.objectContaining({
          outcome: RUN_OUTCOME.CANCELLED,
        }),
      );
      expect(runStatus.get(runId)).toBe(RUN_PHASE.CANCELLED);
      // The resolution is what keeps the terminal transition from being
      // refused, so nothing is left to warn about.
      expect(channelTraceMocks.warn).not.toHaveBeenCalled();
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });

  // The same ownership rule in the other direction: a phase that already
  // published FAILED is a terminal fact a later stop cannot rewrite, so a
  // caller reporting `cancelled` does not get to relabel it.
  it('keeps an already-failed stream phase over a later cancelled report', async () => {
    const { runId, runId, runStatus, handle, untrack } =
      finalizeFixture('finalize-failed-then-stopped');

    try {
      seedRunStatusForTest(runStatus, runId, {
        phase: RUN_PHASE.FAILED,
      });

      const finalized = await Effect.runPromise(
        finalizeRunTerminal({
          session: defaultSession(),
          handle,
          executions: { untrack },
          runStatus,
          outcome: RUN_OUTCOME.CANCELLED,
          isSubagent: false,
          trace: noopTrace,
          persistence: { kind: 'skip' },
        }),
      );

      expect(finalized?.event).toMatchObject({
        type: 'result',
        outcome: RUN_OUTCOME.FAILED,
        runId,
        runId,
      });
      expect(runStatus.get(runId)).toBe(RUN_PHASE.FAILED);
      expect(channelTraceMocks.warn).not.toHaveBeenCalled();
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });
});
