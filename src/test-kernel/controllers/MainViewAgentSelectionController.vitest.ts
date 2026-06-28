import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

import { MainViewAgentSelectionController } from '@controllers/mainView/MainViewAgentSelectionController';
import type { RuntimeAgentEntry } from '@agent/runtime/agentResolution';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc/mainViewCommands';

function agent(entry: {
  source: string;
  name: string;
  category: 'workflow' | 'toolUse';
}): RuntimeAgentEntry {
  return entry as RuntimeAgentEntry;
}

describe('MainViewAgentSelectionController', () => {
  it('selects source-qualified agents with the runtime category as session type', () => {
    const controller = new MainViewAgentSelectionController({
      getAgent: (agentIdentifier) =>
        agentIdentifier === 'remote:analyst'
          ? agent({
              source: 'remote',
              name: 'analyst',
              category: 'toolUse',
            })
          : undefined,
    });

    assert.deepEqual(
      controller.getSourceAgentSelection({
        source: 'remote',
        name: 'analyst',
      }),
      {
        command: MAIN_VIEW_COMMANDS.SET_SELECTED_AGENT,
        agentId: 'remote:analyst',
        sessionType: 'toolUse',
      },
    );
  });

  it('falls back from source when an entry is not loaded yet', () => {
    const controller = new MainViewAgentSelectionController({
      getAgent: () => undefined,
    });

    assert.deepEqual(
      controller.getSourceAgentSelection({
        source: 'builtInToolUse',
        name: 'review',
      }),
      {
        command: MAIN_VIEW_COMMANDS.SET_SELECTED_AGENT,
        agentId: 'builtInToolUse:review',
        sessionType: 'toolUse',
      },
    );
    assert.deepEqual(
      controller.getSourceAgentSelection({
        source: 'remote',
        name: 'writer',
      }),
      {
        command: MAIN_VIEW_COMMANDS.SET_SELECTED_AGENT,
        agentId: 'remote:writer',
        sessionType: 'workflow',
      },
    );
  });

  it('selects tool-use agents by catalogue lookup with a plain-name fallback', () => {
    const controller = new MainViewAgentSelectionController({
      getToolUseAgent: (agentIdentifier) =>
        agentIdentifier === 'setup'
          ? agent({
              source: 'builtInToolUse',
              name: 'setup',
              category: 'toolUse',
            })
          : undefined,
    });

    assert.deepEqual(controller.getToolUseAgentSelection('setup'), {
      command: MAIN_VIEW_COMMANDS.SET_SELECTED_AGENT,
      agentId: 'builtInToolUse:setup',
      sessionType: 'toolUse',
    });
    assert.deepEqual(controller.getToolUseAgentSelection('missing'), {
      command: MAIN_VIEW_COMMANDS.SET_SELECTED_AGENT,
      agentId: 'missing',
      sessionType: 'toolUse',
    });
  });

  it('resolves category-based selections for restored main-view state', () => {
    const controller = new MainViewAgentSelectionController({
      getWorkflowAgent: (agentIdentifier) =>
        agentIdentifier === 'correct'
          ? agent({
              source: 'builtInWorkflow',
              name: 'correct',
              category: 'workflow',
            })
          : undefined,
      getToolUseAgent: (agentIdentifier) =>
        agentIdentifier === 'setup'
          ? agent({
              source: 'builtInToolUse',
              name: 'setup',
              category: 'toolUse',
            })
          : undefined,
    });

    assert.deepEqual(
      controller.getCategoryAgentSelection({
        agentIdentifier: 'correct',
        category: 'workflow',
      }),
      {
        command: MAIN_VIEW_COMMANDS.SET_SELECTED_AGENT,
        agentId: 'builtInWorkflow:correct',
        sessionType: 'workflow',
      },
    );
    assert.deepEqual(
      controller.getCategoryAgentSelection({
        agentIdentifier: 'setup',
        category: 'toolUse',
      }),
      {
        command: MAIN_VIEW_COMMANDS.SET_SELECTED_AGENT,
        agentId: 'builtInToolUse:setup',
        sessionType: 'toolUse',
      },
    );
  });

  it('preserves category-based identifiers when the catalog lookup misses', () => {
    const controller = new MainViewAgentSelectionController({
      getWorkflowAgent: () => undefined,
      getToolUseAgent: () => undefined,
    });

    assert.deepEqual(
      controller.getCategoryAgentSelection({
        agentIdentifier: 'not-loaded-yet',
        category: 'workflow',
      }),
      {
        command: MAIN_VIEW_COMMANDS.SET_SELECTED_AGENT,
        agentId: 'not-loaded-yet',
        sessionType: 'workflow',
      },
    );
  });
});
