import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

import { buildMainViewState } from '@controllers/mainView/MainViewStateRestoreController';
import type { RuntimeTaskState } from '@agent/runtime/executionRequests';

describe('MainViewStateRestoreController', () => {
  it('restores workflow task state into the workflow selector', () => {
    const state = buildMainViewState({
      agentConfig: {
        agent: 'custom:correct',
        agentCategory: 'workflow',
        model: 'deepseekT',
        instruction: 'Check the proof.',
      },
      activeFiles: {
        input: true,
        context: false,
        media: false,
        output: true,
      },
    } as unknown as RuntimeTaskState);

    assert.equal(state.sessionType, 'workflow');
    assert.equal(state.workflowAgent, 'custom:correct');
    assert.equal(state.toolUseAgent, 'orchestrator');
    assert.equal(state.outputFilesActive, true);
  });

  it('restores tool-use task state into the tool-use selector', () => {
    const state = buildMainViewState({
      agentConfig: {
        agent: 'builtInToolUse:review',
        agentCategory: 'toolUse',
        model: 'deepseekT',
        instruction: 'Review the derivation.',
      },
      toolSessionState: {},
    } as unknown as RuntimeTaskState);

    assert.equal(state.sessionType, 'toolUse');
    assert.equal(state.workflowAgent, 'correct');
    assert.equal(state.toolUseAgent, 'builtInToolUse:review');
    assert.equal(state.outputFilesActive, false);
  });
});
