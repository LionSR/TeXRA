// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';

// Local imports - controllers
import { AgentCategory } from '@agent/core/definition/AgentDataclass';

// Local imports - agent
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import type { WorkflowTaskState } from '@agent/core/state/TaskState';
import type { FileContext } from '@agent/runtime/textEnhancement';
import { ProgressFollowUpPolishController } from '@controllers/progressView/ProgressFollowUpPolishController';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';

// Local imports - shared

function createWorkflowTaskState(
  overrides: Omit<Partial<AgentConfig>, 'agentCategory'> = {},
): WorkflowTaskState {
  return {
    agentConfig: AgentConfigSchema.parse({
      agent: 'writer',
      model: 'gemini31p',
      inputFiles: ['main.tex'],
      contextFiles: [],
      mediaFiles: [],
      outputFiles: ['answer.tex'],
      agentCategory: AgentCategory.Workflow,
      ...overrides,
    }) as AgentConfig & { agentCategory: typeof AgentCategory.Workflow },
    activeFiles: {
      input: true,
      context: false,
      media: false,
      output: true,
    },
  };
}

describe('ProgressFollowUpPolishController', () => {
  it('returns a polished text update and builds file context from task state', async () => {
    const calls: Array<{ text: string; fileContext?: FileContext }> = [];
    const controller = new ProgressFollowUpPolishController({
      polishText: async (text, fileContext) => {
        calls.push({ text, fileContext });
        return {
          success: true,
          text: 'Please inspect the proof.',
        };
      },
    });

    const result = await controller.polishFollowUp({
      stream: 'stream-a',
      text: 'plz check proof',
      taskState: createWorkflowTaskState(),
    });

    assert.deepEqual(result, {
      kind: 'updated',
      update: {
        command: PROGRESS_VIEW_COMMANDS.UPDATE_FOLLOW_UP_TEXT,
        stream: 'stream-a',
        kind: 'polished',
        text: 'Please inspect the proof.',
      },
    });
    assert.deepEqual(calls, [
      {
        text: 'plz check proof',
        fileContext: {
          agent: 'writer',
          inputFiles: ['main.tex'],
          outputFiles: ['answer.tex'],
        },
      },
    ]);
  });

  it('returns an error update when the model helper reports a polish failure', async () => {
    const controller = new ProgressFollowUpPolishController({
      polishText: async () => ({
        success: false,
        text: 'draft text',
        error: 'Model returned no text.',
      }),
    });

    const result = await controller.polishFollowUp({
      stream: 'stream-a',
      text: 'draft text',
      taskState: createWorkflowTaskState(),
    });

    assert.deepEqual(result, {
      kind: 'failed',
      update: {
        command: PROGRESS_VIEW_COMMANDS.UPDATE_FOLLOW_UP_TEXT,
        stream: 'stream-a',
        kind: 'polishError',
        text: null,
        error: 'Model returned no text.',
      },
      userMessage: 'Model returned no text.',
    });
  });

  it('skips when the model helper reports failure without an error', async () => {
    const controller = new ProgressFollowUpPolishController({
      polishText: async () => ({
        success: false,
        text: 'draft text',
      }),
    });

    const result = await controller.polishFollowUp({
      stream: 'stream-a',
      text: 'draft text',
      taskState: createWorkflowTaskState(),
    });

    assert.deepEqual(result, { kind: 'skipped' });
  });

  it('returns a logged exception result when polishing throws', async () => {
    const error = new Error('network down');
    const controller = new ProgressFollowUpPolishController({
      polishText: async () => {
        throw error;
      },
    });

    const result = await controller.polishFollowUp({
      stream: 'stream-a',
      text: 'draft text',
      taskState: createWorkflowTaskState(),
    });

    assert.deepEqual(result, {
      kind: 'exception',
      update: {
        command: PROGRESS_VIEW_COMMANDS.UPDATE_FOLLOW_UP_TEXT,
        stream: 'stream-a',
        kind: 'polishError',
        text: null,
        error: 'network down',
      },
      userMessage: 'Error polishing follow-up: network down',
      logMessage: 'Error polishing follow-up: network down',
      logData: error,
    });
  });

  it('skips polishing when no task state is available', async () => {
    let calls = 0;
    const controller = new ProgressFollowUpPolishController({
      polishText: async () => {
        calls += 1;
        return { success: true, text: 'unused' };
      },
    });

    const result = await controller.polishFollowUp({
      stream: 'stream-a',
      text: 'draft text',
      taskState: undefined,
    });

    assert.deepEqual(result, { kind: 'skipped' });
    assert.equal(calls, 0);
  });
});
