// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildAgentLaunchContext: vi.fn(),
  hasPersistedParent: vi.fn(),
  invokeModelOrTool: vi.fn(),
  runFlowWithLifecycle: vi.fn(),
  runToolUseFlow: vi.fn(),
  acquireResumedExecutionLease: vi.fn(),
  releaseOwnedExecutionLeaseAfterFailure: vi.fn(),
  releaseOwnedExecutionLeaseBestEffort: vi.fn(),
}));

vi.mock('@agent/storage/executionLease', () => ({
  acquireResumedExecutionLease: mocks.acquireResumedExecutionLease,
  releaseOwnedExecutionLeaseAfterFailure:
    mocks.releaseOwnedExecutionLeaseAfterFailure,
  releaseOwnedExecutionLeaseBestEffort:
    mocks.releaseOwnedExecutionLeaseBestEffort,
}));

vi.mock('@agent/runtime/AgentLaunchContext', () => ({
  buildAgentLaunchContext: mocks.buildAgentLaunchContext,
  withExecutionRunContext: async (
    _context: unknown,
    _options: unknown,
    run: () => Promise<unknown>,
  ) => run(),
}));

vi.mock('@agent/runtime/AgentRunLifecycle', () => ({
  runFlowWithLifecycle: mocks.runFlowWithLifecycle,
}));

vi.mock('@agent/storage/executionLifecycle', () => ({
  hasPersistedParent: mocks.hasPersistedParent,
}));

vi.mock('@agent/implementations/flows/reflection/runReflectionFlow', () => ({
  runReflectionFlow: vi.fn(),
}));

vi.mock('@agent/implementations/flows/tooluse/runToolUseFlow', () => ({
  getToolUseFlowErrorResult: () => undefined,
  runToolUseFlow: mocks.runToolUseFlow,
}));

// Local imports - agent runtime
import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { AgentLaunchContext } from '@agent/runtime/AgentLaunchContext';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { resumeToolUseFromSnapshot } from '@agent/runtime/executeAgent';
import {
  RUN_OUTCOME,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';

interface InterruptibleFlowInput {
  checkInterruption(): boolean;
  onInterrupt?: () => void;
  takePendingFollowUps?: () => readonly unknown[];
}

interface TestFlowContext {
  readonly session: { appendFollowUp(item: unknown): void };
  interrupt(): void;
}

describe('resumeToolUseFromSnapshot cancellation handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acquireResumedExecutionLease.mockResolvedValue('existing');
    mocks.releaseOwnedExecutionLeaseAfterFailure.mockImplementation(
      async (_executionId: ExecutionId, error: unknown) => error,
    );
    mocks.releaseOwnedExecutionLeaseBestEffort.mockResolvedValue(undefined);
  });

  it('resolves execution lineage before activating the resume stream', async () => {
    const storageError = new Error('execution metadata unavailable');
    const runtimeHost = { emit: vi.fn() } as unknown as AgentRuntimeHost;
    const snapshot = {
      executionId: 'e8048' as ExecutionId,
      streamId: 'stream-8048' as StreamTabId,
      agentConfig: { agent: 'test-agent', model: 'test-model' },
      messages: [],
    } as unknown as ToolUseSessionSnapshot;
    mocks.hasPersistedParent.mockRejectedValueOnce(storageError);

    await expect(resumeToolUseFromSnapshot(snapshot, runtimeHost)).rejects.toBe(
      storageError,
    );

    expect(mocks.buildAgentLaunchContext).not.toHaveBeenCalled();
    expect(mocks.releaseOwnedExecutionLeaseAfterFailure).toHaveBeenCalledWith(
      snapshot.executionId,
      storageError,
    );
  });

  it('interrupts at flow attachment before substantive work starts', async () => {
    const executionId = 'e8049' as ExecutionId;
    const streamId = 'stream-8049' as StreamTabId;
    const runtimeHost = { emit: vi.fn() } as unknown as AgentRuntimeHost;
    const context = {
      setting: { agentCategory: AgentCategory.ToolUse },
      runScope: {
        executionId,
        streamId,
        session: { status: {} },
      },
      config: { agent: 'test-agent', model: 'test-model' },
      attachedMemoryMisses: [],
      usageMonitor: { recordUsage: vi.fn() },
    } as unknown as AgentLaunchContext;
    const order: string[] = [];
    let attachedContext: TestFlowContext | undefined;
    const handle = {
      attachToolUseFlow: vi.fn((flowContext: TestFlowContext) => {
        order.push('attach');
        attachedContext = flowContext;
      }),
      detachToolUseFlow: vi.fn((flowContext: TestFlowContext) => {
        order.push('detach');
        if (attachedContext === flowContext) attachedContext = undefined;
      }),
    };

    mocks.buildAgentLaunchContext.mockResolvedValueOnce(context);
    mocks.hasPersistedParent.mockResolvedValueOnce(false);
    mocks.runFlowWithLifecycle.mockImplementationOnce(
      async (
        _context: unknown,
        run: (liveHandle: typeof handle) => Promise<unknown>,
      ) => run(handle),
    );
    mocks.runToolUseFlow.mockImplementationOnce(
      async (
        input: InterruptibleFlowInput,
        _registry: unknown,
        onSetup: (flowContext: TestFlowContext) => void | (() => void),
      ) => {
        const flowContext: TestFlowContext = {
          session: { appendFollowUp: vi.fn() },
          interrupt: () => {
            order.push('interrupt');
            input.onInterrupt?.();
          },
        };
        const teardown = onSetup(flowContext);
        input.takePendingFollowUps?.();
        if (!input.checkInterruption()) mocks.invokeModelOrTool();
        teardown?.();
        return {
          outcome: input.checkInterruption()
            ? RUN_OUTCOME.CANCELLED
            : RUN_OUTCOME.COMPLETED,
        };
      },
    );

    const snapshot = {
      executionId,
      streamId,
      agentConfig: { agent: 'test-agent', model: 'test-model' },
      messages: [],
    } as unknown as ToolUseSessionSnapshot;

    const result = await resumeToolUseFromSnapshot(snapshot, runtimeHost, {
      takePendingFollowUps: () => {
        order.push('take');
        return [];
      },
      isCancellationRequested: () => {
        order.push('query');
        expect(attachedContext).toBeDefined();
        return true;
      },
      onCancellationAtFlowAttachment: () => order.push('cancel'),
    });

    expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
    expect(mocks.releaseOwnedExecutionLeaseBestEffort).toHaveBeenCalledWith(
      executionId,
    );
    expect(mocks.invokeModelOrTool).not.toHaveBeenCalled();
    expect(order).toEqual([
      'attach',
      'query',
      'cancel',
      'interrupt',
      'take',
      'detach',
    ]);
  });
});
