// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';

// Local imports
import {
  MainViewStartupController,
  type MainViewStartupControllerDeps,
} from '@controllers/mainView/MainViewStartupController';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';

function createController(
  overrides: Partial<MainViewStartupControllerDeps> = {},
): MainViewStartupController {
  return new MainViewStartupController({
    getConfig: (_key, defaultValue) => defaultValue,
    loadOptions: async () => ({
      modelOptions: [],
      agentOptions: {},
      teamOptions: [],
    }),
    getAuthStatus: async () => ({ authenticated: false }),
    ...overrides,
  });
}

describe('MainViewStartupController', () => {
  it('uses config to choose the orchestrator banner message', () => {
    assert.deepEqual(createController().getOrchestratorBannerMessage(), {
      command: MAIN_VIEW_COMMANDS.SHOW_ORCHESTRATOR_BANNER,
    });
  });

  it('hides the orchestrator banner when disabled', () => {
    const controller = createController({ getConfig: <T>() => false as T });

    assert.deepEqual(controller.getOrchestratorBannerMessage(), {
      command: MAIN_VIEW_COMMANDS.HIDE_ORCHESTRATOR_BANNER,
    });
  });

  it('loads options and shows the login banner for signed-out users', async () => {
    const controller = createController({
      loadOptions: async () => ({
        modelOptions: [{ value: 'gemini', label: 'Gemini' }],
        modelOptionsByCategory: {
          workflow: [{ value: 'gemini', label: 'Gemini' }],
          toolUse: [{ value: 'gpt', label: 'GPT' }],
        },
        agentOptions: {
          workflow: [{ value: 'correct', label: 'Correct' }],
          toolUse: [{ value: 'orchestrator', label: 'Orchestrator' }],
        },
        teamOptions: [
          {
            value: 'physicist',
            label: 'Physicist',
            icon: 'atom',
            source: 'built-in',
            description: 'A physics research team.',
            unavailableMembers: [],
            rootAgentName: 'orchestrator',
          },
        ],
      }),
    });

    assert.deepEqual(await controller.getOptionsAndLoginMessages(), [
      {
        command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
        optionsData: [{ value: 'gemini', label: 'Gemini' }],
        optionsDataByCategory: {
          workflow: [{ value: 'gemini', label: 'Gemini' }],
          toolUse: [{ value: 'gpt', label: 'GPT' }],
        },
      },
      {
        command: MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
        optionsData: {
          workflow: [{ value: 'correct', label: 'Correct' }],
          toolUse: [{ value: 'orchestrator', label: 'Orchestrator' }],
        },
      },
      {
        command: MAIN_VIEW_COMMANDS.SET_TEAM_OPTIONS,
        optionsData: [
          {
            value: 'physicist',
            label: 'Physicist',
            icon: 'atom',
            source: 'built-in',
            description: 'A physics research team.',
            unavailableMembers: [],
            rootAgentName: 'orchestrator',
          },
        ],
      },
      { command: MAIN_VIEW_COMMANDS.SHOW_LOGIN_BANNER },
    ]);
  });

  it('hides the login banner for signed-in users', async () => {
    const controller = createController({
      getAuthStatus: async () => ({ authenticated: true }),
    });

    const messages = await controller.getOptionsAndLoginMessages();

    assert.equal(
      messages.at(-1)?.command,
      MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER,
    );
  });
});
