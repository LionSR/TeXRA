// Test composition imports

// Local imports
import '@test/support/defaultSessionTestSetup';

// Test support imports

// Node imports
import { setTimeout as sleep } from 'node:timers/promises';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import {
  isChildRunLoopActive,
  startChildRunLoop,
} from '@agent/runtime/childRunLoop';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { AgentFlowError } from '@agent/runtime/AgentFlowResult';
import { AgentExecutionHandle } from '@agent/runtime/ExecutionHandle';
import { defaultSession, SessionHandle } from '@agent/runtime/SessionHandle';
import {
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  enqueueChildRunFollowUp: vi.fn(),
  wakeChildRunFollowUp: vi.fn(),
  executeAgent: vi.fn(),
  finalizeExecution: vi.fn(),
  persistChildRunReport: vi.fn(),
  persistChildRunResultMeta: vi.fn(),
  readConfig: vi.fn(),
  resumeToolUseFromResumeData: vi.fn(),
  retrieveSessionResumeData: vi.fn(),
  synchronizeAgentResultOutcome: vi.fn(),
}));

vi.mock('@agent/runtime/executeAgent', () => ({
  executeAgent: mocks.executeAgent,
  resumeToolUseFromResumeData: mocks.resumeToolUseFromResumeData,
}));

vi.mock('@agent/storage', () => ({
  finalizeExecution: mocks.finalizeExecution,
  getExecutionStore: vi.fn(() => ({ readConfig: mocks.readConfig })),
  synchronizeAgentResultOutcome: mocks.synchronizeAgentResultOutcome,
}));

vi.mock('@agent/storage/executionLease', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/storage/executionLease')>()),
  runWithOwnedExecutionLease: (
    _executionId: ExecutionId,
    operation: () => unknown,
  ) => operation(),
}));

vi.mock('@agent/runtime/executionOwnership', () => ({
  releaseExecutionLeaseAfterArtifacts: vi.fn(async () => {}),
}));

vi.mock('@agent/runtime/SessionResumeRetrieval', () => ({
  retrieveSessionResumeData: mocks.retrieveSessionResumeData,
}));

vi.mock('@tools/childRunDelivery', () => ({
  enqueueChildRunFollowUp: mocks.enqueueChildRunFollowUp,
  wakeChildRunFollowUp: mocks.wakeChildRunFollowUp,
  persistChildRunReport: mocks.persistChildRunReport,
  persistChildRunResultMeta: mocks.persistChildRunResultMeta,
}));
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';
import { createTestSession } from '@test/support/sessionTestUtils';
import { createNativeSubagentStrategy } from '@tools/delegation/nativeSubagentStrategy';

const ownedSessions = new Set<SessionHandle>();

function fakePorts() {
  return { notify: vi.fn(), recordCost: vi.fn() };
}

function baseParams(
  parentSession = createTestSession(),
  agentCategory: 'toolUse' | 'workflow' = 'toolUse',
) {
  if (parentSession !== defaultSession()) ownedSessions.add(parentSession);
  return {
    config: AgentConfigSchema.parse({
      agent: 'review',
      model: 'gpt5',
      agentCategory,
    }),
    agentCategoryExplicit: true,
    executionId: 'exec-1' as ExecutionId,
    agentName: 'review',
    orchestratorStreamId: 'orchestrator-stream' as StreamTabId,
    parentSession,
    interactions: { emit: vi.fn() } as never,
    startedAt: Date.now(),
    onStreamResolved: vi.fn(),
  };
}

describe('NativeSubagentStrategy', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.enqueueChildRunFollowUp.mockResolvedValue({
      kind: 'enqueued',
      sendResult: { status: 'sent' },
    });
    mocks.wakeChildRunFollowUp.mockResolvedValue({ kind: 'delivered' });
    mocks.persistChildRunReport.mockResolvedValue({ kind: 'persisted' });
    mocks.persistChildRunResultMeta.mockResolvedValue({ kind: 'skipped' });
    mocks.finalizeExecution.mockResolvedValue({
      status: 'durable',
      terminalStatusPersisted: true,
      flowRecord: 'deleted',
    });
    mocks.synchronizeAgentResultOutcome.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const session of ownedSessions) session.dispose();
    ownedSessions.clear();
  });

  it('resolveDeliveryTarget follows the live run handle, including after detach', async () => {
    const params = baseParams();
    const strategy = createNativeSubagentStrategy(params);

    // Before any turn ran, falls back to the static orchestrator stream.
    expect(strategy.resolveDeliveryTarget?.()).toBe(
      params.orchestratorStreamId,
    );

    let capturedOnRun: ((handle: unknown) => void) | undefined;
    mocks.executeAgent.mockImplementationOnce(async (_config, _id, options) => {
      capturedOnRun = options.onRun;
      capturedOnRun?.({
        childStreamId: 'child-stream' as StreamTabId,
        deliveryTargetStreamId: params.orchestratorStreamId,
      });
      return {
        category: 'toolUse',
        outcome: STREAM_PHASE.WAITING,
        executionId: params.executionId,
        streamId: 'child-stream' as StreamTabId,
      };
    });

    await strategy.launch(fakePorts(), new AbortController());
    expect(mocks.executeAgent).toHaveBeenLastCalledWith(
      params.config,
      params.executionId,
      expect.objectContaining({ enforceCategory: true }),
    );
    expect(strategy.resolveDeliveryTarget?.()).toBe(
      params.orchestratorStreamId,
    );

    // Detach: the same handle object's deliveryTargetStreamId flips to
    // undefined (AgentExecutionHandle.detach) — the strategy must track the
    // LIVE handle, not a stale copy, so it observes this without a new turn.
    const liveHandle = {
      childStreamId: 'child-stream',
      deliveryTargetStreamId: params.orchestratorStreamId as
        StreamTabId | undefined,
    };
    mocks.executeAgent.mockImplementationOnce(async (_config, _id, options) => {
      options.onRun?.(liveHandle);
      return {
        category: 'toolUse',
        outcome: STREAM_PHASE.WAITING,
        executionId: params.executionId,
        streamId: 'child-stream' as StreamTabId,
      };
    });
    await strategy.launch(fakePorts(), new AbortController());
    expect(strategy.resolveDeliveryTarget?.()).toBe(
      params.orchestratorStreamId,
    );
    liveHandle.deliveryTargetStreamId = undefined;
    expect(strategy.resolveDeliveryTarget?.()).toBeUndefined();
  });

  it('uses the same launch primitive in durable single-cycle mode', async () => {
    const params = {
      ...baseParams(),
      executionMode: 'single-cycle' as const,
      workflowPhase: 'review',
    };
    const strategy = createNativeSubagentStrategy(params);
    const ports = fakePorts();
    const progress = { message: 'Reading proof' };

    mocks.executeAgent.mockImplementationOnce(async (_config, _id, options) => {
      options.onStreamResolved?.('child-stream');
      options.onProgress?.(progress);
      return {
        category: 'toolUse',
        outcome: 'completed',
        executionId: params.executionId,
        streamId: 'child-stream' as StreamTabId,
        totalCostUsd: 0.17,
      };
    });

    await strategy.launch(ports, new AbortController());

    expect(mocks.executeAgent).toHaveBeenCalledWith(
      params.config,
      params.executionId,
      expect.objectContaining({
        allowWaitingResult: true,
        enforceCategory: true,
        parentStreamId: params.orchestratorStreamId,
        stopAfterCycle: true,
        workflowPhase: 'review',
      }),
    );
    expect(params.onStreamResolved).toHaveBeenCalledWith('child-stream');
    expect(ports.notify).toHaveBeenCalledWith(progress);
    expect(ports.recordCost).toHaveBeenCalledWith(0.17);
  });

  it('records a thrown AgentFlowError cost once through interactive loop settlement', async () => {
    const params = baseParams();
    const recordCost = vi.fn();
    mocks.executeAgent.mockRejectedValueOnce(
      new AgentFlowError('provider failed', {
        category: 'toolUse',
        outcome: 'failed',
        executionId: params.executionId,
        streamId: 'child-stream',
        totalCostUsd: 0.29,
      }),
    );

    const { completion } = startChildRunLoop({
      childStreamId: 'child-stream',
      parentStreamId: params.orchestratorStreamId,
      executionId: params.executionId,
      agentName: params.agentName,
      strategy: createNativeSubagentStrategy(params),
      recordCost,
    });
    await completion;

    expect(recordCost).toHaveBeenCalledOnce();
    expect(recordCost).toHaveBeenCalledWith(0.29);
    expect(mocks.persistChildRunResultMeta).toHaveBeenCalledWith(
      params.executionId,
      expect.objectContaining({
        result: expect.objectContaining({ cost: 0.29, outcome: 'failed' }),
      }),
    );
  });

  it('interrupts when the turn aborts before launch publishes its handle', async () => {
    const turn = new AbortController();
    turn.abort();
    const interrupt = vi.fn();
    const strategy = createNativeSubagentStrategy(baseParams());
    mocks.executeAgent.mockImplementationOnce(async (_config, _id, options) => {
      options.onRun?.({ interrupt } as never);
      return {
        category: 'toolUse',
        outcome: 'cancelled',
        executionId: 'exec-1',
        streamId: 'child-stream',
      };
    });

    await strategy.launch(fakePorts(), turn);

    expect(interrupt).toHaveBeenCalledOnce();
  });

  it('interrupts once for an already-aborted external signal', async () => {
    const external = new AbortController();
    external.abort();
    const interrupt = vi.fn();
    const strategy = createNativeSubagentStrategy({
      ...baseParams(),
      signal: external.signal,
    });
    mocks.executeAgent.mockImplementationOnce(async (_config, _id, options) => {
      options.onRun?.({ interrupt } as never);
      return {
        category: 'toolUse',
        outcome: 'cancelled',
        executionId: 'exec-1',
        streamId: 'child-stream',
      };
    });

    await strategy.launch(fakePorts(), new AbortController());

    expect(interrupt).toHaveBeenCalledOnce();
  });

  it('deduplicates the same external and per-turn abort signal', async () => {
    const controller = new AbortController();
    const interrupt = vi.fn();
    const strategy = createNativeSubagentStrategy({
      ...baseParams(),
      signal: controller.signal,
    });
    mocks.executeAgent.mockImplementationOnce(async (_config, _id, options) => {
      options.onRun?.({ interrupt } as never);
      controller.abort();
      return {
        category: 'toolUse',
        outcome: 'cancelled',
        executionId: 'exec-1',
        streamId: 'child-stream',
      };
    });

    await strategy.launch(fakePorts(), controller);

    expect(interrupt).toHaveBeenCalledOnce();
  });

  it('removes abort listeners after launch and ignores later aborts', async () => {
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const interrupt = vi.fn();
    const strategy = createNativeSubagentStrategy(baseParams());
    mocks.executeAgent.mockImplementationOnce(async (_config, _id, options) => {
      options.onRun?.({ interrupt } as never);
      return {
        category: 'toolUse',
        outcome: 'completed',
        executionId: 'exec-1',
        streamId: 'child-stream',
      };
    });

    await strategy.launch(fakePorts(), controller);
    controller.abort();

    expect(addListener).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledOnce();
    expect(interrupt).not.toHaveBeenCalled();
  });

  it('binds resumed-turn cancellation to the replacement run handle', async () => {
    const params = baseParams();
    const childStreamId = 'child-stream' as StreamTabId;
    const initialHandle = {
      childStreamId,
      deliveryTargetStreamId: params.orchestratorStreamId,
      interrupt: vi.fn(),
    };
    mocks.executeAgent.mockImplementationOnce(async (_config, _id, options) => {
      options.onRun?.(initialHandle as never);
      return {
        category: 'toolUse',
        outcome: STREAM_PHASE.WAITING,
        executionId: params.executionId,
        streamId: childStreamId,
      };
    });
    const strategy = createNativeSubagentStrategy(params);
    await strategy.launch(fakePorts(), new AbortController());

    mocks.readConfig.mockResolvedValue({ agentCategory: 'toolUse' });
    mocks.retrieveSessionResumeData.mockResolvedValue(
      createToolUseResumeData({ executionId: params.executionId }),
    );
    const turn = new AbortController();
    const replacementInterrupt = vi.fn();
    let replacementReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      replacementReady = resolve;
    });
    mocks.resumeToolUseFromResumeData.mockImplementationOnce(
      async (_resume, options) => {
        options.onRun?.({
          childStreamId,
          deliveryTargetStreamId: params.orchestratorStreamId,
          interrupt: replacementInterrupt,
        } as never);
        replacementReady();
        await new Promise<void>((resolve) =>
          turn.signal.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
        return {
          category: 'toolUse',
          outcome: 'cancelled',
          executionId: params.executionId,
          streamId: childStreamId,
        };
      },
    );

    const resumed = strategy.runTurn!([], fakePorts(), turn);
    await ready;
    turn.abort();
    await resumed;

    expect(initialHandle.interrupt).not.toHaveBeenCalled();
    expect(replacementInterrupt).toHaveBeenCalledOnce();
  });

  it('formatDelivery folds a WAITING turn into a completed-shaped delivery', async () => {
    const params = baseParams();
    const strategy = createNativeSubagentStrategy(params);

    const waitingTurn = {
      category: 'toolUse' as const,
      outcome: STREAM_PHASE.WAITING,
      lastResponse: 'The proof holds.',
      touchedFiles: ['main.tex'],
      executionId: params.executionId,
      streamId: 'child-stream' as StreamTabId,
    };

    const msg = await strategy.formatDelivery(waitingTurn, 1000);
    expect(msg).toContain('<response>');
    expect(msg).toContain('The proof holds.');
    expect(msg).toContain('status="completed"');
  });

  it('reports a non-throwing subagent failure via isTurnError, captured from onRunError', async () => {
    const params = baseParams();
    const strategy = createNativeSubagentStrategy(params);
    const failure = new Error('model overloaded');

    mocks.executeAgent.mockImplementationOnce(async (_config, _id, options) => {
      options.onRunError?.(failure);
      return {
        category: 'toolUse',
        outcome: 'failed',
        executionId: params.executionId,
        streamId: 'child-stream' as StreamTabId,
      };
    });

    const turn = await strategy.launch(fakePorts(), new AbortController());
    expect(strategy.isTurnError?.(turn)).toBe(true);

    const errMsg = await strategy.formatError(turn, null);
    expect(errMsg).toContain('model overloaded');
  });

  it('persists a typed tool-use failure when no flow result exists', async () => {
    const strategy = createNativeSubagentStrategy(baseParams());

    await expect(
      strategy.buildResultMeta?.(null, true, 10),
    ).resolves.toMatchObject({
      producer: 'subagent',
      agentName: 'review',
      result: {
        category: 'toolUse',
        outcome: 'failed',
        response: '',
        files: [],
        cost: 0,
      },
    });
  });

  it('runTurn hands its consumed batch directly to the persisted flow cursor', async () => {
    const params = {
      ...baseParams(),
      approvalPromptsUnavailable: true,
      runtimeUnavailableTools: ['ask_user'],
    };
    const strategy = createNativeSubagentStrategy(params);
    const childStreamId = 'child-stream' as StreamTabId;

    mocks.executeAgent.mockResolvedValueOnce({
      category: 'toolUse',
      outcome: STREAM_PHASE.WAITING,
      executionId: params.executionId,
      streamId: childStreamId,
    });
    await strategy.launch(fakePorts(), new AbortController());
    // launch() only carries `deliveryTargetStreamId`/`childStreamId` on the
    // handle shape the strategy actually reads.
    mocks.executeAgent.mock.calls.at(-1)?.[2].onRun?.({
      childStreamId,
      deliveryTargetStreamId: params.orchestratorStreamId,
    });

    const config = { agentCategory: 'toolUse' };
    const snapshot = createToolUseResumeData({
      executionId: params.executionId,
      streamId: childStreamId,
    });
    mocks.readConfig.mockResolvedValue(config);
    mocks.retrieveSessionResumeData.mockResolvedValue(snapshot);
    mocks.resumeToolUseFromResumeData.mockResolvedValueOnce({
      category: 'toolUse',
      outcome: 'completed',
      lastResponse: 'done',
      executionId: params.executionId,
      streamId: childStreamId,
    });

    const turn = await strategy.runTurn!(
      [{ text: 'keep going', origin: 'user' }],
      fakePorts(),
      new AbortController(),
    );

    expect(mocks.retrieveSessionResumeData).toHaveBeenCalledWith(
      childStreamId,
      params.executionId,
      config,
    );
    expect(mocks.resumeToolUseFromResumeData).toHaveBeenCalledWith(
      snapshot,
      expect.objectContaining({
        approvalPromptsUnavailable: true,
        parentStreamId: params.orchestratorStreamId,
        drainedFollowUps: [
          {
            text: 'keep going',
            displayText: undefined,
            mediaFiles: undefined,
            origin: 'user',
          },
        ],
        runtimeUnavailableTools: ['ask_user'],
        session: params.parentSession,
      }),
    );
    expect(strategy.isTerminal(turn)).toBe(true);
  });

  it('preserves #7491: a failed direct resume throws for child-loop error delivery', async () => {
    const params = baseParams();
    const strategy = createNativeSubagentStrategy(params);
    const childStreamId = 'child-stream' as StreamTabId;

    mocks.executeAgent.mockResolvedValueOnce({
      category: 'toolUse',
      outcome: STREAM_PHASE.WAITING,
      executionId: params.executionId,
      streamId: childStreamId,
    });
    await strategy.launch(fakePorts(), new AbortController());
    mocks.executeAgent.mock.calls.at(-1)?.[2].onRun?.({
      childStreamId,
      deliveryTargetStreamId: params.orchestratorStreamId,
    });

    mocks.readConfig.mockResolvedValue({ agentCategory: 'toolUse' });
    mocks.retrieveSessionResumeData.mockResolvedValue(
      createToolUseResumeData({ executionId: params.executionId }),
    );
    const resumeError = new Error('resume storage unreadable');
    mocks.resumeToolUseFromResumeData.mockRejectedValueOnce(resumeError);

    await expect(
      strategy.runTurn!([], fakePorts(), new AbortController()),
    ).rejects.toBe(resumeError);
  });

  it('consumes one child-loop follow-up in one resumed WAITING turn without requeueing it', async () => {
    const session = defaultSession();
    const childStreamId = 'native-follow-up-loop-child' as StreamTabId;
    const parentStreamId = 'native-follow-up-loop-parent' as StreamTabId;
    const executionId = 'native-follow-up-loop-exec' as ExecutionId;
    const interactions = { emit: vi.fn() } as never;
    const handle = new AgentExecutionHandle(
      executionId,
      parentStreamId,
      childStreamId,
      'review',
      'toolUse',
    );
    const params = {
      ...baseParams(session),
      executionId,
      orchestratorStreamId: parentStreamId,
      interactions,
    };
    const waitingTurn = (lastResponse: string) => ({
      category: 'toolUse' as const,
      outcome: STREAM_PHASE.WAITING,
      lastResponse,
      executionId,
      streamId: childStreamId,
    });

    mocks.executeAgent.mockImplementationOnce(
      async (_config, _executionId, options) => {
        session.status.transition(
          childStreamId,
          STREAM_PHASE.RUNNING,
          'lifecycle',
        );
        session.executions.trackAgentExecution(handle, {
          status: STREAM_PHASE.RUNNING,
        });
        options.onStreamResolved?.(childStreamId);
        options.onRun?.(handle);
        session.status.transitionToWaiting(childStreamId, 'wait');
        return waitingTurn('initial response');
      },
    );
    const config = AgentConfigSchema.parse({
      agent: 'review',
      model: 'gpt5',
      agentCategory: 'toolUse',
    });
    const resume = createToolUseResumeData({
      agentConfig: config,
      executionId,
      streamId: childStreamId,
    });
    mocks.readConfig.mockResolvedValue(config);
    mocks.retrieveSessionResumeData.mockResolvedValue(resume);
    mocks.resumeToolUseFromResumeData.mockImplementation(
      async (_snapshot, options) => {
        if (mocks.resumeToolUseFromResumeData.mock.calls.length > 1) {
          throw new Error('the same follow-up batch resumed more than once');
        }
        options.onRun?.(handle);
        session.status.transitionToWaiting(childStreamId, 'wait');
        return waitingTurn('follow-up response');
      },
    );

    const strategy = createNativeSubagentStrategy(params);
    try {
      startChildRunLoop({
        childStreamId,
        parentStreamId,
        executionId,
        agentName: params.agentName,
        strategy,
      });
      await vi.waitFor(() =>
        expect(mocks.enqueueChildRunFollowUp).toHaveBeenCalledTimes(1),
      );

      session.followUps.acquire(childStreamId).enqueue({
        text: 'Also state exactly where finiteness is used.',
        origin: 'user',
      });

      await vi.waitFor(() =>
        expect(mocks.resumeToolUseFromResumeData).toHaveBeenCalledTimes(1),
      );
      await vi.waitFor(() =>
        expect(mocks.enqueueChildRunFollowUp).toHaveBeenCalledTimes(2),
      );
      // Give an accidentally re-enqueued batch enough time to start a second
      // immediate resume. The guarded mock above prevents an actual busy loop.
      await sleep(50);

      expect(mocks.resumeToolUseFromResumeData).toHaveBeenCalledTimes(1);
      expect(mocks.resumeToolUseFromResumeData.mock.calls[0]?.[0]).toEqual(
        resume,
      );
      expect(
        mocks.resumeToolUseFromResumeData.mock.calls[0]?.[1].drainedFollowUps,
      ).toEqual([
        {
          text: 'Also state exactly where finiteness is used.',
          displayText: undefined,
          mediaFiles: undefined,
          origin: 'user',
        },
      ]);
      expect(session.followUps.getAll(childStreamId)).toEqual([]);
      expect(session.status.get(childStreamId)).toBe(STREAM_PHASE.WAITING);
      const resumedDeliveries = mocks.enqueueChildRunFollowUp.mock.calls.filter(
        ([delivery]) => delivery.followUp.text.includes('follow-up response'),
      );
      expect(resumedDeliveries).toHaveLength(1);
    } finally {
      const handleWasTracked =
        session.executions.getHandle(executionId) !== undefined;
      if (isChildRunLoopActive(childStreamId)) handle.interrupt();
      await vi.waitFor(() =>
        expect(isChildRunLoopActive(childStreamId)).toBe(false),
      );
      if (handleWasTracked) await handle.result;
      if (session.executions.getHandle(executionId)) {
        session.executions.untrack(executionId);
      }
      session.followUps.release(childStreamId);
      session.status.clearStream(childStreamId);
    }
  });

  it('records the run cumulative cost via ports.recordCost on every turn', async () => {
    const params = baseParams();
    const strategy = createNativeSubagentStrategy(params);
    const ports = fakePorts();

    mocks.executeAgent.mockResolvedValueOnce({
      category: 'toolUse',
      outcome: STREAM_PHASE.WAITING,
      executionId: params.executionId,
      streamId: 'child-stream' as StreamTabId,
      totalCostUsd: 0.42,
    });

    await strategy.launch(ports, new AbortController());
    expect(ports.recordCost).toHaveBeenCalledWith(0.42);
  });

  it('derives stageLabel/isTerminal/buildResultMeta from a workflow-category config', async () => {
    const params = baseParams(createTestSession(), 'workflow');
    const strategy = createNativeSubagentStrategy(params);

    expect(strategy.stageLabel).toBe('Native workflow subagent');

    const completedWorkflowTurn = {
      category: 'workflow' as const,
      outcome: 'completed' as const,
      outputs: [],
      compileFailures: [],
      executionId: params.executionId,
      streamId: 'child-stream' as StreamTabId,
    };
    // A workflow flow never produces a WAITING result, so every turn is
    // terminal — `isWaitingFlowResult` requires `category === 'toolUse'`.
    expect(strategy.isTerminal(completedWorkflowTurn)).toBe(true);

    await expect(
      strategy.buildResultMeta?.(null, true, 10),
    ).resolves.toMatchObject({
      producer: 'subagent',
      agentName: 'review',
      result: {
        category: 'workflow',
        outcome: 'failed',
      },
    });
  });

  it('never reaches runTurn for a workflow child — the loop breaks on the first terminal turn', async () => {
    const session = defaultSession();
    const childStreamId = 'native-workflow-loop-child' as StreamTabId;
    const parentStreamId = 'native-workflow-loop-parent' as StreamTabId;
    const executionId = 'native-workflow-loop-exec' as ExecutionId;
    const interactions = { emit: vi.fn() } as never;
    const params = {
      ...baseParams(session, 'workflow'),
      executionId,
      orchestratorStreamId: parentStreamId,
      interactions,
    };

    mocks.executeAgent.mockResolvedValueOnce({
      category: 'workflow',
      outcome: 'completed',
      outputs: [],
      compileFailures: [],
      executionId,
      streamId: childStreamId,
    });

    const strategy = createNativeSubagentStrategy(params);
    // `runTurn` is present on the merged strategy (unlike workflow-script's
    // strategy), but the loop must never call it for a workflow child: the
    // first turn is always terminal, and `childRunLoop.ts` breaks on a
    // terminal turn before ever consulting `runTurn`.
    expect(strategy.runTurn).toBeDefined();

    try {
      startChildRunLoop({
        childStreamId,
        parentStreamId,
        executionId,
        agentName: params.agentName,
        strategy,
      });

      await vi.waitFor(() =>
        expect(mocks.enqueueChildRunFollowUp).toHaveBeenCalledTimes(1),
      );
      await vi.waitFor(() =>
        expect(isChildRunLoopActive(childStreamId)).toBe(false),
      );

      expect(mocks.resumeToolUseFromResumeData).not.toHaveBeenCalled();
      expect(mocks.retrieveSessionResumeData).not.toHaveBeenCalled();
    } finally {
      session.followUps.release(childStreamId);
      session.status.clearStream(childStreamId);
    }
  });
});
