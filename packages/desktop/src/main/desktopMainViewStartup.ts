import { computeAgentOptionsData } from '@agent/index';
import type { StateStore } from '@platform/interfaces';
import { loadTeamOptions } from '@common/teams/TeamPlan';
import {
  MainViewStartupController,
  type MainViewAuthStatus,
  type MainViewStartupOptions,
} from '@controllers/mainView/MainViewStartupController';
import { createTeamCatalogPorts } from '@controllers/mainView/teamCatalogPorts';
import { computeModelOptionsData } from '@model/computeModelOptions';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import { getConfig } from '@utils/config/configUtils';

import {
  createCommandHandler,
  type DesktopMessageHandler,
  type DesktopRenderer,
} from './desktopIpcTypes.js';

async function defaultGetAuthStatus(): Promise<MainViewAuthStatus> {
  return { authenticated: false };
}

export interface DesktopMainViewStartupOptions {
  renderer: DesktopRenderer;
  getAuthStatus?: () => Promise<MainViewAuthStatus>;
  loadOptions?: () => Promise<MainViewStartupOptions>;
  onAsyncError?: (error: unknown) => void;
  globalState: StateStore;
}

export function createDesktopMainViewStartup({
  renderer,
  getAuthStatus,
  loadOptions,
  onAsyncError,
  globalState,
}: DesktopMainViewStartupOptions): DesktopMessageHandler {
  const startupController = new MainViewStartupController({
    getConfig,
    loadOptions: async () => {
      if (loadOptions != null) return loadOptions();
      const [agentOptions, teamOptions, modelOptions] = await Promise.all([
        computeAgentOptionsData(),
        loadTeamOptions(createTeamCatalogPorts()),
        computeModelOptionsData(),
      ]);
      return {
        agentOptions,
        teamOptions,
        modelOptionsByCategory: {
          workflow: modelOptions,
          toolUse: modelOptions,
        },
      };
    },
    getAuthStatus: getAuthStatus ?? defaultGetAuthStatus,
    globalState,
  });

  async function postStartupMessages(): Promise<void> {
    renderer.postToRenderer(startupController.getOrchestratorBannerMessage());
    const messages = await startupController.getOptionsAndLoginMessages();
    for (const message of messages) {
      renderer.postToRenderer(message);
    }
  }

  return createCommandHandler(
    {
      // WEBVIEW_READY is a broadcast: post startup messages for the main view
      // but return `false` so sibling handlers still receive it.
      [MAIN_VIEW_COMMANDS.WEBVIEW_READY]: {
        when: (message) => message.view === 'main',
        run: () => postStartupMessages(),
        claim: false,
      },
    },
    { onAsyncError },
  );
}
