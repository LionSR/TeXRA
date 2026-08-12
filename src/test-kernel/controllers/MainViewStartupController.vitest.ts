import { describe, expect, it } from 'vitest';

import {
  MainViewStartupController,
  type MainViewStartupControllerDeps,
  type MainViewStartupOptions,
} from '@controllers/mainView/MainViewStartupController';
import type { StateStore } from '@platform/interfaces';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import { GlobalStateKey } from '@shared/state/stateKeys';

function createStateStore(
  values: Record<string, unknown> = {},
): StateStore {
  return {
    get: <T>(key: string, defaultValue?: T) =>
      (values[key] as T | undefined) ?? (defaultValue as T),
    update: async () => undefined,
  };
}

const STARTUP_OPTIONS: MainViewStartupOptions = {
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
};

function createController(
  overrides: Partial<MainViewStartupControllerDeps> = {},
): MainViewStartupController {
  return new MainViewStartupController({
    getConfig: (_key, defaultValue) => defaultValue,
    loadOptions: async () => ({
      modelOptionsByCategory: { workflow: [], toolUse: [] },
      agentOptions: {},
      teamOptions: [],
    }),
    getAuthStatus: async () => ({ authenticated: false }),
    globalState: createStateStore(),
    ...overrides,
  });
}

describe('MainViewStartupController', () => {
  it('uses config to choose the orchestrator banner message', () => {
    expect(createController().getOrchestratorBannerMessage()).toStrictEqual({
      command: MAIN_VIEW_COMMANDS.SHOW_ORCHESTRATOR_BANNER,
    });
  });

  it('hides the orchestrator banner when disabled', () => {
    const controller = createController({ getConfig: <T>() => false as T });

    expect(controller.getOrchestratorBannerMessage()).toStrictEqual({
      command: MAIN_VIEW_COMMANDS.HIDE_ORCHESTRATOR_BANNER,
    });
  });

  it('hides the orchestrator banner when dismissed in global state', () => {
    const controller = createController({
      globalState: createStateStore({
        [GlobalStateKey.ORCHESTRATOR_BANNER_DISMISSED]: true,
      }),
    });

    expect(controller.getOrchestratorBannerMessage()).toStrictEqual({
      command: MAIN_VIEW_COMMANDS.HIDE_ORCHESTRATOR_BANNER,
    });
  });

  it('loads options and shows the login banner for signed-out users', async () => {
    const controller = createController({
      loadOptions: async () => STARTUP_OPTIONS,
    });

    expect(await controller.getOptionsAndLoginMessages()).toStrictEqual([
      {
        command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
        optionsDataByCategory: STARTUP_OPTIONS.modelOptionsByCategory,
      },
      {
        command: MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
        optionsData: STARTUP_OPTIONS.agentOptions,
      },
      {
        command: MAIN_VIEW_COMMANDS.SET_TEAM_OPTIONS,
        optionsData: STARTUP_OPTIONS.teamOptions,
      },
      { command: MAIN_VIEW_COMMANDS.SHOW_LOGIN_BANNER },
    ]);
  });

  it('hides the login banner for signed-in users', async () => {
    const controller = createController({
      getAuthStatus: async () => ({ authenticated: true }),
    });

    const messages = await controller.getOptionsAndLoginMessages();

    expect(messages.at(-1)?.command).toBe(MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER);
  });
});
