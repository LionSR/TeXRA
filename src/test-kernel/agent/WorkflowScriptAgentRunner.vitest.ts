import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkflowAgentInvocation } from '@agent/workflowScript';
import type { LaunchRunContext } from '@agent/runtime/RunContext';
import type { AgentFinalResult } from '@agent/runtime/AgentFinalResult';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { createWorkflowScriptAgentRunner } from '@tools/delegation/workflowScriptAgentRunner';

const mocks = vi.hoisted(() => ({
  executeSubagentInBand: vi.fn(),
  requireVisibleAgent: vi.fn(),
  selectAvailableDelegationModel: vi.fn(),
  resolveChildRunOutput: vi.fn(),
  runStorageLocationFromAnyAbsolutePath: vi.fn(),
  assertWorkflowFilesExist: vi.fn(),
}));

vi.mock('@tools/delegation/inBandSubagentExecution', () => ({
  executeSubagentInBand: mocks.executeSubagentInBand,
}));

vi.mock('@tools/delegation/proposalFlow', () => ({
  requireVisibleAgent: mocks.requireVisibleAgent,
  selectAvailableDelegationModel: mocks.selectAvailableDelegationModel,
}));

vi.mock('@agent/storage', () => ({
  resolveChildRunOutput: mocks.resolveChildRunOutput,
}));

vi.mock('@utils/files/taskRunStorage', () => ({
  runStorageLocationFromAnyAbsolutePath:
    mocks.runStorageLocationFromAnyAbsolutePath,
}));

vi.mock('@tools/delegation/workflowFileValidation', () => ({
  assertWorkflowFilesExist: mocks.assertWorkflowFilesExist,
}));

const parentExecutionId = 'aaaaaa111111' as ExecutionId;
const parentStreamId = 'stream:workflow-script' as StreamTabId;
const result: AgentFinalResult = {
  category: 'workflow',
  outcome: 'completed',
  outputs: [],
  compileFailures: [],
  diffs: [],
  cost: 0,
};

function parentContext(): LaunchRunContext {
  return {
    kind: 'launch',
    model: 'parent-model',
    approvalPromptsUnavailable: true,
    runtimeUnavailableTools: ['user_question'],
    runScope: {
      executionId: parentExecutionId,
      streamId: parentStreamId,
      agentName: 'orchestrator',
      workingDirectory: '/workspace',
      delegationAgentScope: {
        workflowAgentKeys: ['builtInWorkflow:correct'],
        toolUseAgentKeys: ['builtInToolUse:assistant'],
      },
      runtimeHost: { emit: vi.fn() } as never,
      session: { id: 'session' } as never,
    },
  };
}

function invocation(
  options: WorkflowAgentInvocation['options'] = {},
): WorkflowAgentInvocation {
  return {
    index: 0,
    prompt: 'Draft the section.',
    options,
    signal: new AbortController().signal,
  };
}

describe('createWorkflowScriptAgentRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireVisibleAgent.mockImplementation((_category, name) => ({
      name,
      source: 'builtInWorkflow',
      category: 'workflow',
      path: `/agents/${name}.yml`,
    }));
    mocks.selectAvailableDelegationModel.mockResolvedValue('child-model');
    mocks.assertWorkflowFilesExist.mockResolvedValue(undefined);
    mocks.runStorageLocationFromAnyAbsolutePath.mockReturnValue(undefined);
    mocks.executeSubagentInBand.mockResolvedValue({
      executionId: 'bbbbbb222222',
      result,
    });
  });

  it('uses delegation policy and executes a direct in-band child', async () => {
    const parent = parentContext();
    const call = invocation({ inputFiles: ['paper.tex'] });
    const runner = createWorkflowScriptAgentRunner(parent, 'correct');

    await expect(runner(call)).resolves.toBe(result);
    expect(mocks.requireVisibleAgent).toHaveBeenCalledWith(
      'workflow',
      'correct',
      {
        workflowAgentKeys: ['builtInWorkflow:correct'],
        toolUseAgentKeys: ['builtInToolUse:assistant'],
      },
    );
    expect(mocks.assertWorkflowFilesExist).toHaveBeenCalledWith([
      { label: 'Input file', files: ['paper.tex'] },
    ]);
    expect(mocks.selectAvailableDelegationModel).toHaveBeenCalledWith({
      parentModel: 'parent-model',
      agentCategory: 'workflow',
    });
    expect(mocks.executeSubagentInBand).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'correct',
        parentExecutionId,
        parentStreamId,
        signal: call.signal,
        approvalPromptsUnavailable: true,
        runtimeUnavailableTools: ['user_question'],
        configPayload: expect.objectContaining({
          agent: 'correct',
          agentSource: 'builtInWorkflow',
          agentCategory: 'workflow',
          model: 'child-model',
          instruction: 'Draft the section.',
          inputFiles: ['paper.tex'],
          workingDirectory: '/workspace',
          delegationAgentScope: {
            workflowAgentKeys: ['builtInWorkflow:correct'],
            toolUseAgentKeys: ['builtInToolUse:assistant'],
          },
        }),
      }),
    );
  });

  it('honors an explicit agent and binds verified run outputs', async () => {
    const requested = '/storage/executions/bbbbbb222222/r1/draft.tex';
    const canonical = '/canonical/executions/bbbbbb222222/r1/draft.tex';
    mocks.runStorageLocationFromAnyAbsolutePath.mockImplementation((file) =>
      file === requested ? { kind: 'runStorage' } : undefined,
    );
    mocks.resolveChildRunOutput.mockResolvedValue({
      kind: 'runStorage',
      absolutePath: canonical,
      relativePath: 'r1/draft.tex',
      executionId: 'bbbbbb222222',
    });
    const runner = createWorkflowScriptAgentRunner(parentContext(), 'correct');

    await runner(
      invocation({
        agentName: 'merge',
        inputFiles: ['notes.tex', requested],
      }),
    );

    expect(mocks.resolveChildRunOutput).toHaveBeenCalledWith(
      parentExecutionId,
      requested,
    );
    expect(mocks.assertWorkflowFilesExist).toHaveBeenCalledWith([
      { label: 'Input file', files: ['notes.tex'] },
    ]);
    expect(mocks.executeSubagentInBand).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'merge',
        configPayload: expect.objectContaining({
          inputFiles: ['notes.tex', canonical],
        }),
      }),
    );
  });

  it('omits declared symlink placeholders from the next child input', async () => {
    const placeholder = '/storage/executions/bbbbbb222222/r1/unchanged.tex';
    mocks.runStorageLocationFromAnyAbsolutePath.mockReturnValue({
      kind: 'runStorage',
    });
    mocks.resolveChildRunOutput.mockResolvedValue(undefined);
    const runner = createWorkflowScriptAgentRunner(parentContext(), 'correct');

    await runner(invocation({ inputFiles: [placeholder] }));

    expect(mocks.executeSubagentInBand).toHaveBeenCalledWith(
      expect.objectContaining({
        configPayload: expect.objectContaining({ inputFiles: [] }),
      }),
    );
  });
});
