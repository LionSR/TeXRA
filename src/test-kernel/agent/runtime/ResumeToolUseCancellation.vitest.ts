// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  abandonOwnedExecutionLease: vi.fn(),
  buildAgentLaunchContext: vi.fn(),
  clearTerminalExecutionState: vi.fn(),
  hasPersistedParent: vi.fn(),
  invokeModelOrTool: vi.fn(),
  runFlowWithLifecycle: vi.fn(),
  runToolUseFlow: vi.fn(),
  acquireResumedExecutionLease: vi.fn(),
  renewOwnedExecutionLease: vi.fn(),
  runWithExecutionLeaseWriteFence: vi.fn(
    async (_executionId: ExecutionId, operation: () => Promise<unknown>) =>
      operation(),
  ),
  releaseOwnedExecutionLeaseAfterFailure: vi.fn(),
  completeOwnedExecutionLease: vi.fn(),
}));

vi.mock('@agent/storage/executionLease', () => ({
  abandonOwnedExecutionLease: mocks.abandonOwnedExecutionLease,
  acquireResumedExecutionLease: mocks.acquireResumedExecutionLease,
  captureOwnedExecutionLease:
    (_executionId: ExecutionId) => (operation: () => unknown) =>
      operation(),
  completeOwnedExecutionLease: mocks.completeOwnedExecutionLease,
  renewOwnedExecutionLease: mocks.renewOwnedExecutionLease,
  runWithExecutionLeaseWriteFence: mocks.runWithExecutionLeaseWriteFence,
  releaseOwnedExecutionLeaseAfterFailure:
    mocks.releaseOwnedExecutionLeaseAfterFailure,
  runWithOwnedExecutionLease: (
    _executionId: ExecutionId,
    operation: () => unknown,
  ) => operation(),
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
  clearTerminalExecutionState: mocks.clearTerminalExecutionState,
  hasPersistedParent: mocks.hasPersistedParent,
}));

vi.mock('@agent/implementations/flows/reflection/runReflectionFlow', () => ({
  runReflectionFlow: vi.fn(),
}));

vi.mock('@agent/implementations/flows/tooluse/runToolUseFlow', () => ({
  runToolUseFlow: mocks.runToolUseFlow,
}));

// Local imports
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { ITool } from '@agent/core/tools/ToolTypes';
import type { AgentLaunchContext } from '@agent/runtime/AgentLaunchContext';
import type { SessionHostInteractions } from '@agent/runtime/HostInteractions';
import { resumeToolUseFromResumeData } from '@agent/runtime/executeAgent';
import { ResumeAdmissionCancelledError } from '@agent/runtime/resumeAdmission';
import {
  RUN_OUTCOME,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';

interface InterruptibleFlowInput {
  checkInterruption(): boolean;
  onInterrupt?: () => void;
  takePendingFollowUps?: () => readonly unknown[];
  tools?: readonly ITool[];
}

interface TestFlowContext {
  readonly session: { appendFollowUp(item: unknown): void };
  interrupt(): void;
}

interface ModelSwitchingFlowInput {
  onModelChanged: (
    modelHandler: {
      capabilities: Record<string, unknown>;
      config: Record<string, unknown>;
    },
    model: string,
  ) => void;
}

/** Minimal launch context for a resumed tool-use run that reaches the flow. */
function buildResumeContext(
  executionId: ExecutionId,
  streamId: StreamTabId,
  usageMonitor: { setModelInfo: ReturnType<typeof vi.fn> },
): AgentLaunchContext {
  return {
    setting: { agentCategory: AgentCategory.ToolUse },
    runScope: {
      executionId,
      streamId,
      session: {
        status: {},
        transcripts: { ensureLoaded: vi.fn(async () => {}) },
        flushArtifacts: vi.fn(async () => {}),
      },
    },
    config: { agent: 'test-agent', model: 'test-model' },
    userVarChannels: {
      input: Object.freeze({ MODEL: 'test-model' }),
      transient: { MODEL: 'test-model' },
    },
    attachedMemoryMisses: [],
    usageMonitor: { recordUsage: vi.fn(), ...usageMonitor },
  } as unknown as AgentLaunchContext;
}

/** Handle stub for tests that only need the flow to run to completion. */
function noopFlowHandle(): unknown {
  return {
    attachToolUseFlow: vi.fn(),
    detachToolUseFlow: vi.fn(),
  };
}

describe('resumeToolUseFromResumeData cancellation handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acquireResumedExecutionLease.mockResolvedValue('existing');
    mocks.clearTerminalExecutionState.mockResolvedValue(undefined);
    mocks.releaseOwnedExecutionLeaseAfterFailure.mockImplementation(
      async (_executionId: ExecutionId, error: unknown) => error,
    );
    mocks.completeOwnedExecutionLease.mockResolvedValue(undefined);
  });

  // The predecessor run's terminal outcome is projected onto every result
  // envelope read back (`applyExecutionOutcome`), so it has to be gone before
  // the resumed run can write a turn of its own.
  it('clears the previous run terminal facts before the resumed run starts', async () => {
    const executionId = 'e9503-boundary' as ExecutionId;
    const streamId = 'stream-9503-boundary' as StreamTabId;
    const order: string[] = [];
    mocks.clearTerminalExecutionState.mockImplementationOnce(async () => {
      order.push('clear');
    });
    mocks.buildAgentLaunchContext.mockImplementationOnce(async () => {
      order.push('launch');
      return buildResumeContext(executionId, streamId, {
        setModelInfo: vi.fn(),
      });
    });
    mocks.hasPersistedParent.mockResolvedValueOnce(true);
    mocks.runFlowWithLifecycle.mockImplementationOnce(
      async (
        _context: unknown,
        run: (liveHandle: unknown) => Promise<unknown>,
      ) => run(noopFlowHandle()),
    );
    mocks.runToolUseFlow.mockImplementationOnce(async () => {
      order.push('flow');
      return { outcome: RUN_OUTCOME.COMPLETED };
    });

    await resumeToolUseFromResumeData(
      createToolUseResumeData({ executionId, streamId }),
    );

    expect(mocks.clearTerminalExecutionState).toHaveBeenCalledWith(executionId);
    expect(order).toEqual(['clear', 'launch', 'flow']);
  });

  it('releases the resumed lease when the terminal-fact clear fails', async () => {
    const storageError = new Error('meta write failed');
    const snapshot = createToolUseResumeData({
      executionId: 'e9503-boundary-failure' as ExecutionId,
      streamId: 'stream-9503-boundary-failure' as StreamTabId,
    });
    mocks.clearTerminalExecutionState.mockRejectedValueOnce(storageError);

    await expect(resumeToolUseFromResumeData(snapshot)).rejects.toBe(
      storageError,
    );

    expect(mocks.hasPersistedParent).not.toHaveBeenCalled();
    expect(mocks.buildAgentLaunchContext).not.toHaveBeenCalled();
    expect(mocks.releaseOwnedExecutionLeaseAfterFailure).toHaveBeenCalledWith(
      snapshot.executionId,
      storageError,
    );
  });

  it('resolves execution lineage before activating the resume stream', async () => {
    const storageError = new Error('execution metadata unavailable');
    const interactions = {
      emit: vi.fn(),
    } as unknown as SessionHostInteractions;
    const snapshot = createToolUseResumeData({
      executionId: 'e8048' as ExecutionId,
      streamId: 'stream-8048' as StreamTabId,
    });
    mocks.hasPersistedParent.mockRejectedValueOnce(storageError);

    await expect(resumeToolUseFromResumeData(snapshot)).rejects.toBe(
      storageError,
    );

    expect(mocks.buildAgentLaunchContext).not.toHaveBeenCalled();
    expect(mocks.releaseOwnedExecutionLeaseAfterFailure).toHaveBeenCalledWith(
      snapshot.executionId,
      storageError,
    );
  });

  it('does not build a launch context when canonical admission is withdrawn under the lease lock', async () => {
    const snapshot = createToolUseResumeData();
    let canonical = true;
    mocks.acquireResumedExecutionLease.mockImplementationOnce(
      async (_executionId: ExecutionId, canAcquire: () => boolean) => {
        canonical = false;
        return canAcquire() ? 'acquired' : 'cancelled';
      },
    );

    await expect(
      resumeToolUseFromResumeData(snapshot, {
        canAcquireResumeLease: () => canonical,
      }),
    ).rejects.toBeInstanceOf(ResumeAdmissionCancelledError);

    expect(mocks.buildAgentLaunchContext).not.toHaveBeenCalled();
  });

  it('preserves the historical diagnostic for a non-tool-use launch', async () => {
    const resume = createToolUseResumeData();
    mocks.hasPersistedParent.mockResolvedValueOnce(false);
    mocks.buildAgentLaunchContext.mockResolvedValueOnce({
      setting: { agentCategory: AgentCategory.Workflow },
      runScope: {
        executionId: resume.executionId,
        streamId: resume.streamId,
        session: { flushArtifacts: vi.fn() },
      },
    } as unknown as AgentLaunchContext);

    await expect(resumeToolUseFromResumeData(resume)).rejects.toThrow(
      'Attempted to resume a non tool-use agent with resumeToolUseFromSnapshot.',
    );
  });

  it('interrupts at flow attachment before substantive work starts', async () => {
    const executionId = 'e8049' as ExecutionId;
    const streamId = 'stream-8049' as StreamTabId;
    const interactions = {
      emit: vi.fn(),
    } as unknown as SessionHostInteractions;
    const context = {
      setting: { agentCategory: AgentCategory.ToolUse },
      runScope: {
        executionId,
        streamId,
        session: {
          status: {},
          transcripts: { ensureLoaded: vi.fn(async () => {}) },
          flushArtifacts: vi.fn(async () => {}),
        },
      },
      config: { agent: 'test-agent', model: 'test-model' },
      attachedMemoryMisses: [],
      usageMonitor: { recordUsage: vi.fn() },
    } as unknown as AgentLaunchContext;
    const order: string[] = [];
    const tools = [
      {
        definition: { name: 'run_scoped' },
        call: vi.fn(),
      },
    ] as unknown as readonly ITool[];
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
        attachment: {
          attach: (flowContext: TestFlowContext) => void;
          detach: (flowContext: TestFlowContext) => void;
        },
      ) => {
        expect(input.tools).toBe(tools);
        const flowContext: TestFlowContext = {
          session: { appendFollowUp: vi.fn() },
          interrupt: () => {
            order.push('interrupt');
            input.onInterrupt?.();
          },
        };
        attachment.attach(flowContext);
        input.takePendingFollowUps?.();
        if (!input.checkInterruption()) mocks.invokeModelOrTool();
        attachment.detach(flowContext);
        return {
          outcome: input.checkInterruption()
            ? RUN_OUTCOME.CANCELLED
            : RUN_OUTCOME.COMPLETED,
        };
      },
    );

    const snapshot = createToolUseResumeData({
      executionId,
      streamId,
    });

    const result = await resumeToolUseFromResumeData(snapshot, {
      tools,
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
    expect(mocks.completeOwnedExecutionLease).toHaveBeenCalledWith(executionId);
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

  it('mirrors a mid-run model switch onto every launch-context view', async () => {
    const executionId = 'e9421-model' as ExecutionId;
    const streamId = 'stream-9421-model' as StreamTabId;
    const setModelInfo = vi.fn();
    const ctx = buildResumeContext(executionId, streamId, { setModelInfo });
    mocks.buildAgentLaunchContext.mockResolvedValueOnce(ctx);
    mocks.hasPersistedParent.mockResolvedValueOnce(false);
    mocks.runFlowWithLifecycle.mockImplementationOnce(
      async (
        _context: unknown,
        run: (liveHandle: unknown) => Promise<unknown>,
      ) => run(noopFlowHandle()),
    );
    mocks.runToolUseFlow.mockImplementationOnce(
      async (input: ModelSwitchingFlowInput) => {
        input.onModelChanged(
          {
            capabilities: { supportsVision: true },
            config: { provider: 'anthropic' },
          },
          'next-model',
        );
        return { outcome: RUN_OUTCOME.COMPLETED };
      },
    );

    await resumeToolUseFromResumeData(
      createToolUseResumeData({ executionId, streamId }),
    );

    expect(setModelInfo).toHaveBeenCalledWith({
      capabilities: { supportsVision: true },
      config: { provider: 'anthropic' },
    });
    // The flow's ModelCell is the live model; these mirrors would otherwise
    // keep reporting the model the run started with.
    expect(ctx.config.model).toBe('next-model');
    expect(ctx.userVarChannels.transient.MODEL).toBe('next-model');
  });

  it('carries a failed resumed flow result, error included, to the lifecycle', async () => {
    const executionId = 'e9421-error' as ExecutionId;
    const streamId = 'stream-9421-error' as StreamTabId;
    const flowError = {
      message: 'provider failed mid-resume',
      userRetryable: true,
    };
    mocks.buildAgentLaunchContext.mockResolvedValueOnce(
      buildResumeContext(executionId, streamId, { setModelInfo: vi.fn() }),
    );
    mocks.hasPersistedParent.mockResolvedValueOnce(true);
    mocks.runFlowWithLifecycle.mockImplementationOnce(
      async (
        _context: unknown,
        run: (liveHandle: unknown) => Promise<unknown>,
      ) => run(noopFlowHandle()),
    );
    mocks.runToolUseFlow.mockResolvedValueOnce({
      outcome: RUN_OUTCOME.FAILED,
      response: 'partial answer',
      totalCostUsd: 0.25,
      error: flowError,
    });

    const result = await resumeToolUseFromResumeData(
      createToolUseResumeData({ executionId, streamId }),
    );

    expect(result).toMatchObject({
      category: 'toolUse',
      outcome: RUN_OUTCOME.FAILED,
      response: 'partial answer',
      totalCostUsd: 0.25,
      executionId,
      streamId,
      error: flowError,
    });
  });
});
