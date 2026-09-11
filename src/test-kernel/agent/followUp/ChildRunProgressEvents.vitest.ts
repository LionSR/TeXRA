// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { it } from '@effect/vitest';
import { Cause, Deferred, Effect, Exit, Fiber } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

// Local imports
import { getRunRecords, registerRun } from '@agent/storage';
import { inspectRunLease } from '@agent/storage/runLease';
import { runInSession } from '@agent/runtime/RunContext';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { defaultSession } from '@agent/runtime/SessionHandle';
import {
  aggregateId as qualifyAggregateId,
  aggregateTarget,
  RUN_OUTCOME,
  RUN_PHASE,
  runIdentityName,
  type RunId,
  AgentCategory,
} from '@shared/schemas';
import {
  clearRunStatusForTest,
  seedRunStatusForTest,
} from '@test/support/runStatusTestUtils';
import {
  createProcessSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import {
  launchAgentCliSession,
  reraiseAgentCliCallFailure,
} from '@tools/agentCliShared';
import { codexThreadsFor } from '@tools/agentCliSessionStores';
import { createChildRun, type ChildRun } from '@tools/delegation/childRun';

// Local file imports
import {
  createRecordingHost,
  eventsOfType,
  recordChildRosters,
  recordSessionEvents,
} from '../progressTestUtils';

const runId = 'c11111' as RunId;
const parentRunId = 'c11112' as RunId;
const loopRunId = 'c11113' as RunId;
const stoppedRunId = 'c11114' as RunId;
const cancelledRunId = 'c11115' as RunId;
const failedRunId = 'c11116' as RunId;
const noProjectionAutoCloseRunId = 'c11118' as RunId;
const workflowRelaunchRunId = 'c11119' as RunId;
const setupRetryRunId = 'c11120' as RunId;
const config = AgentConfigSchema.parse({
  agentCategory: AgentCategory.ToolUse,
  model: 'test-model',
  agent: 'test-agent',
});

const createRegisteredChildRun = Effect.fn('createRegisteredChildRun')(
  function* (...args: Parameters<typeof createChildRun>) {
    const [session, runId, parentRunId, options] = args;
    yield* registerRun(
      session,
      runId,
      options.config,
      runIdentityName(options.run),
      {
        identity: options.run,
        userFollowUpSupport: options.userFollowUpSupport,
        parentRunId,
        description: options.description,
      },
    );
    const child = yield* createChildRun(...args).pipe(
      Effect.onError(() => session.releaseRunLease(runId).pipe(Effect.orDie)),
    );
    return {
      ...child,
      finalize: (input: Parameters<ChildRun['finalize']>[0]) =>
        child
          .finalize(input)
          .pipe(
            Effect.ensuring(session.releaseRunLease(runId).pipe(Effect.orDie)),
          ),
    };
  },
);

function startBashChild(runId: RunId) {
  return Effect.runPromise(
    createRegisteredChildRun(defaultSession(), runId, parentRunId, {
      run: { kind: 'process', tool: 'bash' },
      userFollowUpSupport: 'unsupported',
      description: 'Run a background bash command',
      config,
    }),
  );
}

function startCodexChild(runId: RunId, description: string) {
  return Effect.runPromise(
    createRegisteredChildRun(defaultSession(), runId, parentRunId, {
      run: { kind: 'agent', agent: 'codex', tool: 'codex' },
      userFollowUpSupport: 'terminalBacked',
      description,
      config,
    }),
  );
}

describe('child run progress events', () => {
  beforeEach(async () => {
    const session = createProcessSession();
    publishTestRunStart(session, parentRunId);
    await session.settlePublications();
  });

  it('publishes child run lifecycle events through the session hub', async () => {
    const recorded = recordSessionEvents(defaultSession());
    const rosters = recordChildRosters(defaultSession().runs);

    const childRun = await startBashChild(runId);

    expect(childRun.childRunId).toBe(runId);

    await Effect.runPromise(
      childRun.finalize({
        outcome: RUN_OUTCOME.COMPLETED,
        autoClose: true,
      }),
    );

    expect(eventsOfType(await recorded.read(), 'run.start')).toContainEqual(
      expect.objectContaining({
        aggregateId: qualifyAggregateId('run', runId),
        identity: { kind: 'process', tool: 'bash' },
        category: AgentCategory.ToolUse,
        isRemote: false,
        // The whole parent edge, stamped on the birth fact.
        parent: expect.objectContaining({ id: parentRunId }),
      }),
    );
    // The activation beside the existence fact, with no `isRemote`: the
    // frozen NDJSON line for a child never carried one.
    expect(eventsOfType(await recorded.read(), 'run.activate')).toMatchObject([
      {
        type: 'run.activate',
        aggregateId: qualifyAggregateId('run', runId),
        category: AgentCategory.ToolUse,
      },
    ]);
    expect(eventsOfType(await recorded.read(), 'run.config')).toContainEqual(
      expect.objectContaining({
        aggregateId: qualifyAggregateId('run', runId),
      }),
    );
    expect(
      eventsOfType(await recorded.read(), 'updateRunDescription'),
    ).toContainEqual(
      expect.objectContaining({
        aggregateId: qualifyAggregateId('run', runId),
        description: 'Run a background bash command',
      }),
    );
    expect(eventsOfType(await recorded.read(), 'status')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          aggregateId: qualifyAggregateId('run', runId),
          phase: RUN_PHASE.RUNNING,
          cause: 'lifecycle',
        }),
        expect.objectContaining({
          aggregateId: qualifyAggregateId('run', runId),
          phase: RUN_PHASE.COMPLETED,
          previousPhase: RUN_PHASE.RUNNING,
          cause: 'lifecycle',
        }),
      ]),
    );
    expect(rosters.rosters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parentRunId,
          items: [
            expect.objectContaining({
              childRunId: runId,
              agentName: 'bash',
              status: RUN_PHASE.RUNNING,
              identity: { kind: 'process', tool: 'bash' },
            }),
          ],
        }),
        expect.objectContaining({
          parentRunId,
          items: [],
        }),
      ]),
    );
    expect(eventsOfType(await recorded.read(), 'run.removed')).toEqual([]);
  });

  it('marks a deterministic child-run relaunch as running', async () => {
    const firstRun = await Effect.runPromise(
      createRegisteredChildRun(
        defaultSession(),
        workflowRelaunchRunId,
        parentRunId,
        {
          run: { kind: 'multiAgentWorkflow', workflowName: 'draft-sections' },
          userFollowUpSupport: 'unsupported',
          description: 'Run a named child task',
          config,
        },
      ),
    );
    await Effect.runPromise(
      firstRun.finalize({ outcome: RUN_OUTCOME.COMPLETED }),
    );
    expect(defaultSession().status.get(workflowRelaunchRunId)).toBe(
      RUN_PHASE.COMPLETED,
    );

    const recorded = recordSessionEvents(defaultSession());
    const relaunched = await Effect.runPromise(
      createRegisteredChildRun(
        defaultSession(),
        workflowRelaunchRunId,
        parentRunId,
        {
          run: { kind: 'multiAgentWorkflow', workflowName: 'draft-sections' },
          userFollowUpSupport: 'unsupported',
          description: 'Resume the named child task',
          config,
        },
      ),
    );

    try {
      expect(defaultSession().status.get(workflowRelaunchRunId)).toBe(
        RUN_PHASE.RUNNING,
      );
      expect(
        defaultSession().runs.getActiveChildren(parentRunId),
      ).toContainEqual(
        expect.objectContaining({
          childRunId: workflowRelaunchRunId,
          status: RUN_PHASE.RUNNING,
        }),
      );
      expect(eventsOfType(await recorded.read(), 'status')).toContainEqual(
        expect.objectContaining({
          cause: 'resume',
          phase: RUN_PHASE.RUNNING,
          previousPhase: RUN_PHASE.COMPLETED,
          aggregateId: qualifyAggregateId('run', workflowRelaunchRunId),
        }),
      );
    } finally {
      await Effect.runPromise(
        relaunched.finalize({ outcome: RUN_OUTCOME.COMPLETED }),
      );
    }
  });

  it('rolls back a failed rehydrated setup so the same run can retry', async () => {
    const recorded = recordSessionEvents(defaultSession());
    const trackRun = vi
      .spyOn(defaultSession().runs, 'trackAgentRun')
      .mockImplementationOnce(() => {
        throw new Error('run setup failed');
      });
    const options = {
      run: {
        kind: 'multiAgentWorkflow' as const,
        workflowName: 'retry-setup',
      },
      userFollowUpSupport: 'unsupported' as const,
      description: 'Retry a failed child run setup',
      config,
    };

    try {
      await expect(
        Effect.runPromise(
          createRegisteredChildRun(
            defaultSession(),
            setupRetryRunId,
            parentRunId,
            options,
          ),
        ),
      ).rejects.toThrow('run setup failed');
      expect(
        eventsOfType(await recorded.read(), 'run.removed').map(
          (event) => event.aggregateId,
        ),
      ).not.toContain(qualifyAggregateId('run', setupRetryRunId));
      // Setup failed after the existence fact, so the started run ended
      // with its terminal result instead of lingering as a ghost.
      expect(eventsOfType(await recorded.read(), 'result')).toContainEqual(
        expect.objectContaining({
          aggregateId: qualifyAggregateId('run', setupRetryRunId),
          outcome: RUN_OUTCOME.FAILED,
        }),
      );

      const retried = await Effect.runPromise(
        createRegisteredChildRun(
          defaultSession(),
          setupRetryRunId,
          parentRunId,
          options,
        ),
      );
      expect(retried.childRunId).toBe(setupRetryRunId);
      expect(
        eventsOfType(await recorded.read(), 'run.start').filter(
          (event) =>
            event.aggregateId === qualifyAggregateId('run', setupRetryRunId),
        ),
      ).toHaveLength(1);
      expect(
        eventsOfType(await recorded.read(), 'run.activate').filter(
          (event) =>
            event.aggregateId === qualifyAggregateId('run', setupRetryRunId),
        ),
      ).toHaveLength(2);
      await Effect.runPromise(
        retried.finalize({ outcome: RUN_OUTCOME.COMPLETED }),
      );
    } finally {
      trackRun.mockRestore();
    }
  });

  it('emits workflow-script identity independently of its worker config', async () => {
    const recorded = recordSessionEvents(defaultSession());
    const workerConfig = {
      ...config,
      agent: 'generic',
      agentCategory: AgentCategory.Workflow,
    };

    const childRun = await Effect.runPromise(
      createRegisteredChildRun(
        defaultSession(),
        workflowRelaunchRunId,
        parentRunId,
        {
          run: {
            kind: 'multiAgentWorkflow',
            workflowName: 'repo-cleanup-readonly-pilot-2026-07-24',
          },
          userFollowUpSupport: 'unsupported',
          description: 'Audit the repository without editing',
          config: workerConfig,
        },
      ),
    );

    expect(eventsOfType(await recorded.read(), 'run.start')).toContainEqual(
      expect.objectContaining({
        identity: {
          kind: 'multiAgentWorkflow',
          workflowName: 'repo-cleanup-readonly-pilot-2026-07-24',
        },
      }),
    );
    expect(
      defaultSession().runs.getHandle(workflowRelaunchRunId),
    ).toMatchObject({
      agentName: 'repo-cleanup-readonly-pilot-2026-07-24',
      category: AgentCategory.Workflow,
    });

    await Effect.runPromise(
      childRun.finalize({ outcome: RUN_OUTCOME.COMPLETED }),
    );
  });

  it('publishes child run existence as a run fact without direct host emission', async () => {
    const active = createRecordingHost();
    const recorded = recordSessionEvents(defaultSession());

    const childRun = await startBashChild(runId);

    expect(active.events).toEqual([]);
    expect(eventsOfType(await recorded.read(), 'run.start')).toEqual([
      expect.objectContaining({
        type: 'run.start',
        aggregateId: qualifyAggregateId('run', runId),
        category: AgentCategory.ToolUse,
        parent: expect.objectContaining({ id: parentRunId }),
      }),
    ]);

    await Effect.runPromise(
      childRun.finalize({ outcome: RUN_OUTCOME.COMPLETED }),
    );
  });

  it('releases completed child presentation without direct host emission', async () => {
    const active = createRecordingHost();
    const recorded = recordSessionEvents(defaultSession());

    const childRun = await startBashChild(noProjectionAutoCloseRunId);

    await Effect.runPromise(
      childRun.finalize({
        outcome: RUN_OUTCOME.COMPLETED,
        autoClose: true,
      }),
    );

    expect(active.events).toEqual([]);
    expect(eventsOfType(await recorded.read(), 'run.removed')).toEqual([]);
    expect(defaultSession().transcripts.has(noProjectionAutoCloseRunId)).toBe(
      true,
    );
  });

  it('retains completed command history after automatic presentation release', async () => {
    const recorded = recordSessionEvents(defaultSession());

    const childRun = await startBashChild(runId);
    childRun.logger.info('retained command output');

    await Effect.runPromise(
      childRun.finalize({
        outcome: RUN_OUTCOME.COMPLETED,
        autoClose: true,
      }),
    );

    expect(eventsOfType(await recorded.read(), 'run.removed')).toEqual([]);
    const entries = await Effect.runPromise(
      defaultSession().transcripts.readEntries(runId),
    );
    expect(
      entries.some((entry) => entry.text === 'retained command output'),
    ).toBe(true);
  });

  it.effect(
    'cancels committed admission before launching detached work and releases both claims',
    () =>
      Effect.gen(function* () {
        const session = defaultSession();
        const committed = yield* Deferred.make<RunId>();
        const releasePublication = yield* Deferred.make<void>();
        const commit = session.commitRegistration.bind(session);
        const publication = vi
          .spyOn(session, 'commitRegistration')
          .mockImplementationOnce((events) =>
            commit(events).pipe(
              Effect.tap((rows) => {
                const start = rows.find((row) => row.type === 'run.start');
                if (!start) throw new Error('expected a committed child birth');
                // The run is its own aggregate: the birth fact carries no
                // second copy of the id.
                const target = aggregateTarget(start.aggregateId);
                if (target.kind !== 'run') {
                  throw new Error('expected a run aggregate for run.start');
                }
                return Deferred.succeed(committed, target.id);
              }),
              Effect.tap(() => Deferred.await(releasePublication)),
            ),
          );
        const startLoop = vi.fn(() => Effect.void);
        try {
          const launching = yield* Effect.forkChild(
            launchAgentCliSession({
              session,
              parentRunId,
              agentName: 'codex',
              description: 'Cancelled admission',
              config,
              registerFailedMessage: 'registration failed',
              startLoop,
              summary: 'unreachable',
              launchedLine: 'unreachable',
              followUpLine: 'unreachable',
            }),
          );
          const id = yield* Deferred.await(committed);
          const interrupting = yield* Effect.forkChild(
            Fiber.interrupt(launching),
            { startImmediately: true },
          );
          yield* Deferred.succeed(releasePublication, undefined);
          yield* Fiber.join(interrupting);
          const stopped = yield* Fiber.await(launching);
          expect(
            Exit.isFailure(stopped) && Cause.hasInterrupts(stopped.cause),
          ).toBe(true);
          expect(startLoop).not.toHaveBeenCalled();
          expect((yield* getRunRecords(session, id).readMeta())?.outcome).toBe(
            RUN_OUTCOME.CANCELLED,
          );
          expect(
            yield* Effect.promise(() =>
              runInSession(session, () => inspectRunLease(id)),
            ),
          ).toEqual({ status: 'free' });
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                getRunRecords(session, id).writeReport('unowned'),
              ),
            ),
          ).toBe(true);
        } finally {
          publication.mockRestore();
        }
      }),
  );

  it.effect(
    'finalizes a child run when agent CLI loop setup fails synchronously',
    () =>
      Effect.gen(function* () {
        const setupError = new Error('child loop setup failed');
        const session = defaultSession();
        const recorded = recordSessionEvents(session);
        let childRun: ChildRun | undefined;
        let childRunId: RunId | undefined;
        let handle: ReturnType<typeof session.runs.getHandle>;

        try {
          // `reraiseAgentCliCallFailure` re-raises the loop's throw as a
          // defect, so flip the defect back into the error channel.
          const defect = yield* Effect.flip(
            reraiseAgentCliCallFailure(
              launchAgentCliSession({
                session: defaultSession(),
                parentRunId,
                agentName: 'codex',
                description: 'Fail during synchronous loop setup',
                config,
                registerFailedMessage: 'registration failed',
                startLoop: (context) => {
                  childRun = context.childRun;
                  childRunId = context.runId;
                  handle = session.runs.getHandle(context.childRun.childRunId);
                  throw setupError;
                },
                summary: 'unreachable',
                launchedLine: 'unreachable',
                followUpLine: 'unreachable',
              }),
            ).pipe(Effect.catchDefect((cause) => Effect.fail(cause))),
          );
          expect(defect).toBe(setupError);

          expect(childRun).toBeDefined();
          expect(childRunId).toBeDefined();
          expect(handle).toBeDefined();
          if (!childRun || !childRunId || !handle) {
            throw new Error('expected the failed child launch to be captured');
          }
          expect(session.runs.getHandle(childRunId)).toBeUndefined();
          expect(session.status.get(childRun.childRunId)).toBe(
            RUN_PHASE.FAILED,
          );
          const failedHandle = handle;
          const result = yield* failedHandle.result;
          expect(result).toMatchObject({
            type: 'result',
            outcome: 'failed',
            runId: childRunId,
          });
        } finally {
          if (childRun) {
            clearRunStatusForTest(session.status, childRun.childRunId);
          }
        }
      }),
  );

  it('publishes child loop status changes through the child run owner', async () => {
    const childRun = await startCodexChild(
      loopRunId,
      'Run a long-lived Codex child loop',
    );
    const handle = defaultSession().runs.getHandle(loopRunId);
    expect(handle).toBeDefined();
    // From here on: the launch's own facts are not the loop's.
    const recorded = recordSessionEvents(defaultSession());
    const rosters = recordChildRosters(defaultSession().runs);

    childRun.waitForInput();
    childRun.beginTurn();
    childRun.failTurn();
    await Effect.runPromise(childRun.finalize({ outcome: RUN_OUTCOME.FAILED }));

    expect(
      eventsOfType(await recorded.read(), 'status')
        .filter(
          (event) => event.aggregateId === qualifyAggregateId('run', loopRunId),
        )
        .map((event) => event.phase),
    ).toEqual([RUN_PHASE.WAITING, RUN_PHASE.RUNNING, RUN_PHASE.FAILED]);
    expect(defaultSession().status.get(loopRunId)).toBe(RUN_PHASE.FAILED);
    expect(rosters.rosters.at(-1)).toMatchObject({
      parentRunId,
      items: [],
    });
    await expect(Effect.runPromise(handle!.result)).resolves.toMatchObject({
      type: 'result',
      outcome: 'failed',
      error: {
        kind: 'unexpected',
        message: 'Child run failed',
      },
    });
  });

  // The child reports its own exit and nothing else: every mid-loop report
  // below is refused by the status machine because a stop already cancelled
  // the run, and `finalizeRunTerminal` resolves the run's terminal outcome
  // from that phase rather than from the failure the child reports.
  it('settles a stopped child loop as cancelled from the run phase', async () => {
    const childRun = await startCodexChild(
      stoppedRunId,
      'Run a stopped Codex child loop',
    );
    const handle = defaultSession().runs.getHandle(stoppedRunId);
    expect(handle).toBeDefined();
    seedRunStatusForTest(defaultSession().status, stoppedRunId, {
      phase: RUN_PHASE.CANCELLED,
    });
    // From here on: the launch's own facts are not the loop's.
    const recorded = recordSessionEvents(defaultSession());

    childRun.waitForInput();
    childRun.beginTurn();
    childRun.failTurn();
    await Effect.runPromise(childRun.finalize({ outcome: RUN_OUTCOME.FAILED }));

    expect(defaultSession().status.get(stoppedRunId)).toBe(RUN_PHASE.CANCELLED);
    expect(
      eventsOfType(await recorded.read(), 'status').filter(
        (event) =>
          event.aggregateId === qualifyAggregateId('run', stoppedRunId),
      ),
    ).toHaveLength(0);
    await expect(Effect.runPromise(handle!.result)).resolves.toMatchObject({
      type: 'result',
      outcome: 'cancelled',
      runId: stoppedRunId,
    });
  });

  it('settles child handle results as cancelled for stopped finalization', async () => {
    const childRun = await startCodexChild(
      cancelledRunId,
      'Run an interrupted Codex child loop',
    );
    const handle = defaultSession().runs.getHandle(cancelledRunId);
    expect(handle).toBeDefined();

    await Effect.runPromise(
      childRun.finalize({ outcome: RUN_OUTCOME.CANCELLED }),
    );

    await expect(Effect.runPromise(handle!.result)).resolves.toMatchObject({
      type: 'result',
      outcome: 'cancelled',
      runId: cancelledRunId,
    });
  });

  it('settles failed child handle results with error details', async () => {
    const childRun = await startCodexChild(
      failedRunId,
      'Run a failing Codex child loop',
    );
    const handle = defaultSession().runs.getHandle(failedRunId);
    expect(handle).toBeDefined();

    await Effect.runPromise(
      childRun.finalize({
        outcome: RUN_OUTCOME.FAILED,
        error: new Error('child process exited 1'),
      }),
    );

    expect(defaultSession().status.get(failedRunId)).toBe(RUN_PHASE.FAILED);
    await expect(Effect.runPromise(handle!.result)).resolves.toMatchObject({
      type: 'result',
      outcome: 'failed',
      runId: failedRunId,
      error: {
        kind: 'unexpected',
        message: 'child process exited 1',
      },
    });
  });
});
