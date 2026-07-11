// Third-party imports
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildAgentLaunchContext: vi.fn(),
  computeDelegationDepthFromStorage: vi.fn(),
  invokeModelOrTool: vi.fn(),
  runFlowWithLifecycle: vi.fn(),
  runToolUseFlow: vi.fn(),
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

vi.mock('@agent/runtime/delegationPolicy', () => ({
  computeDelegationDepthFromStorage: mocks.computeDelegationDepthFromStorage,
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
}

interface TestFlowContext {
  readonly session: { appendFollowUp(item: unknown): void };
  interrupt(): void;
}

describe('resumeToolUseFromSnapshot cancellation handoff', () => {
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
    mocks.computeDelegationDepthFromStorage.mockResolvedValueOnce(0);
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
      isCancellationRequested: () => {
        order.push('query');
        expect(attachedContext).toBeDefined();
        return true;
      },
    });

    expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
    expect(mocks.invokeModelOrTool).not.toHaveBeenCalled();
    expect(order).toEqual(['attach', 'query', 'interrupt', 'detach']);
  });
});
