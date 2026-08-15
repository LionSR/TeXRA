// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Node imports
import { setTimeout as sleep } from 'node:timers/promises';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { startChildRunLoop } from '@agent/runtime/childRunLoop';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { defaultSession, SessionHandle } from '@agent/runtime/SessionHandle';
import {
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  deliverChildRunFollowUp: vi.fn(),
  executeAgent: vi.fn(),
  finalizeExecution: vi.fn(),
  persistChildRunReport: vi.fn(),
  persistChildRunResultMeta: vi.fn(),
  readConfig: vi.fn(),
  writeTurnState: vi.fn(),
  resumeToolUseFromResumeData: vi.fn(),
  retrieveSessionResumeData: vi.fn(),
  throwDeliveryFormatting: false,
  throwErrorFormatting: false,
}));

vi.mock('@tools/delegation/subagentResults', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@tools/delegation/subagentResults')>();
  return {
    ...original,
    formatSubagentDelivery: (
      ...args: Parameters<typeof original.formatSubagentDelivery>
    ) => {
      if (mocks.throwDeliveryFormatting) {
        throw new Error('delivery formatting failed');
      }
      return original.formatSubagentDelivery(...args);
    },
    formatSubagentError: (
      ...args: Parameters<typeof original.formatSubagentError>
    ) => {
      if (mocks.throwErrorFormatting) {
        throw new Error('error formatting failed');
      }
      return original.formatSubagentError(...args);
    },
  };
});

vi.mock('@agent/storage', () => ({
  finalizeExecution: mocks.finalizeExecution,
  getExecutionStore: vi.fn(() => ({
    readConfig: mocks.readConfig,
    writeTurnState: mocks.writeTurnState,
  })),
}));

vi.mock('@agent/storage/executionLease', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/storage/executionLease')>()),
  captureOwnedExecutionLease:
    (_executionId: ExecutionId) => (operation: () => unknown) =>
      operation(),
  renewOwnedExecutionLease: vi.fn(async () => {}),
  abandonOwnedExecutionLease: vi.fn(),
  completeOwnedExecutionLease: vi.fn(async () => ({
    status: 'released' as const,
  })),
}));

vi.mock('@agent/runtime/SessionResumeRetrieval', () => ({
  retrieveSessionResumeData: mocks.retrieveSessionResumeData,
}));

vi.mock('@agent/followUp/childRunDelivery', () => ({
  deliverChildRunFollowUp: mocks.deliverChildRunFollowUp,
}));

vi.mock('@agent/storage/childRunPersistence', () => ({
  persistChildRunReport: mocks.persistChildRunReport,
  persistChildRunResultMeta: mocks.persistChildRunResultMeta,
}));
import { testExecutionHandle } from '@test/support/executionHandleFixtures';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';
import { createTestSession } from '@test/support/sessionTestUtils';
import {
  createNativeSubagentStrategy,
  provideAgentEngine,
  type AgentEngine,
} from '@tools/delegation/nativeSubagentStrategy';

const ownedSessions = new Set<SessionHandle>();

const CHILD_STREAM_ID = 'child-stream#exec-1' as StreamTabId;

function fakePorts() {
  return { notify: vi.fn(), recordCost: vi.fn() };
}

/** A tool-use turn result on the shared child stream, for launch/resume mocks. */
function toolUseTurnResult(
  outcome: string,
  executionId: ExecutionId,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    category: 'toolUse',
    outcome,
    executionId,
    streamId: CHILD_STREAM_ID,
    ...extras,
  };
}

/**
 * Stubs the next `executeAgent` so it publishes `handle` through `onRun` and
 * settles with a terminal tool-use turn. `afterRun` runs while the launch is
 * still in flight.
 */
function mockLaunchPublishing(
  handle: unknown,
  outcome: 'cancelled' | 'completed',
  afterRun?: () => void,
): void {
  mocks.executeAgent.mockImplementationOnce(async (_config, _id, options) => {
    options.onRun?.(handle);
    afterRun?.();
    return toolUseTurnResult(outcome, 'exec-1' as ExecutionId);
  });
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
    parentStreamId: 'orchestrator-stream' as StreamTabId,
    session: parentSession,
    startedAt: Date.now(),
    onStreamResolved: vi.fn(),
  };
}

type BaseParams = ReturnType<typeof baseParams>;
type Strategy = ReturnType<typeof createNativeSubagentStrategy>;

/**
 * Launch a WAITING turn, then publish the live handle by hand: `launch()` only
 * resolves the turn — the `deliveryTargetStreamId`/`childStreamId` handle shape
 * the strategy reads arrives through the `onRun` callback.
 */
async function launchWaitingTurn(
  params: BaseParams,
  strategy: Strategy,
): Promise<void> {
  mocks.executeAgent.mockResolvedValueOnce(
    toolUseTurnResult(STREAM_PHASE.WAITING, params.executionId),
  );
  await strategy.launch(fakePorts(), new AbortController());
  mocks.executeAgent.mock.calls.at(-1)?.[2].onRun?.({
    childStreamId: CHILD_STREAM_ID,
    deliveryTargetStreamId: params.parentStreamId,
  });
}

describe('NativeSubagentStrategy', () => {
  let restoreAgentEngine = (): void => {};

  beforeEach(() => {
    vi.resetAllMocks();
    restoreAgentEngine = provideAgentEngine({
      executeAgent: mocks.executeAgent,
      resumeToolUseFromResumeData: mocks.resumeToolUseFromResumeData,
    } as unknown as AgentEngine);
    mocks.throwDeliveryFormatting = false;
    mocks.throwErrorFormatting = false;
    mocks.deliverChildRunFollowUp.mockResolvedValue({ kind: 'delivered' });
    mocks.persistChildRunReport.mockResolvedValue({ kind: 'persisted' });
    mocks.persistChildRunResultMeta.mockResolvedValue({ kind: 'skipped' });
    mocks.writeTurnState.mockResolvedValue(undefined);
    mocks.finalizeExecution.mockResolvedValue({
      status: 'durable',
      terminalStatusPersisted: true,
      flowRecord: 'deleted',
    });
  });

  afterEach(() => {
    restoreAgentEngine();
    for (const session of ownedSessions) session.dispose();
    ownedSessions.clear();
  });

  it('resolveDeliveryTarget follows the live run handle, including after detach', async () => {
    const params = baseParams();
    const strategy = createNativeSubagentStrategy(params);

    // Before any turn ran, falls back to the static orchestrator stream.
    expect(strategy.resolveDeliveryTarget?.()).toBe(params.parentStreamId);

    mocks.executeAgent.mockImplementationOnce(async (_config, _id, options) => {
      options.onRun?.({
        childStreamId: CHILD_STREAM_ID,
        deliveryTargetStreamId: params.parentStreamId,
      });
      return toolUseTurnResult(STREAM_PHASE.WAITING, params.executionId);
    });

    await strategy.launch(fakePorts(), new AbortController());
    expect(mocks.executeAgent).toHaveBeenLastCalledWith(
      params.config,
      params.executionId,
      expect.objectContaining({ enforceCategory: true }),
    );
    expect(strategy.resolveDeliveryTarget?.()).toBe(params.parentStreamId);

    // Detach: the same handle object's deliveryTargetStreamId flips to
    // undefined (AgentExecutionHandle.detach) — the strategy must track the
    // LIVE handle, not a stale copy, so it observes this without a new turn.
    const liveHandle = {
      childStreamId: CHILD_STREAM_ID,
      deliveryTargetStreamId: params.parentStreamId as StreamTabId | undefined,
    };
    mocks.executeAgent.mockImplementationOnce(async (_config, _id, options) => {
      options.onRun?.(liveHandle);
      return toolUseTurnResult(STREAM_PHASE.WAITING, params.executionId);
    });
    await strategy.launch(fakePorts(), new AbortController());
    expect(strategy.resolveDeliveryTarget?.()).toBe(params.parentStreamId);
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
      options.onStreamResolved?.(CHILD_STREAM_ID);
      options.onProgress?.(progress);
      return toolUseTurnResult('completed', params.executionId, {
        totalCostUsd: 0.17,
      });
    });

    await strategy.launch(ports, new AbortController());

    expect(mocks.executeAgent).toHaveBeenCalledWith(
      params.config,
      params.executionId,
      expect.objectContaining({
        allowWaitingResult: true,
        enforceCategory: true,
        parentStreamId: params.parentStreamId,
        stopAfterCycle: true,
        workflowPhase: 'review',
      }),
    );
    expect(params.onStreamResolved).toHaveBeenCalledWith(CHILD_STREAM_ID);
    expect(ports.notify).toHaveBeenCalledWith(progress);
    expect(ports.recordCost).toHaveBeenCalledWith(0.17);
  });

  it('records a failed turn cost once through interactive loop settlement', async () => {
    const params = baseParams();
    const recordCost = vi.fn();
    mocks.executeAgent.mockResolvedValueOnce(
      toolUseTurnResult('failed', params.executionId, {
        totalCostUsd: 0.29,
        error: { message: 'provider failed', userRetryable: false },
      }),
    );

    const { completion } = startChildRunLoop({
      childStreamId: CHILD_STREAM_ID,
      parentStreamId: params.parentStreamId,
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

  it('persists a typed result-only failure without formatting error prose', async () => {
    const params = { ...baseParams(), resultOnly: true };
    const failure = new Error('provider failed');
    mocks.throwErrorFormatting = true;
    mocks.executeAgent.mockImplementationOnce(async (_config, _id, options) => {
      options.onRunError?.(failure);
      return toolUseTurnResult('failed', params.executionId, {
        error: { message: failure.message, userRetryable: false },
      });
    });

    const { completion } = startChildRunLoop({
      childStreamId: CHILD_STREAM_ID,
      parentStreamId: params.parentStreamId,
      executionId: params.executionId,
      agentName: params.agentName,
      strategy: createNativeSubagentStrategy(params),
    });
    await completion;

    expect(mocks.persistChildRunResultMeta).toHaveBeenCalledWith(
      params.executionId,
      expect.objectContaining({
        producer: 'subagent',
        result: expect.objectContaining({
          outcome: 'failed',
          error: expect.objectContaining({ message: 'provider failed' }),
        }),
      }),
    );
  });

  it('interrupts when the turn aborts before launch publishes its handle', async () => {
    const turn = new AbortController();
    turn.abort();
    const interrupt = vi.fn();
    const strategy = createNativeSubagentStrategy(baseParams());
    mockLaunchPublishing({ interrupt }, 'cancelled');

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
    mockLaunchPublishing({ interrupt }, 'cancelled');

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
    mockLaunchPublishing({ interrupt }, 'cancelled', () => controller.abort());

    await strategy.launch(fakePorts(), controller);

    expect(interrupt).toHaveBeenCalledOnce();
  });

  it('detaches from the run signal after launch and ignores later aborts', async () => {
    const controller = new AbortController();
    const interrupt = vi.fn();
    const strategy = createNativeSubagentStrategy(baseParams());
    mockLaunchPublishing({ interrupt }, 'completed');

    await strategy.launch(fakePorts(), controller);
    controller.abort();

    expect(interrupt).not.toHaveBeenCalled();
  });

  it('binds resumed-turn cancellation to the replacement run handle', async () => {
    const params = baseParams();
    const childStreamId = CHILD_STREAM_ID;
    const initialHandle = {
      childStreamId,
      deliveryTargetStreamId: params.parentStreamId,
      interrupt: vi.fn(),
    };
    mocks.executeAgent.mockImplementationOnce(async (_config, _id, options) => {
      options.onRun?.(initialHandle as never);
      return toolUseTurnResult(STREAM_PHASE.WAITING, params.executionId);
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
          deliveryTargetStreamId: params.parentStreamId,
          interrupt: replacementInterrupt,
        } as never);
        replacementReady();
        await new Promise<void>((resolve) =>
          turn.signal.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
        return toolUseTurnResult('cancelled', params.executionId);
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
      response: 'The proof holds.',
      files: ['main.tex'],
      executionId: params.executionId,
      streamId: CHILD_STREAM_ID,
    };

    const msg = await strategy.formatDelivery(waitingTurn, 1000);
    expect(msg).toContain('<response>');
    expect(msg).toContain('The proof holds.');
    expect(msg).toContain('status="completed"');
  });

  it('builds the durable result before fallible delivery formatting', async () => {
    const params = baseParams();
    const strategy = createNativeSubagentStrategy(params);
    const turn = toolUseTurnResult('completed', params.executionId) as never;

    const built = await strategy.buildResult(turn);
    mocks.throwDeliveryFormatting = true;

    await expect(strategy.formatDelivery(turn, 1000)).rejects.toThrow(
      'delivery formatting failed',
    );
    await expect(strategy.buildResult(turn)).resolves.toBe(built);
  });

  it('does not format prose for a typed-result-only child', async () => {
    const params = { ...baseParams(), resultOnly: true };
    const strategy = createNativeSubagentStrategy(params);
    const turn = toolUseTurnResult('completed', params.executionId) as never;
    mocks.throwDeliveryFormatting = true;

    await expect(strategy.formatDelivery(turn, 1000)).resolves.toBe('');
    await expect(strategy.buildResult(turn)).resolves.toBeDefined();
  });

  it('reports a non-throwing subagent failure via isTurnError, captured from onRunError', async () => {
    const params = baseParams();
    const strategy = createNativeSubagentStrategy(params);
    const failure = new Error('model overloaded');

    mocks.executeAgent.mockImplementationOnce(async (_config, _id, options) => {
      options.onRunError?.(failure);
      return toolUseTurnResult('failed', params.executionId);
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

  it('stamps parent lineage onto both success and failure manifests', async () => {
    const params = {
      ...baseParams(),
      parentExecutionId: 'parent-exec' as ExecutionId,
    };
    const strategy = createNativeSubagentStrategy(params);

    await expect(
      strategy.buildResultMeta?.(null, true, 10),
    ).resolves.toMatchObject({ parentExecutionId: 'parent-exec' });

    await expect(
      strategy.buildResultMeta?.(
        {
          category: 'toolUse',
          outcome: 'completed',
          response: 'done',
          executionId: params.executionId,
          streamId: CHILD_STREAM_ID,
        },
        false,
        10,
      ),
    ).resolves.toMatchObject({ parentExecutionId: 'parent-exec' });
  });

  it('runTurn hands its consumed batch directly to the persisted flow cursor', async () => {
    const params = {
      ...baseParams(),
      approvalPromptsUnavailable: true,
      runtimeUnavailableTools: ['ask_user'],
    };
    const strategy = createNativeSubagentStrategy(params);
    const childStreamId = CHILD_STREAM_ID;

    await launchWaitingTurn(params, strategy);

    const config = { agentCategory: 'toolUse' };
    const snapshot = createToolUseResumeData({
      executionId: params.executionId,
      streamId: childStreamId,
    });
    mocks.readConfig.mockResolvedValue(config);
    mocks.retrieveSessionResumeData.mockResolvedValue(snapshot);
    mocks.resumeToolUseFromResumeData.mockResolvedValueOnce(
      toolUseTurnResult('completed', params.executionId, { response: 'done' }),
    );

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
        parentStreamId: params.parentStreamId,
        drainedFollowUps: [
          {
            text: 'keep going',
            displayText: undefined,
            mediaFiles: undefined,
            origin: 'user',
          },
        ],
        runtimeUnavailableTools: ['ask_user'],
        session: params.session,
      }),
    );
    expect(strategy.isTerminal(turn)).toBe(true);
  });

  it('preserves #7491: a failed direct resume throws for child-loop error delivery', async () => {
    const params = baseParams();
    const strategy = createNativeSubagentStrategy(params);

    await launchWaitingTurn(params, strategy);

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

  it('keeps a second child follow-up available after two resumed WAITING turns', async () => {
    const session = defaultSession();
    const childStreamId =
      'native-follow-up-loop-child#native-follow-up-loop-exec' as StreamTabId;
    const parentStreamId = 'native-follow-up-loop-parent' as StreamTabId;
    const executionId = 'native-follow-up-loop-exec' as ExecutionId;
    const interactions = { emit: vi.fn() } as never;
    const handle = testExecutionHandle({
      executionId,
      parentStreamId,
      childStreamId,
      agent: 'review',
    });
    const params = {
      ...baseParams(session),
      executionId,
      parentStreamId,
      interactions,
    };
    const waitingTurn = (response: string) => ({
      category: 'toolUse' as const,
      outcome: STREAM_PHASE.WAITING,
      response,
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
        options.onRun?.(handle);
        session.status.transitionToWaiting(childStreamId, 'wait');
        return waitingTurn(
          `follow-up response ${mocks.resumeToolUseFromResumeData.mock.calls.length}`,
        );
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
        expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledTimes(1),
      );

      expect(
        session.followUps.submit(
          childStreamId,
          {
            text: 'Also state exactly where finiteness is used.',
            origin: 'user',
          },
          'live_owner',
        ),
      ).toEqual({ kind: 'live' });

      await vi.waitFor(() =>
        expect(mocks.resumeToolUseFromResumeData).toHaveBeenCalledTimes(1),
      );
      await vi.waitFor(() =>
        expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledTimes(2),
      );

      expect(
        session.followUps.submit(
          childStreamId,
          {
            text: 'Now give the shortest equivalent statement.',
            origin: 'user',
          },
          'live_owner',
        ),
      ).toEqual({ kind: 'live' });

      await vi.waitFor(() =>
        expect(mocks.resumeToolUseFromResumeData).toHaveBeenCalledTimes(2),
      );
      await vi.waitFor(() =>
        expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledTimes(3),
      );
      await sleep(50);

      expect(mocks.resumeToolUseFromResumeData).toHaveBeenCalledTimes(2);
      expect(
        mocks.resumeToolUseFromResumeData.mock.calls.map((call) => call[0]),
      ).toEqual([resume, resume]);
      expect(
        mocks.resumeToolUseFromResumeData.mock.calls.map(
          (call) => call[1].drainedFollowUps,
        ),
      ).toEqual([
        [
          {
            text: 'Also state exactly where finiteness is used.',
            displayText: undefined,
            mediaFiles: undefined,
            origin: 'user',
          },
        ],
        [
          {
            text: 'Now give the shortest equivalent statement.',
            displayText: undefined,
            mediaFiles: undefined,
            origin: 'user',
          },
        ],
      ]);
      expect(session.followUps.getAll(childStreamId)).toEqual([]);
      expect(session.status.get(childStreamId)).toBe(STREAM_PHASE.WAITING);
      const resumedDeliveries = mocks.deliverChildRunFollowUp.mock.calls.filter(
        ([delivery]) => delivery.followUp.text.includes('follow-up response'),
      );
      expect(resumedDeliveries).toHaveLength(2);
    } finally {
      const handleWasTracked =
        session.executions.getHandle(executionId) !== undefined;
      if (session.followUps.hasLiveOwner(childStreamId)) handle.interrupt();
      await vi.waitFor(() =>
        expect(session.followUps.hasLiveOwner(childStreamId)).toBe(false),
      );
      if (handleWasTracked) await handle.result;
      if (session.executions.getHandle(executionId)) {
        session.executions.untrack(executionId);
      }
      session.followUps.terminalize(childStreamId);
      session.status.clearStream(childStreamId);
    }
  });

  it('records the run cumulative cost via ports.recordCost on every turn', async () => {
    const params = baseParams();
    const strategy = createNativeSubagentStrategy(params);
    const ports = fakePorts();

    mocks.executeAgent.mockResolvedValueOnce(
      toolUseTurnResult(STREAM_PHASE.WAITING, params.executionId, {
        totalCostUsd: 0.42,
      }),
    );

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
      streamId: CHILD_STREAM_ID,
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
    const childStreamId =
      'native-workflow-loop-child#native-workflow-loop-exec' as StreamTabId;
    const parentStreamId = 'native-workflow-loop-parent' as StreamTabId;
    const executionId = 'native-workflow-loop-exec' as ExecutionId;
    const interactions = { emit: vi.fn() } as never;
    const params = {
      ...baseParams(session, 'workflow'),
      executionId,
      parentStreamId,
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
        expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledTimes(1),
      );
      await vi.waitFor(() =>
        expect(session.followUps.hasLiveOwner(childStreamId)).toBe(false),
      );

      expect(mocks.resumeToolUseFromResumeData).not.toHaveBeenCalled();
      expect(mocks.retrieveSessionResumeData).not.toHaveBeenCalled();
    } finally {
      session.followUps.terminalize(childStreamId);
      session.status.clearStream(childStreamId);
    }
  });
});
