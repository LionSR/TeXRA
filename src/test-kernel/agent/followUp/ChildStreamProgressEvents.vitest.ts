// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { it } from '@effect/vitest';
import { Cause, Deferred, Effect, Exit, Fiber } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

// Local imports
import { getExecutionRecords, registerExecution } from '@agent/storage';
import { inspectExecutionLease } from '@agent/storage/executionLease';
import { runInSession } from '@agent/runtime/RunContext';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { getStreamTabId } from '@agent/runtime/streamTab';
import { defaultSession } from '@agent/runtime/SessionHandle';
import {
  aggregateId as qualifyAggregateId,
  RUN_OUTCOME,
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
  AgentCategory,
} from '@shared/schemas';
import {
  clearStreamStatusForTest,
  seedStreamStatusForTest,
} from '@test/support/streamStatusTestUtils';
import {
  createProcessSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import {
  launchAgentCliSession,
  reraiseAgentCliCallFailure,
} from '@tools/agentCliShared';
import {
  createChildStream,
  type ChildStream,
} from '@tools/delegation/childStream';

// Local file imports
import {
  createRecordingHost,
  eventsOfType,
  recordChildRosters,
  recordSessionEvents,
} from '../progressTestUtils';

const executionId = 'c11111' as ExecutionId;
const parentStreamId = 'stream:parent' as StreamTabId;
const childStreamId = 'bash#c11111' as StreamTabId;
const loopExecutionId = 'c11113' as ExecutionId;
const loopChildStreamId = 'codex#c11113' as StreamTabId;
const stoppedExecutionId = 'c11114' as ExecutionId;
const stoppedChildStreamId = 'codex#c11114' as StreamTabId;
const cancelledExecutionId = 'c11115' as ExecutionId;
const cancelledChildStreamId = 'codex#c11115' as StreamTabId;
const failedExecutionId = 'c11116' as ExecutionId;
const failedChildStreamId = 'codex#c11116' as StreamTabId;
const noProjectionAutoCloseExecutionId = 'c11118' as ExecutionId;
const noProjectionAutoCloseChildStreamId = 'bash#c11118' as StreamTabId;
const workflowRelaunchExecutionId = 'c11119' as ExecutionId;
const workflowRelaunchChildStreamId = 'workflow-script#c11119' as StreamTabId;
const setupRetryExecutionId = 'c11120' as ExecutionId;
const setupRetryChildStreamId = 'workflow-script#c11120' as StreamTabId;
const config = AgentConfigSchema.parse({
  agentCategory: AgentCategory.ToolUse,
  model: 'test-model',
  agent: 'test-agent',
});

const createRegisteredChildStream = Effect.fn('createRegisteredChildStream')(
  function* (...args: Parameters<typeof createChildStream>) {
    const [session, executionId, parentStreamId, options] = args;
    yield* registerExecution(
      session,
      executionId,
      options.config,
      options.streamPrefix,
      {
        streamId: getStreamTabId(options.streamPrefix, { executionId }),
        identity: options.run,
        userFollowUpSupport: options.userFollowUpSupport,
        parentStreamId,
        background: true,
        description: options.description,
      },
    );
    const child = yield* createChildStream(...args).pipe(
      Effect.onError(() =>
        session.releaseExecutionLease(executionId).pipe(Effect.orDie),
      ),
    );
    return {
      ...child,
      finalize: (input: Parameters<ChildStream['finalize']>[0]) =>
        child
          .finalize(input)
          .pipe(
            Effect.ensuring(
              session.releaseExecutionLease(executionId).pipe(Effect.orDie),
            ),
          ),
    };
  },
);

function startBashChild(executionId: ExecutionId) {
  return Effect.runPromise(
    createRegisteredChildStream(defaultSession(), executionId, parentStreamId, {
      streamPrefix: 'bash',
      run: { kind: 'process', tool: 'bash' },
      userFollowUpSupport: 'unsupported',
      description: 'Run a background bash command',
      config,
    }),
  );
}

function startCodexChild(executionId: ExecutionId, description: string) {
  return Effect.runPromise(
    createRegisteredChildStream(defaultSession(), executionId, parentStreamId, {
      streamPrefix: 'codex',
      run: { kind: 'agent', agent: 'codex', tool: 'codex' },
      userFollowUpSupport: 'terminalBacked',
      description,
      config,
    }),
  );
}

describe('child stream progress events', () => {
  beforeEach(async () => {
    const session = createProcessSession();
    publishTestRunStart(session, parentStreamId);
    await session.settlePublications();
  });

  it('publishes child stream lifecycle events through the session hub', async () => {
    const recorded = recordSessionEvents(defaultSession());
    const rosters = recordChildRosters(defaultSession().executions);

    const childStream = await startBashChild(executionId);

    expect(childStream.childStreamId).toBe(childStreamId);

    await Effect.runPromise(
      childStream.finalize({
        outcome: RUN_OUTCOME.COMPLETED,
        autoClose: true,
      }),
    );

    expect(eventsOfType(await recorded.read(), 'run.start')).toContainEqual(
      expect.objectContaining({
        aggregateId: qualifyAggregateId('stream', childStreamId),
        executionId,
        identity: { kind: 'process', tool: 'bash' },
        category: AgentCategory.ToolUse,
        isRemote: false,
        parentStreamId,
      }),
    );
    // The activation beside the existence fact, with no `isRemote`: the
    // frozen NDJSON line for a child never carried one.
    expect(eventsOfType(await recorded.read(), 'run.activate')).toMatchObject([
      {
        type: 'run.activate',
        aggregateId: qualifyAggregateId('stream', childStreamId),
        category: AgentCategory.ToolUse,
        background: true,
      },
    ]);
    expect(eventsOfType(await recorded.read(), 'run.config')).toContainEqual(
      expect.objectContaining({
        aggregateId: qualifyAggregateId('stream', childStreamId),
        executionId,
      }),
    );
    expect(
      eventsOfType(await recorded.read(), 'updateStreamDescription'),
    ).toContainEqual(
      expect.objectContaining({
        aggregateId: qualifyAggregateId('stream', childStreamId),
        description: 'Run a background bash command',
      }),
    );
    expect(eventsOfType(await recorded.read(), 'status')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          aggregateId: qualifyAggregateId('stream', childStreamId),
          phase: STREAM_PHASE.RUNNING,
          cause: 'lifecycle',
        }),
        expect.objectContaining({
          aggregateId: qualifyAggregateId('stream', childStreamId),
          phase: STREAM_PHASE.COMPLETED,
          previousPhase: STREAM_PHASE.RUNNING,
          cause: 'lifecycle',
        }),
      ]),
    );
    expect(rosters.rosters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parentStreamId,
          items: [
            expect.objectContaining({
              executionId,
              childStreamId,
              agentName: 'bash',
              status: STREAM_PHASE.RUNNING,
              identity: { kind: 'process', tool: 'bash' },
            }),
          ],
        }),
        expect.objectContaining({
          parentStreamId,
          items: [],
        }),
      ]),
    );
    expect(
      eventsOfType(await recorded.read(), 'setParentStream'),
    ).toContainEqual(
      expect.objectContaining({
        aggregateId: qualifyAggregateId('stream', childStreamId),
        parentStreamId,
      }),
    );
    expect(eventsOfType(await recorded.read(), 'stream.removed')).toEqual([]);
  });

  it('marks a deterministic child-stream relaunch as running', async () => {
    const firstRun = await Effect.runPromise(
      createRegisteredChildStream(
        defaultSession(),
        workflowRelaunchExecutionId,
        parentStreamId,
        {
          streamPrefix: 'workflow-script',
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
    expect(defaultSession().status.get(workflowRelaunchChildStreamId)).toBe(
      STREAM_PHASE.COMPLETED,
    );

    const recorded = recordSessionEvents(defaultSession());
    const relaunched = await Effect.runPromise(
      createRegisteredChildStream(
        defaultSession(),
        workflowRelaunchExecutionId,
        parentStreamId,
        {
          streamPrefix: 'workflow-script',
          run: { kind: 'multiAgentWorkflow', workflowName: 'draft-sections' },
          userFollowUpSupport: 'unsupported',
          description: 'Resume the named child task',
          config,
        },
      ),
    );

    try {
      expect(defaultSession().status.get(workflowRelaunchChildStreamId)).toBe(
        STREAM_PHASE.RUNNING,
      );
      expect(
        defaultSession().executions.getActiveChildren(parentStreamId),
      ).toContainEqual(
        expect.objectContaining({
          childStreamId: workflowRelaunchChildStreamId,
          executionId: workflowRelaunchExecutionId,
          status: STREAM_PHASE.RUNNING,
        }),
      );
      expect(eventsOfType(await recorded.read(), 'status')).toContainEqual(
        expect.objectContaining({
          cause: 'resume',
          phase: STREAM_PHASE.RUNNING,
          previousPhase: STREAM_PHASE.COMPLETED,
          aggregateId: qualifyAggregateId(
            'stream',
            workflowRelaunchChildStreamId,
          ),
        }),
      );
    } finally {
      await Effect.runPromise(
        relaunched.finalize({ outcome: RUN_OUTCOME.COMPLETED }),
      );
    }
  });

  it('rolls back a failed rehydrated setup so the same stream can retry', async () => {
    const recorded = recordSessionEvents(defaultSession());
    const trackExecution = vi
      .spyOn(defaultSession().executions, 'trackAgentExecution')
      .mockImplementationOnce(() => {
        throw new Error('execution setup failed');
      });
    const options = {
      streamPrefix: 'workflow-script',
      run: {
        kind: 'multiAgentWorkflow' as const,
        workflowName: 'retry-setup',
      },
      userFollowUpSupport: 'unsupported' as const,
      description: 'Retry a failed child stream setup',
      config,
    };

    try {
      await expect(
        Effect.runPromise(
          createRegisteredChildStream(
            defaultSession(),
            setupRetryExecutionId,
            parentStreamId,
            options,
          ),
        ),
      ).rejects.toThrow('execution setup failed');
      expect(
        eventsOfType(await recorded.read(), 'stream.removed').map(
          (event) => event.aggregateId,
        ),
      ).not.toContain(qualifyAggregateId('stream', setupRetryChildStreamId));
      // Setup failed after the existence fact, so the started stream ended
      // with its terminal result instead of lingering as a ghost.
      expect(eventsOfType(await recorded.read(), 'result')).toContainEqual(
        expect.objectContaining({
          aggregateId: qualifyAggregateId('stream', setupRetryChildStreamId),
          outcome: RUN_OUTCOME.FAILED,
          isSubagent: true,
        }),
      );

      const retried = await Effect.runPromise(
        createRegisteredChildStream(
          defaultSession(),
          setupRetryExecutionId,
          parentStreamId,
          options,
        ),
      );
      expect(retried.childStreamId).toBe(setupRetryChildStreamId);
      expect(
        eventsOfType(await recorded.read(), 'run.start').filter(
          (event) =>
            event.aggregateId ===
            qualifyAggregateId('stream', setupRetryChildStreamId),
        ),
      ).toHaveLength(1);
      expect(
        eventsOfType(await recorded.read(), 'run.activate').filter(
          (event) =>
            event.aggregateId ===
            qualifyAggregateId('stream', setupRetryChildStreamId),
        ),
      ).toHaveLength(2);
      await Effect.runPromise(
        retried.finalize({ outcome: RUN_OUTCOME.COMPLETED }),
      );
    } finally {
      trackExecution.mockRestore();
    }
  });

  it('emits workflow-script identity independently of its worker config', async () => {
    const recorded = recordSessionEvents(defaultSession());
    const workerConfig = {
      ...config,
      agent: 'generic',
      agentCategory: AgentCategory.Workflow,
    };

    const childStream = await Effect.runPromise(
      createRegisteredChildStream(
        defaultSession(),
        workflowRelaunchExecutionId,
        parentStreamId,
        {
          streamPrefix: 'workflow-script',
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
      defaultSession().executions.getAgentHandleByStream(
        workflowRelaunchChildStreamId,
      ),
    ).toMatchObject({
      agentName: 'repo-cleanup-readonly-pilot-2026-07-24',
      category: AgentCategory.Workflow,
    });

    await Effect.runPromise(
      childStream.finalize({ outcome: RUN_OUTCOME.COMPLETED }),
    );
  });

  it('publishes child stream existence as a run fact without direct host emission', async () => {
    const active = createRecordingHost();
    const recorded = recordSessionEvents(defaultSession());

    const childStream = await startBashChild(executionId);

    expect(active.events).toEqual([]);
    expect(eventsOfType(await recorded.read(), 'run.start')).toEqual([
      expect.objectContaining({
        type: 'run.start',
        aggregateId: qualifyAggregateId('stream', childStreamId),
        category: AgentCategory.ToolUse,
        parentStreamId,
      }),
    ]);

    await Effect.runPromise(
      childStream.finalize({ outcome: RUN_OUTCOME.COMPLETED }),
    );
  });

  it('releases completed child presentation without direct host emission', async () => {
    const active = createRecordingHost();
    const recorded = recordSessionEvents(defaultSession());

    const childStream = await startBashChild(noProjectionAutoCloseExecutionId);

    await Effect.runPromise(
      childStream.finalize({
        outcome: RUN_OUTCOME.COMPLETED,
        autoClose: true,
      }),
    );

    expect(active.events).toEqual([]);
    expect(eventsOfType(await recorded.read(), 'stream.removed')).toEqual([]);
    expect(
      defaultSession().transcripts.has(noProjectionAutoCloseChildStreamId),
    ).toBe(true);
  });

  it('retains completed command history after automatic presentation release', async () => {
    const recorded = recordSessionEvents(defaultSession());

    const childStream = await startBashChild(executionId);
    childStream.logger.info('retained command output');

    await Effect.runPromise(
      childStream.finalize({
        outcome: RUN_OUTCOME.COMPLETED,
        autoClose: true,
      }),
    );

    expect(eventsOfType(await recorded.read(), 'stream.removed')).toEqual([]);
    const entries = await Effect.runPromise(
      defaultSession().transcripts.readEntries(childStreamId),
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
        const committed = yield* Deferred.make<ExecutionId>();
        const releasePublication = yield* Deferred.make<void>();
        const commit = session.commitRegistration.bind(session);
        const publication = vi
          .spyOn(session, 'commitRegistration')
          .mockImplementationOnce((events) =>
            commit(events).pipe(
              Effect.tap((rows) => {
                const start = rows.find((row) => row.type === 'run.start');
                if (!start) throw new Error('expected a committed child birth');
                return Deferred.succeed(committed, start.executionId);
              }),
              Effect.tap(() => Deferred.await(releasePublication)),
            ),
          );
        const startLoop = vi.fn(() => Effect.void);
        try {
          const launching = yield* Effect.forkChild(
            launchAgentCliSession({
              session,
              parentStreamId,
              parentExecutionId: undefined,
              agentName: 'codex',
              streamPrefix: 'codex',
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
          expect(
            (yield* getExecutionRecords(session, id).readMeta())?.outcome,
          ).toBe(RUN_OUTCOME.CANCELLED);
          expect(
            yield* Effect.promise(() =>
              runInSession(session, () => inspectExecutionLease(id)),
            ),
          ).toEqual({ status: 'free' });
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                getExecutionRecords(session, id).writeReport('unowned'),
              ),
            ),
          ).toBe(true);
        } finally {
          publication.mockRestore();
        }
      }),
  );

  it.effect(
    'finalizes a child stream when agent CLI loop setup fails synchronously',
    () =>
      Effect.gen(function* () {
        const setupError = new Error('child loop setup failed');
        const session = defaultSession();
        const recorded = recordSessionEvents(session);
        let childStream: ChildStream | undefined;
        let childExecutionId: ExecutionId | undefined;
        let handle: ReturnType<
          typeof session.executions.getAgentHandleByStream
        >;

        try {
          // `reraiseAgentCliCallFailure` re-raises the loop's throw as a
          // defect, so flip the defect back into the error channel.
          const defect = yield* Effect.flip(
            reraiseAgentCliCallFailure(
              launchAgentCliSession({
                session: defaultSession(),
                parentStreamId,
                parentExecutionId: undefined,
                agentName: 'codex',
                streamPrefix: 'codex',
                description: 'Fail during synchronous loop setup',
                config,
                registerFailedMessage: 'registration failed',
                startLoop: (context) => {
                  childStream = context.childStream;
                  childExecutionId = context.executionId;
                  handle = session.executions.getAgentHandleByStream(
                    context.childStream.childStreamId,
                  );
                  throw setupError;
                },
                summary: 'unreachable',
                launchedLine: 'unreachable',
                followUpLine: 'unreachable',
              }),
            ).pipe(Effect.catchDefect((cause) => Effect.fail(cause))),
          );
          expect(defect).toBe(setupError);

          expect(childStream).toBeDefined();
          expect(childExecutionId).toBeDefined();
          expect(handle).toBeDefined();
          if (!childStream || !childExecutionId || !handle) {
            throw new Error('expected the failed child launch to be captured');
          }
          expect(
            session.executions.getHandle(childExecutionId),
          ).toBeUndefined();
          expect(session.status.get(childStream.childStreamId)).toBe(
            STREAM_PHASE.FAILED,
          );
          const failedHandle = handle;
          const result = yield* failedHandle.result;
          expect(result).toMatchObject({
            type: 'result',
            outcome: 'failed',
            executionId: childExecutionId,
            streamId: childStream.childStreamId,
          });
        } finally {
          if (childStream) {
            clearStreamStatusForTest(session.status, childStream.childStreamId);
          }
        }
      }),
  );

  it('publishes child loop status changes through the child stream owner', async () => {
    const childStream = await startCodexChild(
      loopExecutionId,
      'Run a long-lived Codex child loop',
    );
    const handle =
      defaultSession().executions.getAgentHandleByStream(loopChildStreamId);
    expect(handle).toBeDefined();
    // From here on: the launch's own facts are not the loop's.
    const recorded = recordSessionEvents(defaultSession());
    const rosters = recordChildRosters(defaultSession().executions);

    childStream.waitForInput();
    childStream.beginTurn();
    childStream.failTurn();
    await Effect.runPromise(
      childStream.finalize({ outcome: RUN_OUTCOME.FAILED }),
    );

    expect(
      eventsOfType(await recorded.read(), 'status')
        .filter(
          (event) =>
            event.aggregateId ===
            qualifyAggregateId('stream', loopChildStreamId),
        )
        .map((event) => event.phase),
    ).toEqual([
      STREAM_PHASE.WAITING,
      STREAM_PHASE.RUNNING,
      STREAM_PHASE.FAILED,
    ]);
    expect(defaultSession().status.get(loopChildStreamId)).toBe(
      STREAM_PHASE.FAILED,
    );
    expect(rosters.rosters.at(-1)).toMatchObject({
      parentStreamId,
      items: [],
    });
    await expect(Effect.runPromise(handle!.result)).resolves.toMatchObject({
      type: 'result',
      outcome: 'failed',
      error: {
        kind: 'unexpected',
        message: 'Child stream failed',
      },
    });
  });

  // The child reports its own exit and nothing else: every mid-loop report
  // below is refused by the status machine because a stop already cancelled
  // the stream, and `finalizeRunTerminal` resolves the run's terminal outcome
  // from that phase rather than from the failure the child reports.
  it('settles a stopped child loop as cancelled from the stream phase', async () => {
    const childStream = await startCodexChild(
      stoppedExecutionId,
      'Run a stopped Codex child loop',
    );
    const handle =
      defaultSession().executions.getAgentHandleByStream(stoppedChildStreamId);
    expect(handle).toBeDefined();
    seedStreamStatusForTest(defaultSession().status, stoppedChildStreamId, {
      phase: STREAM_PHASE.CANCELLED,
    });
    // From here on: the launch's own facts are not the loop's.
    const recorded = recordSessionEvents(defaultSession());

    childStream.waitForInput();
    childStream.beginTurn();
    childStream.failTurn();
    await Effect.runPromise(
      childStream.finalize({ outcome: RUN_OUTCOME.FAILED }),
    );

    expect(defaultSession().status.get(stoppedChildStreamId)).toBe(
      STREAM_PHASE.CANCELLED,
    );
    expect(
      eventsOfType(await recorded.read(), 'status').filter(
        (event) =>
          event.aggregateId ===
          qualifyAggregateId('stream', stoppedChildStreamId),
      ),
    ).toHaveLength(0);
    await expect(Effect.runPromise(handle!.result)).resolves.toMatchObject({
      type: 'result',
      outcome: 'cancelled',
      executionId: stoppedExecutionId,
      streamId: stoppedChildStreamId,
    });
  });

  it('settles child handle results as cancelled for stopped finalization', async () => {
    const childStream = await startCodexChild(
      cancelledExecutionId,
      'Run an interrupted Codex child loop',
    );
    const handle = defaultSession().executions.getAgentHandleByStream(
      cancelledChildStreamId,
    );
    expect(handle).toBeDefined();

    await Effect.runPromise(
      childStream.finalize({ outcome: RUN_OUTCOME.CANCELLED }),
    );

    await expect(Effect.runPromise(handle!.result)).resolves.toMatchObject({
      type: 'result',
      outcome: 'cancelled',
      executionId: cancelledExecutionId,
      streamId: cancelledChildStreamId,
    });
  });

  it('settles failed child handle results with error details', async () => {
    const childStream = await startCodexChild(
      failedExecutionId,
      'Run a failing Codex child loop',
    );
    const handle =
      defaultSession().executions.getAgentHandleByStream(failedChildStreamId);
    expect(handle).toBeDefined();

    await Effect.runPromise(
      childStream.finalize({
        outcome: RUN_OUTCOME.FAILED,
        error: new Error('child process exited 1'),
      }),
    );

    expect(defaultSession().status.get(failedChildStreamId)).toBe(
      STREAM_PHASE.FAILED,
    );
    await expect(Effect.runPromise(handle!.result)).resolves.toMatchObject({
      type: 'result',
      outcome: 'failed',
      executionId: failedExecutionId,
      streamId: failedChildStreamId,
      error: {
        kind: 'unexpected',
        message: 'child process exited 1',
      },
    });
  });
});
