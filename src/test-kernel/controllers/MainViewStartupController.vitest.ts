// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Standard library imports

// Local imports - common
import { MainViewStartupController } from '@controllers/mainView/MainViewStartupController';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc/mainViewCommands';

// Local imports - controllers

describe('MainViewStartupController', () => {
  it('uses config to choose the orchestrator banner message', () => {
    const controller = new MainViewStartupController({
      getConfig: (_key, defaultValue) => defaultValue,
      loadOptions: async () => ({ modelOptions: [], agentOptions: {} }),
      getAuthStatus: async () => ({ authenticated: false }),
    });

    assert.deepEqual(controller.getOrchestratorBannerMessage(), {
      command: MAIN_VIEW_COMMANDS.SHOW_ORCHESTRATOR_BANNER,
    });
  });

  it('hides the orchestrator banner when disabled', () => {
    const controller = new MainViewStartupController({
      getConfig: <T>() => false as T,
      loadOptions: async () => ({ modelOptions: [], agentOptions: {} }),
      getAuthStatus: async () => ({ authenticated: false }),
    });

    assert.deepEqual(controller.getOrchestratorBannerMessage(), {
      command: MAIN_VIEW_COMMANDS.HIDE_ORCHESTRATOR_BANNER,
    });
  });

  it('loads options and shows the login banner for signed-out users', async () => {
    const events: string[] = [];
    const controller = new MainViewStartupController({
      getConfig: (_key, defaultValue) => defaultValue,
      refreshAgentCatalog: async () => {
        events.push('refreshAgentCatalog');
      },
      loadOptions: async () => {
        events.push('loadOptions');
        return {
          modelOptions: [{ value: 'gemini', label: 'Gemini' }],
          agentOptions: {
            workflow: [{ value: 'correct', label: 'Correct' }],
            toolUse: [{ value: 'orchestrator', label: 'Orchestrator' }],
          },
        };
      },
      getAuthStatus: async () => ({ authenticated: false }),
    });

    assert.deepEqual(await controller.getOptionsAndLoginMessages(), [
      {
        command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
        optionsData: [{ value: 'gemini', label: 'Gemini' }],
      },
      {
        command: MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
        optionsData: {
          workflow: [{ value: 'correct', label: 'Correct' }],
          toolUse: [{ value: 'orchestrator', label: 'Orchestrator' }],
        },
      },
      { command: MAIN_VIEW_COMMANDS.SHOW_LOGIN_BANNER },
    ]);
    assert.deepEqual(events, ['refreshAgentCatalog', 'loadOptions']);
  });

  it('can build startup messages from split option loaders', async () => {
    const events: string[] = [];
    const controller = new MainViewStartupController({
      getConfig: (_key, defaultValue) => defaultValue,
      refreshAgentCatalog: async () => {
        events.push('refreshAgentCatalog');
      },
      loadModelOptions: async () => {
        events.push('loadModelOptions');
        return [{ value: 'gemini', label: 'Gemini' }];
      },
      loadAgentOptions: async () => {
        events.push('loadAgentOptions');
        return {
          workflow: [{ value: 'correct', label: 'Correct' }],
        };
      },
      getAuthStatus: async () => ({ authenticated: true }),
    });

    assert.deepEqual(await controller.getOptionsAndLoginMessages(), [
      {
        command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
        optionsData: [{ value: 'gemini', label: 'Gemini' }],
      },
      {
        command: MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
        optionsData: {
          workflow: [{ value: 'correct', label: 'Correct' }],
        },
      },
      { command: MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER },
    ]);
    assert.deepEqual(events, [
      'refreshAgentCatalog',
      'loadModelOptions',
      'loadAgentOptions',
    ]);
  });

  it('hides the login banner for signed-in users', async () => {
    const controller = new MainViewStartupController({
      getConfig: (_key, defaultValue) => defaultValue,
      loadOptions: async () => ({ modelOptions: [], agentOptions: {} }),
      getAuthStatus: async () => ({ authenticated: true }),
    });

    const messages = await controller.getOptionsAndLoginMessages();

    assert.equal(
      messages.at(-1)?.command,
      MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER,
    );
  });

  it('builds the model-option refresh message without agent catalogue refresh', async () => {
    const events: string[] = [];
    const controller = new MainViewStartupController({
      getConfig: (_key, defaultValue) => defaultValue,
      loadOptions: async () => {
        throw new Error('full option load should not run');
      },
      loadModelOptions: async () => {
        events.push('loadModelOptions');
        return [{ value: 'gemini', label: 'Gemini' }];
      },
      refreshAgentCatalog: async () => {
        events.push('refreshAgentCatalog');
      },
      getAuthStatus: async () => ({ authenticated: true }),
    });

    assert.deepEqual(await controller.getModelOptionsRefreshMessage(), {
      command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
      optionsData: [{ value: 'gemini', label: 'Gemini' }],
    });
    assert.deepEqual(events, ['loadModelOptions']);
  });

  it('builds the agent-option refresh message after refreshing the catalogue', async () => {
    const events: string[] = [];
    const controller = new MainViewStartupController({
      getConfig: (_key, defaultValue) => defaultValue,
      loadOptions: async () => {
        throw new Error('full option load should not run');
      },
      loadAgentOptions: async () => {
        events.push('loadAgentOptions');
        return {
          workflow: [{ value: 'correct', label: 'Correct' }],
          toolUse: [{ value: 'review', label: 'Review' }],
        };
      },
      refreshAgentCatalog: async () => {
        events.push('refreshAgentCatalog');
      },
      getAuthStatus: async () => ({ authenticated: true }),
    });

    assert.deepEqual(await controller.getAgentOptionsRefreshMessage(), {
      command: MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
      optionsData: {
        workflow: [{ value: 'correct', label: 'Correct' }],
        toolUse: [{ value: 'review', label: 'Review' }],
      },
    });
    assert.deepEqual(events, ['refreshAgentCatalog', 'loadAgentOptions']);
  });

  it('builds all option refresh messages from one fresh option snapshot', async () => {
    const events: string[] = [];
    const controller = new MainViewStartupController({
      getConfig: (_key, defaultValue) => defaultValue,
      refreshAgentCatalog: async () => {
        events.push('refreshAgentCatalog');
      },
      loadOptions: async () => {
        events.push('loadOptions');
        return {
          modelOptions: [{ value: 'gemini', label: 'Gemini' }],
          agentOptions: {
            workflow: [{ value: 'correct', label: 'Correct' }],
          },
        };
      },
      getAuthStatus: async () => ({ authenticated: true }),
    });

    assert.deepEqual(await controller.getAllOptionsRefreshMessages(), [
      {
        command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
        optionsData: [{ value: 'gemini', label: 'Gemini' }],
      },
      {
        command: MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
        optionsData: {
          workflow: [{ value: 'correct', label: 'Correct' }],
        },
      },
    ]);
    assert.deepEqual(events, ['refreshAgentCatalog', 'loadOptions']);
  });
});
