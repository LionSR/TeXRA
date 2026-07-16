import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkflowAgentInvocation } from '@agent/workflowScript';
import type { LaunchRunContext } from '@agent/runtime/RunContext';
import type { AgentFinalResult } from '@agent/runtime/AgentFinalResult';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { createWorkflowScriptAgentRunner } from '@tools/delegation/workflowScriptAgentRunner';
import {
  SubagentDurabilityError,
  SubagentReconciliationError,
} from '@tools/delegation/inBandSubagentExecution';

const mocks = vi.hoisted(() => ({
  executeSubagentInBand: vi.fn(),
  preparedOptions: [] as unknown[],
  requireVisibleAgent: vi.fn(),
  selectAvailableDelegationModel: vi.fn(),
  resolveChildRunOutput: vi.fn(),
  runStorageLocationFromAnyAbsolutePath: vi.fn(),
  assertWorkflowFilesExist: vi.fn(),
  configureDelegatedChildApprovals: vi.fn(),
}));

vi.mock('@tools/approval', () => ({
  configureDelegatedChildApprovals: mocks.configureDelegatedChildApprovals,
}));

vi.mock('@tools/delegation/inBandSubagentExecution', () => {
  class SubagentDurabilityError extends Error {
    constructor(message: string, options?: ErrorOptions) {
      super(message, options);
      this.name = 'SubagentDurabilityError';
    }
  }
  class SubagentReconciliationError extends SubagentDurabilityError {
    constructor(message: string) {
      super(message);
      this.name = 'SubagentReconciliationError';
    }
  }
  return {
    executeStableSubagentInBand: mocks.executeSubagentInBand,
    SubagentDurabilityError,
    SubagentReconciliationError,
  };
});

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

function defaultRunner(): ReturnType<typeof createWorkflowScriptAgentRunner> {
  return createWorkflowScriptAgentRunner(
    parentContext(),
    'correct',
    'tool-call-7',
  );
}

function invocation(
  options: WorkflowAgentInvocation['options'] = {},
): WorkflowAgentInvocation {
  return {
    index: 0,
    key: '0123456789abcdef',
    prompt: 'Draft the section.',
    options,
    signal: new AbortController().signal,
  };
}

describe('createWorkflowScriptAgentRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.preparedOptions.length = 0;
    mocks.requireVisibleAgent.mockImplementation((_category, name) => ({
      name,
      source: 'builtInWorkflow',
      category: 'workflow',
      path: `/agents/${name}.yml`,
    }));
    mocks.selectAvailableDelegationModel.mockResolvedValue('child-model');
    mocks.assertWorkflowFilesExist.mockResolvedValue(undefined);
    mocks.runStorageLocationFromAnyAbsolutePath.mockReturnValue(undefined);
    mocks.executeSubagentInBand.mockImplementation(async (options) => {
      mocks.preparedOptions.push(await options.prepare());
      return { executionId: 'bbbbbb222222', result };
    });
  });

  it('uses delegation policy and executes a direct in-band child', async () => {
    const call = invocation({ inputFiles: ['paper.tex'] });
    const runner = defaultRunner();

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
        executionId: expect.stringMatching(/^[a-f0-9]{24}$/),
        parentExecutionId,
        signal: call.signal,
        prepare: expect.any(Function),
      }),
    );
    expect(mocks.preparedOptions[0]).toEqual(
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
    const runner = defaultRunner();

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
    expect(mocks.preparedOptions[0]).toEqual(
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
    const runner = defaultRunner();

    await runner(invocation({ inputFiles: [placeholder] }));

    expect(mocks.preparedOptions[0]).toEqual(
      expect.objectContaining({
        configPayload: expect.objectContaining({ inputFiles: [] }),
      }),
    );
  });

  it('links child approval ancestry to the parent stream on resolve', async () => {
    const runner = defaultRunner();

    await runner(invocation());

    const prepared = mocks.preparedOptions[0] as {
      onStreamResolved?: (streamId: StreamTabId) => void;
    };
    expect(prepared.onStreamResolved).toEqual(expect.any(Function));
    prepared.onStreamResolved?.('stream:child' as StreamTabId);
    expect(mocks.configureDelegatedChildApprovals).toHaveBeenCalledWith(
      'stream:child',
      parentStreamId,
      'inherit',
      expect.objectContaining({ id: 'session' }),
    );
  });

  it('threads onCost through to the child execution', async () => {
    const onCost = vi.fn();
    const runner = createWorkflowScriptAgentRunner(
      parentContext(),
      'correct',
      'tool-call-7',
      { onCost },
    );

    await runner(invocation());

    expect(mocks.preparedOptions[0]).toEqual(
      expect.objectContaining({ onCost }),
    );
  });

  it('uses one stable child id per workflow call identity', async () => {
    const runner = defaultRunner();

    await runner(invocation());
    await runner(invocation());
    await runner({ ...invocation(), index: 1 });
    await runner({ ...invocation(), key: 'fedcba9876543210' });

    const executionIds = mocks.executeSubagentInBand.mock.calls.map(
      ([options]) => options.executionId,
    );
    expect(executionIds[0]).toBe(executionIds[1]);
    expect(executionIds[2]).toBe(executionIds[0]);
    expect(executionIds[3]).not.toBe(executionIds[0]);
  });

  it('rejects a cancelled child so the workflow journal can retry it', async () => {
    mocks.executeSubagentInBand.mockResolvedValueOnce({
      executionId: 'bbbbbb222222',
      result: {
        category: 'toolUse',
        outcome: 'cancelled',
        response: '',
        files: [],
        cost: 0,
      },
    });
    const runner = defaultRunner();

    await expect(runner(invocation())).rejects.toThrow(
      'Workflow subagent ended with cancelled outcome.',
    );
  });

  it('turns durable reconciliation failures into fatal workflow aborts', async () => {
    mocks.executeSubagentInBand.mockRejectedValueOnce(
      new SubagentReconciliationError('incomplete child state'),
    );
    const runner = defaultRunner();

    await expect(runner(invocation())).rejects.toMatchObject({
      name: 'WorkflowRunAbortError',
      message: 'incomplete child state',
    });
  });

  it('turns manifest-write failures into fatal workflow aborts', async () => {
    const durabilityError = new SubagentDurabilityError(
      'result manifest unavailable',
      { cause: new Error('storage offline') },
    );
    mocks.executeSubagentInBand.mockRejectedValueOnce(durabilityError);
    const runner = defaultRunner();

    await expect(runner(invocation())).rejects.toMatchObject({
      name: 'WorkflowRunAbortError',
      message: 'result manifest unavailable',
      cause: durabilityError,
    });
  });
});
