// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - agent
import {
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  executeAgent: vi.fn(),
  readConfig: vi.fn(),
  resumeQueuedToolUseSnapshot: vi.fn(),
  retrieveSessionResumeData: vi.fn(),
}));

vi.mock('@agent/runtime/executeAgent', () => ({
  executeAgent: mocks.executeAgent,
}));

vi.mock('@agent/storage', () => ({
  getExecutionStore: vi.fn(() => ({ readConfig: mocks.readConfig })),
}));

vi.mock('@agent/runtime/SessionResumeRetrieval', () => ({
  retrieveSessionResumeData: mocks.retrieveSessionResumeData,
}));

vi.mock('@agent/runtime/resumeQueuedToolUse', () => ({
  resumeQueuedToolUseSnapshot: mocks.resumeQueuedToolUseSnapshot,
}));

import { createNativeToolUseStrategy } from '@tools/delegation/nativeToolUseStrategy';

function fakePorts() {
  return { notify: vi.fn(), recordCost: vi.fn() };
}

function baseParams() {
  return {
    configPayload: {
      agent: 'review',
      model: 'gpt5',
      agentCategory: 'toolUse',
    } as never,
    executionId: 'exec-1' as ExecutionId,
    agentName: 'review',
    orchestratorStreamId: 'orchestrator-stream' as StreamTabId,
    parentSession: { tag: 'parent-session' } as never,
    runtimeHost: { emit: vi.fn() } as never,
    startedAt: Date.now(),
    delegationDepth: 1,
    onStreamResolved: vi.fn(),
  };
}

describe('NativeToolUseStrategy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolveDeliveryTarget follows the live run handle, including after detach', async () => {
    const params = baseParams();
    const strategy = createNativeToolUseStrategy(params);

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

  it('formatDelivery folds a WAITING turn into a completed-shaped delivery', async () => {
    const params = baseParams();
    const strategy = createNativeToolUseStrategy(params);

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
    const strategy = createNativeToolUseStrategy(params);
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

  it('runTurn drives the persisted flow-record cursor via retrieveSessionResumeData + resumeQueuedToolUseSnapshot', async () => {
    const params = baseParams();
    const strategy = createNativeToolUseStrategy(params);
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
    const snapshot = {
      agentConfig: config,
      executionId: params.executionId,
      messages: [],
    };
    mocks.readConfig.mockResolvedValue(config);
    mocks.retrieveSessionResumeData.mockResolvedValue({
      type: 'toolUse',
      snapshot,
    });
    mocks.resumeQueuedToolUseSnapshot.mockImplementationOnce(
      async (_streamId, _snapshot, _host, options) => {
        options.onResult({
          category: 'toolUse',
          outcome: 'completed',
          lastResponse: 'done',
          executionId: params.executionId,
          streamId: childStreamId,
        });
        return true;
      },
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
    expect(mocks.resumeQueuedToolUseSnapshot).toHaveBeenCalledWith(
      childStreamId,
      snapshot,
      params.runtimeHost,
      expect.objectContaining({
        allowWaitingResult: true,
        extraFollowUps: [
          {
            text: 'keep going',
            displayText: undefined,
            mediaFiles: undefined,
            origin: 'user',
          },
        ],
      }),
    );
    expect(strategy.isTerminal(turn)).toBe(true);
  });

  it('preserves #7491: a failed resume (resumeQueuedToolUseSnapshot returns false) throws, delivering formatError to the parent', async () => {
    const params = baseParams();
    const strategy = createNativeToolUseStrategy(params);
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
    mocks.retrieveSessionResumeData.mockResolvedValue({
      type: 'toolUse',
      snapshot: {
        agentConfig: {},
        executionId: params.executionId,
        messages: [],
      },
    });
    const resumeError = new Error('resume storage unreadable');
    mocks.resumeQueuedToolUseSnapshot.mockImplementationOnce(
      async (_streamId, _snapshot, _host, options) => {
        await options.onError(resumeError);
        return false;
      },
    );

    await expect(
      strategy.runTurn!([], fakePorts(), new AbortController()),
    ).rejects.toBe(resumeError);
  });

  it('records the run cumulative cost via ports.recordCost on every turn', async () => {
    const params = baseParams();
    const strategy = createNativeToolUseStrategy(params);
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
});
