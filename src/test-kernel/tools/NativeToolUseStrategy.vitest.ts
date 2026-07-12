// Third-party imports
import { setTimeout as sleep } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - agent
import { ToolUseSessionLifecycle } from '@agent/implementations/flows/tooluse/ToolUseSessionLifecycle';
import {
  isChildRunLoopActive,
  startChildRunLoop,
} from '@agent/runtime/childRunLoop';
import { AgentExecutionHandle } from '@agent/runtime/executionRegistry';
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
  persistChildRunReport: vi.fn(),
  persistChildRunResultMeta: vi.fn(),
  readConfig: vi.fn(),
  resumeToolUseFromSnapshot: vi.fn(),
  retrieveSessionResumeData: vi.fn(),
  synchronizeAgentResultOutcome: vi.fn(),
  writeTerminalStatus: vi.fn(),
}));

vi.mock('@agent/runtime/executeAgent', () => ({
  executeAgent: mocks.executeAgent,
  resumeToolUseFromSnapshot: mocks.resumeToolUseFromSnapshot,
}));

vi.mock('@agent/storage', () => ({
  getExecutionStore: vi.fn(() => ({ readConfig: mocks.readConfig })),
  synchronizeAgentResultOutcome: mocks.synchronizeAgentResultOutcome,
  writeTerminalStatus: mocks.writeTerminalStatus,
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

import { createNativeToolUseStrategy } from '@tools/delegation/nativeToolUseStrategy';

const ownedSessions = new Set<SessionHandle>();

function fakePorts() {
  return { notify: vi.fn(), recordCost: vi.fn() };
}

function baseParams(parentSession = new SessionHandle()) {
  if (parentSession !== defaultSession()) ownedSessions.add(parentSession);
  return {
    configPayload: {
      agent: 'review',
      model: 'gpt5',
      agentCategory: 'toolUse',
    } as never,
    executionId: 'exec-1' as ExecutionId,
    agentName: 'review',
    orchestratorStreamId: 'orchestrator-stream' as StreamTabId,
    parentSession,
    runtimeHost: { emit: vi.fn() } as never,
    startedAt: Date.now(),
    delegationDepth: 1,
    onStreamResolved: vi.fn(),
  };
}

describe('NativeToolUseStrategy', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.enqueueChildRunFollowUp.mockResolvedValue({
      kind: 'enqueued',
      sendResult: { status: 'sent' },
    });
    mocks.wakeChildRunFollowUp.mockResolvedValue({ kind: 'delivered' });
    mocks.persistChildRunReport.mockResolvedValue({ kind: 'persisted' });
    mocks.persistChildRunResultMeta.mockResolvedValue({ kind: 'skipped' });
    mocks.synchronizeAgentResultOutcome.mockResolvedValue(undefined);
    mocks.writeTerminalStatus.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const session of ownedSessions) session.dispose();
    ownedSessions.clear();
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

  it('persists a typed tool-use failure when no flow result exists', async () => {
    const strategy = createNativeToolUseStrategy(baseParams());

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
    mocks.resumeToolUseFromSnapshot.mockResolvedValueOnce({
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
    expect(mocks.resumeToolUseFromSnapshot).toHaveBeenCalledWith(
      snapshot,
      params.runtimeHost,
      expect.objectContaining({
        allowWaitingResult: true,
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
    mocks.resumeToolUseFromSnapshot.mockRejectedValueOnce(resumeError);

    await expect(
      strategy.runTurn!([], fakePorts(), new AbortController()),
    ).rejects.toBe(resumeError);
  });

  it('consumes one child-loop follow-up in one resumed WAITING turn without requeueing it', async () => {
    const session = defaultSession();
    const childStreamId = 'native-follow-up-loop-child' as StreamTabId;
    const parentStreamId = 'native-follow-up-loop-parent' as StreamTabId;
    const executionId = 'native-follow-up-loop-exec' as ExecutionId;
    const runtimeHost = { emit: vi.fn() } as never;
    const handle = new AgentExecutionHandle(
      executionId,
      parentStreamId,
      childStreamId,
      'review',
      'toolUse',
      runtimeHost,
    );
    const params = {
      ...baseParams(session),
      executionId,
      orchestratorStreamId: parentStreamId,
      runtimeHost,
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
    const config = { agentCategory: 'toolUse' };
    const snapshot = {
      agentConfig: config,
      executionId,
      messages: [],
    };
    mocks.readConfig.mockResolvedValue(config);
    mocks.retrieveSessionResumeData.mockResolvedValue({
      type: 'toolUse',
      snapshot,
    });
    mocks.resumeToolUseFromSnapshot.mockImplementation(
      async (_snapshot, _host, options) => {
        if (mocks.resumeToolUseFromSnapshot.mock.calls.length > 1) {
          throw new Error('the same follow-up batch resumed more than once');
        }
        // This branch models the former queue-owning wrapper. Before the fix,
        // NativeToolUseStrategy called that wrapper, which supplied
        // setupSession and thereby put the child-loop batch back into this
        // exact queue. Keeping the branch in the integration fixture makes a
        // regression fail after two turns instead of spinning indefinitely.
        if (options.setupSession) {
          options.setupSession(
            new ToolUseSessionLifecycle(childStreamId, session.followUps),
          );
        }
        options.onRun?.(handle);
        session.status.transitionToWaiting(childStreamId, 'wait');
        return waitingTurn('follow-up response');
      },
    );

    const strategy = createNativeToolUseStrategy(params);
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
        expect(mocks.resumeToolUseFromSnapshot).toHaveBeenCalledTimes(1),
      );
      await vi.waitFor(() =>
        expect(mocks.enqueueChildRunFollowUp).toHaveBeenCalledTimes(2),
      );
      // Give an accidentally re-enqueued batch enough time to start a second
      // immediate resume. The guarded mock above prevents an actual busy loop.
      await sleep(50);

      expect(mocks.resumeToolUseFromSnapshot).toHaveBeenCalledTimes(1);
      expect(
        mocks.resumeToolUseFromSnapshot.mock.calls[0]?.[2].drainedFollowUps,
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
