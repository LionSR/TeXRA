// Standard library imports
import { strict as assert } from 'assert';

// Local imports - agent
import { AgentCategory } from '@agent/core/AgentDataclass';
import type { AgentConfig } from '@agent/core/AgentConfig';

import type { TaskState } from '@agent/core/TaskState';

// Local imports - test support
import {
  createAgentConfig,
  createOutputFile,
  createProgressWorkflowActionsHarness,
  createWorkflowTaskState,
} from '../support/ProgressControllerHarnesses';

describe('ProgressWorkflowActionsController', () => {
  it('resumes workflow streams with their execution id', async () => {
    const taskState = createWorkflowTaskState();
    const { controller, executed } = createProgressWorkflowActionsHarness({
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
    const { controller, executed } = createProgressWorkflowActionsHarness({
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
      }) as AgentConfig & { agentCategory: typeof AgentCategory.ToolUse },
    };
    const { controller, diffs, fileOperations } =
      createProgressWorkflowActionsHarness({
        taskStates: new Map([['stream-a', toolUseState]]),
      });

    await controller.diffStream('stream-a');
    await controller.runFileOperation('stream-a', 'pack');

    assert.equal(diffs.length, 0);
    assert.equal(fileOperations.length, 0);
  });

  it('builds diff requests from workflow task and output state', async () => {
    const output = createOutputFile();
    const taskState = createWorkflowTaskState(
      { outputFiles: ['declared.tex'] },
      { output: false },
    );
    const { controller, diffs } = createProgressWorkflowActionsHarness({
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
    });
    const { controller, fileOperations } = createProgressWorkflowActionsHarness(
      {
        taskStates: new Map([['stream-a', taskState]]),
        executionIds: new Map([['stream-a', 'exec-123']]),
        knownWorkspaceOutputs: new Map([
          ['stream-a', new Set(['/workspace/generated.tex', 'extra.tex'])],
        ]),
      },
    );

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
          executionId: 'exec-123',
          skipProgressViewClear: true,
        },
      },
    ]);
  });

  it('passes all resolved output files for clean requests', async () => {
    const taskState = createWorkflowTaskState(
      { outputFiles: ['declared.tex'] },
      { output: true },
    );
    const { controller, fileOperations } = createProgressWorkflowActionsHarness(
      {
        taskStates: new Map([['stream-a', taskState]]),
        knownWorkspaceOutputs: new Map([
          ['stream-a', new Set(['generated.tex'])],
        ]),
      },
    );

    await controller.runFileOperation('stream-a', 'clean');

    assert.deepEqual(fileOperations, [
      {
        operation: 'clean',
        request: {
          streamId: 'stream-a',
          agent: 'correct',
          model: 'gemini31p',
          inputFile: 'input.tex',
          outputFiles: ['declared.tex', 'generated.tex'],
          skipProgressViewClear: true,
        },
      },
    ]);
  });
});
