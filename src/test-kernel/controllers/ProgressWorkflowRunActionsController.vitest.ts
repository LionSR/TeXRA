import { strict as assert } from 'node:assert';

import { describe, it } from 'vitest';

import { AgentCategory, type RunId } from '@shared/schemas';
import {
  createAgentConfig,
  createOutputFile,
  createProgressWorkflowRunActionsHarness,
  createWorkflowConfig,
} from '../support/ProgressControllerHarnesses';

const RUN_A = 'ab12cd' as RunId;

describe('ProgressWorkflowRunActionsController', () => {
  it('ignores toolbar actions for non-workflow runs', async () => {
    const toolUseConfig = createAgentConfig({
      agentCategory: AgentCategory.ToolUse,
      outputFiles: [],
    });
    const { controller, diffs, fileOperations } =
      createProgressWorkflowRunActionsHarness({});

    await controller.diffStream(RUN_A, toolUseConfig);
    await controller.runFileOperation(RUN_A, 'pack', toolUseConfig);

    assert.equal(diffs.length, 0);
    assert.equal(fileOperations.length, 0);
  });

  it('builds diff requests from workflow run config and output state', async () => {
    const output = createOutputFile();
    const config = createWorkflowConfig({ outputFiles: ['declared.tex'] });
    const { controller, diffs } = createProgressWorkflowRunActionsHarness({
      outputs: new Map([[RUN_A, { 1: [output] }]]),
    });

    await controller.diffStream(RUN_A, config);

    assert.deepEqual(diffs, [
      {
        agent: 'correct',
        model: 'gemini31p',
        inputFile: 'input.tex',
        outputFiles: ['declared.tex'],
        outputFilesActive: true,
        runId: RUN_A,
        outputsByRound: { 1: [output] },
      },
    ]);
  });

  it('deduplicates generated outputs for pack and includes run context', async () => {
    const config = createWorkflowConfig({
      inputFiles: ['extra-input.tex', 'second-input.tex'],
      outputFiles: ['declared.tex', '/workspace/generated.tex'],
    });
    const { controller, fileOperations } =
      createProgressWorkflowRunActionsHarness({
        knownWorkspaceOutputs: new Map([
          [RUN_A, new Set(['/workspace/generated.tex', 'extra.tex'])],
        ]),
      });

    await controller.runFileOperation(RUN_A, 'pack', config);

    assert.deepEqual(fileOperations, [
      {
        operation: 'pack',
        request: {
          agent: 'correct',
          model: 'gemini31p',
          inputFile: 'extra-input.tex',
          outputFiles: [
            'declared.tex',
            '/workspace/generated.tex',
            'extra.tex',
          ],
          runId: RUN_A,
        },
      },
    ]);
  });
});
