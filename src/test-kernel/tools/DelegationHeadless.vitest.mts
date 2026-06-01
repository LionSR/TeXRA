import { describe, expect, it, vi, beforeEach } from 'vitest';

import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { DelegateAgentTool } from '@tools/DelegationTools';

const mocks = vi.hoisted(() => ({
  enableYoloOnChildStream: vi.fn(),
  executeAgent: vi.fn(),
  getExecutionStore: vi.fn(),
  getVisibleAgents: vi.fn(),
  isApprovalBypassedForStream: vi.fn(),
  isProposalBypassedForStream: vi.fn(),
  registerExecution: vi.fn(),
  writeReport: vi.fn(),
  computeModelOptionsData: vi.fn(),
}));

vi.mock('@agent/index/agentRegistry', () => ({
  getVisibleAgents: mocks.getVisibleAgents,
}));

vi.mock('@agent/runtime/executeAgent', () => ({
  executeAgent: mocks.executeAgent,
}));

vi.mock('@agent/runtime/delegationPolicy', () => ({
  readNestedDelegationConfig: () => ({
    enabled: true,
    maxDepth: 3,
  }),
}));

vi.mock('@agent/storage', () => ({
  getExecutionStore: mocks.getExecutionStore,
  registerExecution: mocks.registerExecution,
}));

vi.mock('@model/computeModelOptions', () => ({
  computeModelOptionsData: mocks.computeModelOptionsData,
}));

vi.mock('@tools/approval', () => ({
  enableYoloOnChildStream: mocks.enableYoloOnChildStream,
  isApprovalBypassedForStream: mocks.isApprovalBypassedForStream,
  isProposalBypassedForStream: mocks.isProposalBypassedForStream,
}));

function runtimeHost() {
  return { emit: vi.fn() };
}

describe('headless delegation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getVisibleAgents.mockReturnValue([
      {
        name: 'review',
        description: 'Review work.',
        tools: [],
      },
    ]);
    mocks.computeModelOptionsData.mockResolvedValue([
      {
        value: 'deepseekT',
        label: 'DeepSeek',
        disabled: false,
        requiresKey: false,
      },
    ]);
    mocks.isProposalBypassedForStream.mockReturnValue(true);
    mocks.isApprovalBypassedForStream.mockReturnValue(false);
    mocks.registerExecution.mockResolvedValue(undefined);
    mocks.writeReport.mockResolvedValue(undefined);
    mocks.getExecutionStore.mockReturnValue({
      writeReport: mocks.writeReport,
    });
    mocks.executeAgent.mockResolvedValue({
      category: 'toolUse',
      status: 'stopped',
      executionId: 'child-exec',
      streamId: 'child-stream',
      lastResponse: 'The proof is correct.',
      touchedFiles: [],
    });
  });

  it('awaits child delegation during one-shot tool-use runs', async () => {
    const result = await withRunContext(
      createRunContext({
        runtimeHost: runtimeHost(),
        streamId: 'parent-stream',
        executionId: 'parent-exec',
        model: 'deepseekT',
        stopAfterCycle: true,
      }),
      () =>
        new DelegateAgentTool().call({
          agent: 'review',
          model: null,
          instruction: 'Check the proof.',
          memories: [],
          working_directory: null,
          execution_id: null,
        }),
    );

    expect(mocks.executeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'review',
        agentCategory: AgentCategory.ToolUse,
        instruction: 'Check the proof.',
        model: 'deepseekT',
      }),
      expect.any(String),
      expect.objectContaining({
        isSubagent: true,
        parentStreamId: 'parent-stream',
        stopAfterCycle: true,
      }),
    );
    expect(result.summary).toBe("Completed 'review'");
    expect(result.output).toContain('<subagent-result');
    expect(result.output).toContain('<response>');
    expect(result.output).toContain('The proof is correct.');
    expect(mocks.writeReport).toHaveBeenCalledWith(result.output);
  });

  it('formats returned child error results as subagent errors', async () => {
    mocks.executeAgent.mockImplementationOnce(async (_config, _id, options) => {
      await options.onError?.(new Error('review model failed'));
      return {
        category: 'toolUse',
        status: 'error',
        executionId: 'child-exec',
        streamId: 'child-stream',
      };
    });

    const result = await withRunContext(
      createRunContext({
        runtimeHost: runtimeHost(),
        streamId: 'parent-stream',
        executionId: 'parent-exec',
        model: 'deepseekT',
        stopAfterCycle: true,
      }),
      () =>
        new DelegateAgentTool().call({
          agent: 'review',
          model: null,
          instruction: 'Check the proof.',
          memories: [],
          working_directory: null,
          execution_id: null,
        }),
    );

    expect(result.summary).toBe("Subagent 'review' failed");
    expect(result.isError).toBe(true);
    expect(result.error).toBe('review model failed');
    expect(result.output).toContain('<subagent-error');
    expect(result.output).toContain('review model failed');
    expect(mocks.writeReport).toHaveBeenCalledWith(result.output);
  });

  it('keeps interactive delegations asynchronous', async () => {
    const result = await withRunContext(
      createRunContext({
        runtimeHost: runtimeHost(),
        streamId: 'parent-stream',
        executionId: 'parent-exec',
        model: 'deepseekT',
      }),
      () =>
        new DelegateAgentTool().call({
          agent: 'review',
          model: null,
          instruction: 'Check the proof.',
          memories: [],
          working_directory: null,
          execution_id: null,
        }),
    );

    expect(result.summary).toBe("Launched 'review' (async)");
    expect(result.output).toContain(
      "Subagent 'review' launched. Result will be delivered automatically",
    );
    expect(mocks.executeAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.not.objectContaining({ stopAfterCycle: true }),
    );
  });
});
