// Standard library imports
import { strict as assert } from 'assert';

// Local imports - agent
import { AgentCategory } from '@agent/core/AgentDataclass';
import { AgentConfigSchema, type AgentConfig } from '@agent/core/AgentConfig';
import type { ExecutionRequest } from '@agent/core/executionRequests';

// Local imports - logger
import type { TaskState, WorkflowTaskState } from '@logger/TaskState';

// Local imports - shared
import type { OutputFileInfo, StreamTabId } from '@shared/schemas';

// Local imports - controllers
import {
  ProgressWorkflowActionsController,
  type WorkflowDiffRequest,
  type WorkflowFileOperation,
  type WorkflowFileOperationRequest,
} from '../../controllers/progressView/ProgressWorkflowActionsController';

function createAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return AgentConfigSchema.parse({
    agent: 'correct',
    model: 'gemini31p',
    inputFile: 'input.tex',
    outputFiles: ['declared.tex'],
    agentCategory: AgentCategory.Workflow,
    ...overrides,
  });
}

function createWorkflowTaskState(
  overrides: Partial<AgentConfig> = {},
  activeFiles: Partial<WorkflowTaskState['activeFiles']> = {},
): WorkflowTaskState {
  return {
    agentConfig: createAgentConfig({
      agentCategory: AgentCategory.Workflow,
      ...overrides,
    }) as AgentConfig & { agentCategory: AgentCategory.Workflow },
    activeFiles: {
      input: true,
      reference: false,
      auxiliary: false,
      media: false,
      output: true,
      ...activeFiles,
    },
  };
}

function createOutputFile(
  absolutePath: string,
  relativePath = absolutePath,
): OutputFileInfo {
  return {
    source: 'input.tex',
    location: {
      kind: 'workspace',
      absolutePath,
      relativePath,
    },
    round: 1,
    lineage: null,
    diff: null,
  };
}

function createController(options?: {
  taskStates?: Map<StreamTabId, TaskState>;
  executionIds?: Map<StreamTabId, string>;
  outputs?: Map<StreamTabId, Map<number, OutputFileInfo[]>>;
  knownWorkspaceOutputs?: Map<StreamTabId, Set<string>>;
}): {
  controller: ProgressWorkflowActionsController;
  executed: ExecutionRequest[];
  diffs: WorkflowDiffRequest[];
  fileOperations: Array<{
    operation: WorkflowFileOperation;
    request: WorkflowFileOperationRequest;
  }>;
} {
  const executed: ExecutionRequest[] = [];
  const diffs: WorkflowDiffRequest[] = [];
  const fileOperations: Array<{
    operation: WorkflowFileOperation;
    request: WorkflowFileOperationRequest;
  }> = [];

  return {
    controller: new ProgressWorkflowActionsController({
      state: {
        getTaskState: (stream) => options?.taskStates?.get(stream),
        getExecutionId: (stream) => options?.executionIds?.get(stream),
        getOutputFiles: (stream) =>
          new Map(options?.outputs?.get(stream) ?? []),
        getKnownWorkspaceOutputPaths: (stream) =>
          new Set(options?.knownWorkspaceOutputs?.get(stream) ?? []),
      },
      executeAgent: async (request) => {
        executed.push(request);
      },
      runDiff: async (request) => {
        diffs.push(request);
      },
      runFileOperation: async (operation, request) => {
        fileOperations.push({ operation, request });
      },
    }),
    executed,
    diffs,
    fileOperations,
  };
}

describe('ProgressWorkflowActionsController', () => {
  it('resumes workflow streams with their execution id', async () => {
    const taskState = createWorkflowTaskState();
    const { controller, executed } = createController({
      taskStates: new Map([['stream-a', taskState]]),
      executionIds: new Map([['stream-a', 'exec-123']]),
    });

    await controller.resume('stream-a');

    assert.deepEqual(executed, [
      { config: taskState.agentConfig, executionId: 'exec-123' },
    ]);
  });

  it('runs a fresh request without the existing execution id', async () => {
    const taskState = createWorkflowTaskState();
    const { controller, executed } = createController({
      taskStates: new Map([['stream-a', taskState]]),
      executionIds: new Map([['stream-a', 'exec-123']]),
    });

    await controller.runNew('stream-a');

    assert.deepEqual(executed, [{ config: taskState.agentConfig }]);
  });

  it('ignores toolbar actions for non-workflow streams', async () => {
    const toolUseState: TaskState = {
      agentConfig: createAgentConfig({
        agentCategory: AgentCategory.ToolUse,
        outputFiles: [],
      }) as AgentConfig & { agentCategory: AgentCategory.ToolUse },
    };
    const { controller, diffs, fileOperations } = createController({
      taskStates: new Map([['stream-a', toolUseState]]),
    });

    await controller.diffStream('stream-a');
    await controller.runFileOperation('stream-a', 'pack');

    assert.equal(diffs.length, 0);
    assert.equal(fileOperations.length, 0);
  });

  it('builds diff requests from workflow task and output state', async () => {
    const output = createOutputFile(
      '/workspace/generated.tex',
      'generated.tex',
    );
    const taskState = createWorkflowTaskState(
      { outputFiles: ['declared.tex'] },
      { output: false },
    );
    const { controller, diffs } = createController({
      taskStates: new Map([['stream-a', taskState]]),
      executionIds: new Map([['stream-a', 'exec-123']]),
      outputs: new Map([['stream-a', new Map([[1, [output]]])]]),
    });

    await controller.diffStream('stream-a');

    assert.deepEqual(diffs, [
      {
        agent: 'correct',
        model: 'gemini31p',
        inputFile: 'input.tex',
        outputFiles: ['declared.tex'],
        outputFilesActive: false,
        streamId: 'stream-a',
        runId: 'exec-123',
        outputsByRound: { 1: [output] },
      },
    ]);
  });

  it('deduplicates generated outputs for pack and includes execution context', async () => {
    const taskState = createWorkflowTaskState({
      inputFiles: ['extra-input.tex'],
      outputFiles: ['declared.tex', '/workspace/generated.tex'],
      useMultipleOutputs: true,
    });
    const { controller, fileOperations } = createController({
      taskStates: new Map([['stream-a', taskState]]),
      executionIds: new Map([['stream-a', 'exec-123']]),
      knownWorkspaceOutputs: new Map([
        ['stream-a', new Set(['/workspace/generated.tex', 'extra.tex'])],
      ]),
    });

    await controller.runFileOperation('stream-a', 'pack');

    assert.deepEqual(fileOperations, [
      {
        operation: 'pack',
        request: {
          streamId: 'stream-a',
          agent: 'correct',
          model: 'gemini31p',
          inputFile: 'input.tex',
          outputFiles: [
            'declared.tex',
            '/workspace/generated.tex',
            'extra.tex',
          ],
          useMultipleOutputs: true,
          executionId: 'exec-123',
          skipProgressViewClear: true,
        },
      },
    ]);
  });

  it('hides output files for single-output clean requests', async () => {
    const taskState = createWorkflowTaskState(
      {
        outputFiles: ['declared.tex'],
        useMultipleOutputs: false,
      },
      { output: true },
    );
    const { controller, fileOperations } = createController({
      taskStates: new Map([['stream-a', taskState]]),
      knownWorkspaceOutputs: new Map([
        ['stream-a', new Set(['generated.tex'])],
      ]),
    });

    await controller.runFileOperation('stream-a', 'clean');

    assert.deepEqual(fileOperations, [
      {
        operation: 'clean',
        request: {
          streamId: 'stream-a',
          agent: 'correct',
          model: 'gemini31p',
          inputFile: 'input.tex',
          outputFiles: [],
          useMultipleOutputs: false,
          skipProgressViewClear: true,
        },
      },
    ]);
  });
});
