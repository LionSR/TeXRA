// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';

// Local imports
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import type { FileContext } from '@agent/runtime/textEnhancement';
import { ProgressFollowUpPolishController } from '@controllers/progressView/ProgressFollowUpPolishController';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { AgentCategory } from '@shared/schemas';

function createWorkflowConfig(): AgentConfig {
  return AgentConfigSchema.parse({
    agent: 'writer',
    model: 'gemini31p',
    inputFiles: ['main.tex'],
    contextFiles: [],
    mediaFiles: [],
    outputFiles: ['answer.tex'],
    agentCategory: AgentCategory.Workflow,
  });
}

function polishDraft(
  controller: ProgressFollowUpPolishController,
  text = 'draft text',
) {
  return controller.polishFollowUp({
    stream: 'stream-a',
    text,
    runConfig: createWorkflowConfig(),
  });
}

describe('ProgressFollowUpPolishController', () => {
  it('returns a polished text update and builds file context from the run config', async () => {
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

    const result = await polishDraft(controller, 'plz check proof');

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

    const result = await polishDraft(controller);

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

    const result = await polishDraft(controller);

    assert.deepEqual(result, { kind: 'skipped' });
  });

  it('returns a logged exception result when polishing throws', async () => {
    const error = new Error('network down');
    const controller = new ProgressFollowUpPolishController({
      polishText: async () => {
        throw error;
      },
    });

    const result = await polishDraft(controller);

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
});
