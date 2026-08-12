import { strict as assert } from 'node:assert';

import { describe, it } from 'vitest';

import { AgentCategory } from '@shared/schemas';
import {
  createAgentConfig,
  createOutputFile,
  createProgressWorkflowActionsHarness,
  createWorkflowConfig,
} from '../support/ProgressControllerHarnesses';

describe('ProgressWorkflowActionsController', () => {
  it('ignores toolbar actions for non-workflow streams', async () => {
    const toolUseConfig = createAgentConfig({
      agentCategory: AgentCategory.ToolUse,
      outputFiles: [],
    });
    const { controller, diffs, fileOperations } =
      createProgressWorkflowActionsHarness({
        runConfigs: new Map([['stream-a', toolUseConfig]]),
      });

    await controller.diffStream('stream-a');
    await controller.runFileOperation('stream-a', 'pack');

    assert.equal(diffs.length, 0);
    assert.equal(fileOperations.length, 0);
  });

  it('builds diff requests from workflow run config and output state', async () => {
    const output = createOutputFile();
    const config = createWorkflowConfig({ outputFiles: ['declared.tex'] });
    const { controller, diffs, metadataReads } =
      createProgressWorkflowActionsHarness({
        runConfigs: new Map([['stream-a', config]]),
        executionIds: new Map([['stream-a', 'exec-123']]),
        outputs: new Map([['stream-a', { 1: [output] }]]),
      });

    await controller.diffStream('stream-a');

    assert.deepEqual(metadataReads, ['stream-a']);
    assert.deepEqual(diffs, [
      {
        agent: 'correct',
        model: 'gemini31p',
        inputFile: 'input.tex',
        outputFiles: ['declared.tex'],
        outputFilesActive: true,
        streamId: 'stream-a',
        runId: 'exec-123',
        outputsByRound: { 1: [output] },
      },
    ]);
  });

  it('reports no active output files when the run config declares none', async () => {
    const config = createWorkflowConfig({ outputFiles: [] });
    const { controller, diffs } = createProgressWorkflowActionsHarness({
      runConfigs: new Map([['stream-a', config]]),
    });

    await controller.diffStream('stream-a');

    assert.equal(diffs[0]?.outputFilesActive, false);
    assert.deepEqual(diffs[0]?.outputFiles, []);
  });

  it('deduplicates generated outputs for pack and includes execution context', async () => {
    const config = createWorkflowConfig({
      inputFiles: ['extra-input.tex', 'second-input.tex'],
      outputFiles: ['declared.tex', '/workspace/generated.tex'],
    });
    const { controller, fileOperations, metadataReads } =
      createProgressWorkflowActionsHarness({
        runConfigs: new Map([['stream-a', config]]),
        executionIds: new Map([['stream-a', 'exec-123']]),
        knownWorkspaceOutputs: new Map([
          ['stream-a', new Set(['/workspace/generated.tex', 'extra.tex'])],
        ]),
      });

    await controller.runFileOperation('stream-a', 'pack');

    assert.deepEqual(metadataReads, ['stream-a']);
    assert.deepEqual(fileOperations, [
      {
        operation: 'pack',
        request: {
          streamId: 'stream-a',
          agent: 'correct',
          model: 'gemini31p',
          inputFile: 'extra-input.tex',
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
    const config = createWorkflowConfig({ outputFiles: ['declared.tex'] });
    const { controller, fileOperations } = createProgressWorkflowActionsHarness(
      {
        runConfigs: new Map([['stream-a', config]]),
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
