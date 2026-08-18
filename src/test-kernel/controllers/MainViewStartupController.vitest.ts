import { describe, expect, it } from 'vitest';

import {
  MainViewStartupController,
  type MainViewStartupControllerDeps,
  type MainViewStartupOptions,
} from '@controllers/mainView/MainViewStartupController';
import type { StateStore } from '@platform/interfaces';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import { GlobalStateKey } from '@shared/state/stateKeys';

function createStateStore(values: Record<string, unknown> = {}): StateStore {
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
    },
  ],
};

function createController(
  overrides: Partial<MainViewStartupControllerDeps> = {},
): MainViewStartupController {
  return new MainViewStartupController({
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
  it('shows the orchestrator banner by default', () => {
    expect(createController().getOrchestratorBannerMessage()).toStrictEqual({
      command: MAIN_VIEW_COMMANDS.SET_BANNER,
      banner: 'orchestrator',
      visible: true,
    });
  });

  it('hides the orchestrator banner when dismissed in global state', () => {
    const controller = createController({
      globalState: createStateStore({
        [GlobalStateKey.ORCHESTRATOR_BANNER_DISMISSED]: true,
      }),
    });

    expect(controller.getOrchestratorBannerMessage()).toStrictEqual({
      command: MAIN_VIEW_COMMANDS.SET_BANNER,
      banner: 'orchestrator',
      visible: false,
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
      { command: MAIN_VIEW_COMMANDS.SET_BANNER, banner: 'login', visible: true },
    ]);
  });

  it('hides the login banner for signed-in users', async () => {
    const controller = createController({
      getAuthStatus: async () => ({ authenticated: true }),
    });

    const messages = await controller.getOptionsAndLoginMessages();

    expect(messages.at(-1)).toStrictEqual({
      command: MAIN_VIEW_COMMANDS.SET_BANNER,
      banner: 'login',
      visible: false,
    });
  });
});
