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
import { RunHandle } from '@agent/runtime/RunHandle';
import {
  defaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
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
import type { RunId, RunOutcome } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { testRunHandle } from '@test/support/runHandleFixtures';
import {
  fakeProcessServices,
  installPlatform,
} from '@test/support/setupPlatform';
import {
  clearRunStatusForTest,
  seedRunStatusForTest,
} from '@test/support/runStatusTestUtils';
import { generateRunId } from '@utils/core';

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
  ...(await importOriginal<typeof import('@agent/storage/runLifecycle')>()),
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
  agent = 'test-agent',
  category: AgentCategory = AgentCategory.ToolUse,
): {
  runId: RunId;
  runStatus: RunStatusMachine;
  ctx: AgentLaunchContext;
} {
  const runId =
    `e${(lifecycleFixtureCounter++).toString(16).padStart(5, '0')}` as RunId;
  return {
    runId,
    runStatus: defaultSession().status,
    ctx: createTestLaunchContext({ runId, agent, category }),
  };
}

/** The launching run a subagent fixture names as its parent edge. */
const PARENT_RUN_ID = 'aa0001' as RunId;

/** What a tool-use run that produced no output ends with on its `run.end`. */
const EMPTY_TOOL_USE_OUTPUT = {
  category: 'toolUse',
  response: '',
  files: [],
} as const;

function toolUseResult(runId: RunId, outcome: RunOutcome): ToolUseFlowResult {
  return { outcome, runId, output: { ...EMPTY_TOOL_USE_OUTPUT, files: [] } };
}

function workflowResult(runId: RunId, outcome: RunOutcome): WorkflowFlowResult {
  return {
    outcome,
    runId,
    output: {
      category: 'workflow',
      outputs: [],
      compileFailures: [],
      diffs: [],
    },
  };
}

function waitingResult(runId: RunId): WaitingToolUseFlowResult {
  return {
    outcome: RUN_PHASE.WAITING,
    runId,
    output: { ...EMPTY_TOOL_USE_OUTPUT, files: [] },
  };
}

/**
 * Returns the suspended handle for a run that reported WAITING.
 *
 * The fake runners below return the WAITING outcome without driving the real
 * `transitionToWaiting()`, so the run phase never reaches WAITING here —
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
function seedOpenRunGroup(ctx: AgentLaunchContext, runId: RunId): string {
  const parentStageId = ctx.parentStage.id;
  if (!parentStageId)
    throw new Error('The fixture parent stage must carry an id.');
  const session = ctx.runScope.session;
  publishTestRunStart(session, runId);
  session.publishRunEvent(runId, {
    type: 'stage.start',
    id: parentStageId,
    label: 'run',
    kind: 'run',
  });
  return parentStageId;
}

/**
 * The lifecycle program over the fake host's process services. The suite runs
 * it on the default runtime rather than a process runtime, so the services it
 * requires are provided here.
 */
function runFlow(...args: Parameters<typeof runFlowWithLifecycle>) {
  return Effect.provide(runFlowWithLifecycle(...args), fakeProcessServices());
}

describe('runFlowWithLifecycle', () => {
  // The run's category reaches the handle and the terminal `result` through
  // the one descriptor the lifecycle builds, so a workflow run reports
  // `workflow` on both without either side re-deriving the string.

  it('does not stop the Lean servers when a tool-use run parks at WAITING', async () => {
    const { runId, runStatus, ctx } = lifecycleFixture();
    const stopSessionsForRun = vi.fn(async (_runId: RunId) => {});

    try {
      const result = await Effect.runPromise(
        runFlow(ctx, () => Effect.succeed(waitingResult(runId)), {
          onRunEnd: stopSessionsForRun,
        }),
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
      agent: agentKey('builtInToolUse', SETUP_AGENT_NAME),
      expectedDone: false,
    },
    {
      label: 'completes first-run onboarding for non-setup completed sessions',
      agent: 'assistant',
      expectedDone: true,
    },
  ] as const;

  for (const { label, agent, expectedDone } of onboardingCases) {
    it(label, async () => {
      const fake = await initLifecycleTestPlatform(false);
      const { runId, runStatus, ctx } = lifecycleFixture(agent);

      try {
        await Effect.runPromise(
          runFlow(ctx, () =>
            Effect.succeed(toolUseResult(runId, RUN_OUTCOME.COMPLETED)),
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

  it('projects run config before the RUNNING status projection', async () => {
    const { runId, runStatus, ctx } = lifecycleFixture();
    publishTestRunStart(ctx.runScope.session, runId);
    const trace = new TraceEmitter();
    const detachTrace = ctx.runScope.session.attachRunTrace(trace, runId);
    // One plane in commit order: run.config and the status fact both land
    // on it, so the ordering assertion reads one log.
    const recorded = recordSessionEvents(ctx.runScope.session);
    ctx.logger = trace;
    ctx.disposeTrace = detachTrace;

    try {
      await Effect.runPromise(
        runFlow(ctx, () =>
          Effect.succeed(toolUseResult(runId, RUN_OUTCOME.COMPLETED)),
        ),
      );

      const runConfigIndex = (await recorded.read()).findIndex(
        (event) => event.type === 'run.config',
      );
      const runningIndex = (await recorded.read()).findIndex(
        (event) =>
          event.type === 'status' &&
          event.aggregateId === qualifyAggregateId('run', runId) &&
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
    const { runId, runStatus, ctx } = lifecycleFixture();

    try {
      seedRunStatusForTest(runStatus, runId, {
        phase: RUN_PHASE.FAILED,
      });

      await Effect.runPromise(
        runFlow(ctx, () =>
          Effect.sync(() => {
            expect(runStatus.get(runId)).toBe(RUN_PHASE.RUNNING);
            return toolUseResult(runId, RUN_OUTCOME.COMPLETED);
          }),
        ),
      );

      expect(runStatus.get(runId)).toBe(RUN_PHASE.COMPLETED);
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('clears a stale resuming substate when a resumed run starts', async () => {
    const { runId, runStatus, ctx } = lifecycleFixture();

    try {
      seedRunStatusForTest(runStatus, runId, {
        phase: RUN_PHASE.RUNNING,
        substate: RUN_SUBSTATE.RESUMING,
      });

      await Effect.runPromise(
        runFlow(ctx, () =>
          Effect.sync(() => {
            expect(runStatus.get(runId)).toBe(RUN_PHASE.RUNNING);
            expect(runStatus.getSubstate(runId)).toBeUndefined();
            return toolUseResult(runId, RUN_OUTCOME.COMPLETED);
          }),
        ),
      );

      expect(runStatus.get(runId)).toBe(RUN_PHASE.COMPLETED);
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('does not emit a status event when starting an already-running run with no substate', async () => {
    const { runId, runStatus, ctx } = lifecycleFixture();

    const recorded = recordSessionEvents(ctx.runScope.session);
    try {
      seedRunStatusForTest(runStatus, runId, {
        phase: RUN_PHASE.RUNNING,
      });

      await Effect.runPromise(
        runFlow(ctx, () =>
          Effect.gen(function* () {
            expect(runStatus.get(runId)).toBe(RUN_PHASE.RUNNING);
            expect(runStatus.getSubstate(runId)).toBeUndefined();
            const published = yield* Effect.promise(() => recorded.read());
            expect(eventsOfType(published, 'status')).toEqual([]);
            return toolUseResult(runId, RUN_OUTCOME.COMPLETED);
          }),
        ),
      );

      expect(runStatus.get(runId)).toBe(RUN_PHASE.COMPLETED);
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('delivers subagent aborts through the terminal callback', async () => {
    const { runId, runStatus, ctx } = lifecycleFixture();
    ctx.attachedMemoryMisses = [
      { path: '/memories/missing.md', reason: 'not found' },
    ];
    const onError = vi.fn();

    try {
      const result = await Effect.runPromise(
        runFlow(
          ctx,
          () => Effect.fail(new DOMException('Request aborted', 'AbortError')),
          { parentRunId: PARENT_RUN_ID, onError },
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
    const { runId, runStatus, ctx } = lifecycleFixture();
    const onError = vi.fn(() => {
      expect(defaultSession().runs.getHandle(runId)).toBeDefined();
    });

    try {
      const result = await Effect.runPromise(
        runFlow(ctx, () => Effect.fail(new Error('subagent failed')), {
          parentRunId: PARENT_RUN_ID,
          onError,
        }),
      );

      expect(result.outcome).toBe(RUN_OUTCOME.FAILED);
      expect(runStatus.get(runId)).toBe(RUN_PHASE.FAILED);
      expect(onError).toHaveBeenCalledOnce();
      expect(defaultSession().runs.getHandle(runId)).toBeUndefined();
    } finally {
      defaultSession().runs.untrack(runId);
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('keeps native subagent WAITING results registered and nonterminal', async () => {
    const { runId, runStatus, ctx } = lifecycleFixture();
    const onError = vi.fn();
    await acquireResumedRunLease(runId);

    try {
      const result = await Effect.runPromise(
        runFlow(
          ctx,
          () =>
            Effect.sync(() => {
              expect(runStatus.get(runId)).toBe(RUN_PHASE.RUNNING);
              expect(
                runStatus.transition(runId, RUN_PHASE.WAITING, 'wait'),
              ).toBe(true);
              return waitingResult(runId);
            }),
          { parentRunId: PARENT_RUN_ID, onError },
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
    const { runId, runStatus, ctx } = lifecycleFixture();
    const parked = parkNextFinalize();

    try {
      const running = Effect.runPromise(
        runFlow(
          ctx,
          () => Effect.succeed(toolUseResult(runId, RUN_OUTCOME.COMPLETED)),
          { parentRunId: PARENT_RUN_ID },
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
      expect(defaultSession().runs.getHandle(runId)).toBeUndefined();
    } finally {
      defaultSession().runs.untrack(runId);
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('carries workflowPhase on the first child roster emission', async () => {
    const { runId, runStatus, ctx } = lifecycleFixture();
    const parentRunId = generateRunId();
    const rosters = recordChildRosters(ctx.runScope.session.runs);
    // `track()` emits the roster synchronously, so onRun — which fires after
    // tracking — is structurally too late to stamp a display field.
    let rosterEmissionsBeforeOnRun = -1;

    try {
      await Effect.runPromise(
        runFlow(
          ctx,
          () => Effect.succeed(toolUseResult(runId, RUN_OUTCOME.COMPLETED)),
          {
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
    const { runId, ctx } = lifecycleFixture();

    const result = await Effect.runPromise(
      runFlow(
        ctx,
        () =>
          Effect.sync(() => {
            expect(defaultSession().status.get(runId)).toBe(
              RUN_PHASE.CANCELLED,
            );
            // linkAbortSignals has separate pre-aborted replay coverage; this
            // lifecycle test proves the signal already carries the early stop.
            expect(ctx.runScope.signal.aborted).toBe(true);
            return toolUseResult(runId, RUN_OUTCOME.CANCELLED);
          }),
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

  // The status record is reused across runs, so a run that never claims it
  // inherits whatever the last one left. A stop landing in the track()-to-start
  // window is refused by the phase table while that leftover is terminal, so
  // without the start-time claim this run would adopt the previous run's
  // COMPLETED as its own verdict and drop its abort facts.
  it('does not adopt a previous run terminal phase when a stop lands before start', async () => {
    const { runId, runStatus, ctx } = lifecycleFixture();

    try {
      seedRunStatusForTest(runStatus, runId, {
        phase: RUN_PHASE.COMPLETED,
      });

      const result = await Effect.runPromise(
        runFlow(
          ctx,
          () =>
            Effect.gen(function* () {
              expect(ctx.runScope.signal.aborted).toBe(true);
              return yield* Effect.fail(
                new DOMException('Request aborted', 'AbortError'),
              );
            }),
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
      expect(runStatus.get(runId)).toBe(RUN_PHASE.CANCELLED);
      expect(storageMocks.finalizeRun).toHaveBeenCalledWith(
        defaultSession(),
        expect.objectContaining({
          outcome: RUN_OUTCOME.CANCELLED,
          error: expect.objectContaining({ kind: 'abort' }),
        }),
      );
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });

  // The claim above is a repair for an inherited phase, not a second start: a
  // stop that already reads CANCELLED on the run is this run's outcome too,
  // so a run that never ran must not publish a RUNNING blip on the way out.
  it('publishes no RUNNING blip when the stop that beat run start already cancelled the run', async () => {
    const { runId, runStatus, ctx } = lifecycleFixture();
    publishTestRunStart(ctx.runScope.session, runId);
    const recorded = recordSessionEvents(ctx.runScope.session, {
      aggregateId: qualifyAggregateId('run', runId),
    });

    try {
      const result = await Effect.runPromise(
        runFlow(
          ctx,
          () => Effect.fail(new DOMException('Request aborted', 'AbortError')),
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
      // The terminal phase is `run.end`'s, so a run that never ran publishes
      // no status row at all.
      expect(eventsOfType(await recorded.read(), 'status')).toEqual([]);
      expect(storageMocks.finalizeRun).toHaveBeenCalledWith(defaultSession(), {
        runId,
        outcome: RUN_OUTCOME.CANCELLED,
        error: {
          kind: 'abort',
          message: 'Request aborted',
          userRetryable: false,
        },
        usage: undefined,
        output: EMPTY_TOOL_USE_OUTPUT,
      });
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });

  // The phase owns the outcome: a run the phase says was interrupted ends
  // cancelled, even when its own report reached completion first.
  it('relabels a stopped run whose report says completed', async () => {
    const { runId, runStatus, ctx } = lifecycleFixture();

    try {
      const result = await Effect.runPromise(
        runFlow(ctx, () =>
          Effect.gen(function* () {
            const stop = defaultSession().runs.kill(runId);
            expect(stop.accepted).toBe(true);
            yield* stop.settlement;
            expect(runStatus.get(runId)).toBe(RUN_PHASE.CANCELLED);
            return toolUseResult(runId, RUN_OUTCOME.COMPLETED);
          }),
        ),
      );

      // The caller receives the same verdict persistence carries: the stop
      // won on the run, so the flow's COMPLETED report is relabeled.
      expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
      expect(storageMocks.finalizeRun).toHaveBeenCalledExactlyOnceWith(
        defaultSession(),
        expect.objectContaining({
          outcome: RUN_OUTCOME.CANCELLED,
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
    const { runId, runStatus, ctx } = lifecycleFixture();
    const onError = vi.fn();

    try {
      const result = await Effect.runPromise(
        runFlow(
          ctx,
          () =>
            Effect.gen(function* () {
              const stop = defaultSession().runs.kill(runId);
              expect(stop.accepted).toBe(true);
              yield* stop.settlement;
              return yield* Effect.fail(
                new Error('child exited with code 143'),
              );
            }),
          { parentRunId: PARENT_RUN_ID, onError },
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
    const { runId, ctx } = lifecycleFixture();
    const parentStageId = seedOpenRunGroup(ctx, runId);
    const recorded = recordSessionEvents(ctx.runScope.session, {
      aggregateId: qualifyAggregateId('run', runId),
    });
    const followUpsTerminalize = vi.spyOn(
      ctx.runScope.session.followUps,
      'terminalize',
    );

    try {
      const result = await Effect.runPromise(
        runFlow(ctx, () => Effect.succeed(waitingResult(runId)), {
          parentRunId: PARENT_RUN_ID,
        }),
      );

      expect(result.outcome).toBe(RUN_PHASE.WAITING);
      expect(defaultSession().runs.getHandle(runId)).toBeDefined();
      expect(followUpsTerminalize).not.toHaveBeenCalled();
      expect(storageMocks.finalizeRun).not.toHaveBeenCalled();

      takeWaitingHandle(runId);

      // The tool-use loop's finally detaches this run's interrupt handler but
      // preserves the follow-up queue for WAITING — it does not dispose the
      // session — by the time a native subagent suspends at WAITING (not
      // reproduced by this fake runner, but true in production — see
      // loop/toolUse.ts). With no interrupt target left, `runs.kill()`
      // falls back to the teardown the WAITING branch parked and tears the
      // run down.
      const stop = defaultSession().runs.kill(runId);
      expect(stop.accepted).toBe(true);
      await Effect.runPromise(stop.settlement);

      expect(defaultSession().runs.getHandle(runId)).toBeUndefined();
      expect(defaultSession().status.get(runId)).toBe(RUN_PHASE.CANCELLED);
      expect(followUpsTerminalize).toHaveBeenCalledWith(runId);
      // The bypassed runFlowWithLifecycle can't write the terminal row, so
      // terminateWaitingHandle must — session subscribers would otherwise
      // miss the stop entirely.
      await vi.waitFor(() =>
        expect(storageMocks.finalizeRun).toHaveBeenCalledWith(
          defaultSession(),
          {
            runId,
            outcome: RUN_OUTCOME.CANCELLED,
            output: EMPTY_TOOL_USE_OUTPUT,
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
    const { runId, ctx } = lifecycleFixture();
    const stopSessionsForRun = vi.fn(async (_runId: RunId) => {});
    seedOpenRunGroup(ctx, runId);
    await ctx.runScope.session.settlePublications();
    vi.spyOn(ctx.runScope.session, 'settlePublications').mockRejectedValueOnce(
      new Error('stage publication failed'),
    );

    try {
      const result = await Effect.runPromise(
        runFlow(ctx, () => Effect.succeed(waitingResult(runId)), {
          onRunEnd: stopSessionsForRun,
        }),
      );
      expect(result.outcome).toBe(RUN_PHASE.WAITING);
      takeWaitingHandle(runId);

      const stop = defaultSession().runs.kill(runId);

      expect(stop.accepted).toBe(true);

      await Effect.runPromise(stop.settlement);

      expect(stopSessionsForRun).toHaveBeenCalledWith(runId);
    } finally {
      defaultSession().runs.untrack(runId);
      clearRunStatusForTest(defaultSession().status, runId);
    }
  });

  it('projects returned outcomes to terminal status, stage end, and run status', async () => {
    const cases = [
      {
        outcome: RUN_OUTCOME.COMPLETED,
        phase: RUN_PHASE.COMPLETED,
      },
      {
        outcome: RUN_OUTCOME.CANCELLED,
        phase: RUN_PHASE.CANCELLED,
      },
      {
        outcome: RUN_OUTCOME.FAILED,
        phase: RUN_PHASE.FAILED,
      },
    ] as const;

    for (const expected of cases) {
      const { runId, runStatus, ctx } = lifecycleFixture();
      const stageEnd = vi.spyOn(ctx.parentStage, 'end');

      try {
        const result = await Effect.runPromise(
          runFlow(ctx, () =>
            Effect.succeed(toolUseResult(runId, expected.outcome)),
          ),
        );

        expect(result.outcome).toBe(expected.outcome);
        expect(storageMocks.finalizeRun).toHaveBeenCalledWith(
          defaultSession(),
          {
            runId,
            outcome: expected.outcome,
            output: EMPTY_TOOL_USE_OUTPUT,
          },
        );
        expect(stageEnd).toHaveBeenCalledWith(expected.outcome);
        expect(runStatus.get(runId)).toBe(expected.phase);
      } finally {
        clearRunStatusForTest(runStatus, runId);
      }
    }
  });

  it('finalizes an outcome-only failure without fabricating provider error facts', async () => {
    const { runId, runStatus, ctx } = lifecycleFixture();
    const stageEnd = vi.spyOn(ctx.parentStage, 'end');
    const onError = vi.fn();

    try {
      const carriedResult = toolUseResult(runId, RUN_OUTCOME.FAILED);
      const result = await Effect.runPromise(
        runFlow(ctx, () => Effect.succeed(carriedResult), {
          parentRunId: PARENT_RUN_ID,
          onError,
        }),
      );

      expect(result).toEqual(carriedResult);
      // `run.end` is not a trace arm: the storage finalizer is its one
      // writer, so the absent error facts are read off that input.
      expect(storageMocks.finalizeRun).toHaveBeenCalledWith(defaultSession(), {
        runId,
        outcome: RUN_OUTCOME.FAILED,
        error: undefined,
        usage: undefined,
        output: carriedResult.output,
      });
      expect(stageEnd).toHaveBeenCalledWith(RUN_OUTCOME.FAILED);
      expect(runStatus.get(runId)).toBe(RUN_PHASE.FAILED);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      defaultSession().runs.untrack(runId);
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('projects a thrown abort as cancelled on its own stage outcome', async () => {
    const { runId, runStatus, ctx } = lifecycleFixture();
    const stageEnd = vi.spyOn(ctx.parentStage, 'end');

    try {
      const result = await Effect.runPromise(
        runFlow(ctx, () =>
          Effect.fail(new DOMException('Request aborted', 'AbortError')),
        ),
      );

      expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
      expect(storageMocks.finalizeRun).toHaveBeenCalledWith(defaultSession(), {
        runId,
        outcome: RUN_OUTCOME.CANCELLED,
        error: {
          kind: 'abort',
          message: 'Request aborted',
          userRetryable: false,
        },
        usage: undefined,
        output: EMPTY_TOOL_USE_OUTPUT,
      });
      expect(stageEnd).toHaveBeenCalledWith(RUN_OUTCOME.CANCELLED);
      expect(runStatus.get(runId)).toBe(RUN_PHASE.CANCELLED);
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('projects an unexpected throw as failed', async () => {
    const { runId, runStatus, ctx } = lifecycleFixture();
    const stageEnd = vi.spyOn(ctx.parentStage, 'end');

    try {
      await expect(
        Effect.runPromise(
          runFlow(ctx, () => Effect.fail(new Error('model exploded'))),
        ),
      ).rejects.toThrow('model exploded');

      expect(storageMocks.finalizeRun).toHaveBeenCalledWith(defaultSession(), {
        runId,
        outcome: RUN_OUTCOME.FAILED,
        error: {
          kind: 'unexpected',
          message: 'Error executing agent test-agent: model exploded',
          userRetryable: true,
        },
        usage: undefined,
        output: EMPTY_TOOL_USE_OUTPUT,
      });
      expect(stageEnd).toHaveBeenCalledWith(RUN_OUTCOME.FAILED);
      expect(runStatus.get(runId)).toBe(RUN_PHASE.FAILED);
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('terminalizes a waiting run when the lifecycle catch path fails', async () => {
    const { runId, runStatus, ctx } = lifecycleFixture();

    try {
      await expect(
        Effect.runPromise(
          runFlow(ctx, () =>
            Effect.gen(function* () {
              expect(
                runStatus.transition(runId, RUN_PHASE.WAITING, 'wait'),
              ).toBe(true);
              return yield* Effect.fail(new Error('wait node failed'));
            }),
          ),
        ),
      ).rejects.toThrow('wait node failed');

      expect(runStatus.get(runId)).toBe(RUN_PHASE.FAILED);
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('passes flow-carried terminal results to subagent error delivery', async () => {
    const { runId, runStatus, ctx } = lifecycleFixture();
    const carriedResult = {
      outcome: RUN_OUTCOME.FAILED,
      runId,
      output: { category: 'toolUse' as const, response: '', files: [] },
      error: { message: 'subagent failed', userRetryable: false },
    };
    const onError = vi.fn();

    try {
      seedRunStatusForTest(runStatus, runId, {
        phase: RUN_PHASE.RUNNING,
      });

      const result = await Effect.runPromise(
        runFlow(ctx, () => Effect.succeed(carriedResult), {
          parentRunId: PARENT_RUN_ID,
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
    const { runId, runStatus, ctx } = lifecycleFixture();
    const stageEnd = vi.spyOn(ctx.parentStage, 'end');

    try {
      await expect(
        Effect.runPromise(
          runFlow(ctx, () =>
            Effect.succeed({
              outcome: RUN_OUTCOME.FAILED,
              runId,
              output: {
                category: 'toolUse' as const,
                response: 'partial answer',
                files: [],
              },
              error: {
                message: 'provider exploded',
                userRetryable: true,
                statusCode: 503,
              },
            }),
          ),
        ),
      ).rejects.toThrow('provider exploded');

      // A carried failure is exactly as loud as a thrown one: same terminal
      // status, same stage outcome, same classified error on the `run.end`
      // row the storage finalizer writes.
      expect(storageMocks.finalizeRun).toHaveBeenCalledWith(
        defaultSession(),
        expect.objectContaining({
          runId,
          outcome: RUN_OUTCOME.FAILED,
          error: expect.objectContaining({
            kind: 'unexpected',
            statusCode: 503,
            userRetryable: true,
          }),
        }),
      );
      expect(stageEnd).toHaveBeenCalledWith(RUN_OUTCOME.FAILED);
      expect(runStatus.get(runId)).toBe(RUN_PHASE.FAILED);
    } finally {
      defaultSession().runs.untrack(runId);
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('classifies a carried missing-api-key failure through the canonical discriminant', async () => {
    const { runId, ctx } = lifecycleFixture();

    try {
      await expect(
        Effect.runPromise(
          runFlow(ctx, () =>
            Effect.succeed({
              outcome: RUN_OUTCOME.FAILED,
              runId,
              output: { category: 'toolUse' as const, response: '', files: [] },
              // The retry-state flatten drops the Error and its Symbol marker;
              // the canonical classification keeps the kind reachable here.
              error: {
                message: 'Missing OpenRouter API key.',
                userRetryable: false,
                classification: { kind: 'missing-api-key' as const },
              },
            }),
          ),
        ),
      ).rejects.toThrow('Missing OpenRouter API key.');

      expect(storageMocks.finalizeRun).toHaveBeenCalledWith(
        defaultSession(),
        expect.objectContaining({
          outcome: RUN_OUTCOME.FAILED,
          error: expect.objectContaining({ kind: 'missing-api-key' }),
        }),
      );
    } finally {
      defaultSession().runs.untrack(runId);
    }
  });
});

/** The session fake, handle, status machine, and spies every finalize test drives. */
function finalizeFixture(): {
  runId: RunId;
  session: SessionHandle;
  runStatus: RunStatusMachine;
  handle: ReturnType<typeof testRunHandle>;
  untrack: Mock<(runId: RunId) => void>;
  flushArtifacts: Mock<() => Promise<void>>;
} {
  const runId =
    `f${(finalizeFixtureCounter++).toString(16).padStart(5, '0')}` as RunId;
  const runStatus = new RunStatusMachine(
    () => {},
    () => {},
  );
  const untrack = vi.fn<(runId: RunId) => void>();
  const flushArtifacts = vi.fn(async () => {});
  return {
    runId,
    session: {
      runs: { untrack },
      status: runStatus,
      flushArtifacts,
    } as unknown as SessionHandle,
    runStatus,
    untrack,
    flushArtifacts,
    handle: testRunHandle({
      runId,
      parent: PARENT_RUN_ID,
      agent: 'test-agent',
      trace: noopTrace,
    }),
  };
}

let finalizeFixtureCounter = 0;

describe('finalizeRunTerminal', () => {
  // The exactly-once guard must be an atomic, synchronous claim — not a
  // check-then-await on the settled flag. Two finalizers racing across the
  // persist await (e.g. a lifecycle arm vs a concurrent finalize of the same
  // handle) would otherwise both pass the check before the first settles and
  // double-publish persist/emit/settle/untrack.
  it('finalizes exactly once when two callers race across the persist await', async () => {
    const { runId, session, runStatus, handle, untrack } = finalizeFixture();
    // Park the first caller at its persist await so the second caller arrives
    // while the first has not yet emitted or settled anything.
    const parked = parkNextFinalize();

    try {
      seedRunStatusForTest(runStatus, runId, {
        phase: RUN_PHASE.RUNNING,
      });
      const params = {
        session,
        handle,
        outcome: RUN_OUTCOME.COMPLETED,
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
          type: 'run.end',
          outcome: RUN_OUTCOME.COMPLETED,
          runId,
        },
      });
      // `run.end` is not a trace arm: the storage finalizer is its one
      // writer, so writing it once is what "exactly once" means here.
      expect(storageMocks.finalizeRun).toHaveBeenCalledTimes(1);
      expect(untrack).toHaveBeenCalledTimes(1);
      expect(runStatus.get(runId)).toBe(RUN_PHASE.COMPLETED);
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('flushes display artifacts before publishing and untracking', async () => {
    const { runId, session, runStatus, handle, untrack, flushArtifacts } =
      finalizeFixture();
    let releaseFlush: (() => void) | undefined;
    flushArtifacts.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseFlush = resolve;
        }),
    );
    try {
      seedRunStatusForTest(runStatus, runId, {
        phase: RUN_PHASE.RUNNING,
      });
      const finalization = Effect.runPromise(
        finalizeRunTerminal({
          session,
          handle,
          outcome: RUN_OUTCOME.COMPLETED,
        }),
      );

      await vi.waitFor(() => expect(flushArtifacts).toHaveBeenCalledOnce());
      expect(storageMocks.finalizeRun).not.toHaveBeenCalled();
      expect(untrack).not.toHaveBeenCalled();

      releaseFlush?.();
      await finalization;

      expect(storageMocks.finalizeRun).toHaveBeenCalledOnce();
      expect(untrack).toHaveBeenCalledExactlyOnceWith(runId);
      expect(runStatus.get(runId)).toBe(RUN_PHASE.COMPLETED);
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('settles and untracks once while reporting terminal metadata failure', async () => {
    const { runId, session, runStatus, handle, untrack } = finalizeFixture();
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
          session,
          handle,
          outcome: RUN_OUTCOME.FAILED,
        }),
      );

      expect(event).toMatchObject({
        event: {
          type: 'run.end',
          outcome: RUN_OUTCOME.FAILED,
          runId,
        },
      });
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

  // The run phase is the single owner of a run's terminal outcome. A
  // stop/kill transitions the phase behind the run's back, and the run it
  // killed then reports its own non-zero exit as a failure — so the phase, not
  // the report, has to decide, and no caller may cross-check it for itself.
  it('resolves the terminal outcome from an already-cancelled run phase', async () => {
    const { runId, session, runStatus, handle } = finalizeFixture();
    const stage = { end: vi.fn() };

    try {
      seedRunStatusForTest(runStatus, runId, {
        phase: RUN_PHASE.CANCELLED,
      });

      const finalized = await Effect.runPromise(
        finalizeRunTerminal({
          session,
          handle,
          outcome: RUN_OUTCOME.FAILED,
          error: { kind: 'unexpected', message: 'exited with code 143' },
          stage,
        }),
      );

      expect(finalized?.event).toMatchObject({
        type: 'run.end',
        outcome: RUN_OUTCOME.CANCELLED,
        runId,
      });
      // Error facts classified for a failure that the phase says never
      // happened must not ride the cancelled result.
      expect(finalized?.event.error).toBeUndefined();
      expect(stage.end).toHaveBeenCalledExactlyOnceWith(RUN_OUTCOME.CANCELLED);
      expect(storageMocks.finalizeRun).toHaveBeenCalledWith(
        session,
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
  it('keeps an already-failed run phase over a later cancelled report', async () => {
    const { runId, session, runStatus, handle } = finalizeFixture();

    try {
      seedRunStatusForTest(runStatus, runId, {
        phase: RUN_PHASE.FAILED,
      });

      const finalized = await Effect.runPromise(
        finalizeRunTerminal({
          session,
          handle,
          outcome: RUN_OUTCOME.CANCELLED,
        }),
      );

      expect(finalized?.event).toMatchObject({
        type: 'run.end',
        outcome: RUN_OUTCOME.FAILED,
        runId,
      });
      expect(runStatus.get(runId)).toBe(RUN_PHASE.FAILED);
      expect(channelTraceMocks.warn).not.toHaveBeenCalled();
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });
});
