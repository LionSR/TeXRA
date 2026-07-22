import { computeAgentOptionsData } from '@agent/index';
import { loadTeamOptions } from '@common/teams/TeamPlan';
import {
  MainViewStartupController,
  type MainViewStartupOptions,
} from '@controllers/mainView/MainViewStartupController';
import type { MainViewAuthStatus } from '@controllers/mainView/MainViewTypes';
import { createTeamCatalogPorts } from '@controllers/mainView/teamCatalogPorts';
import { computeModelOptionsData } from '@model/computeModelOptions';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import { AgentCategory } from '@shared/schemas/agent';
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
  modelListRefresh?: PromiseLike<void>;
  getAuthStatus?: () => Promise<MainViewAuthStatus>;
  loadOptions?: () => Promise<MainViewStartupOptions>;
  onAsyncError?: (error: unknown) => void;
}

export function createDesktopMainViewStartup({
  renderer,
  modelListRefresh,
  getAuthStatus,
  loadOptions,
  onAsyncError,
}: DesktopMainViewStartupOptions): DesktopMessageHandler {
  const startupController = new MainViewStartupController({
    getConfig,
    loadOptions: async () => {
      await modelListRefresh;
      if (loadOptions != null) return loadOptions();
      const [
        agentOptions,
        teamOptions,
        workflowModelOptions,
        toolUseModelOptions,
      ] = await Promise.all([
        computeAgentOptionsData(),
        loadTeamOptions(createTeamCatalogPorts()),
        computeModelOptionsData(undefined, undefined, {
          agentCategory: AgentCategory.Workflow,
        }),
        computeModelOptionsData(undefined, undefined, {
          agentCategory: AgentCategory.ToolUse,
        }),
      ]);
      return {
        agentOptions,
        teamOptions,
        modelOptions: workflowModelOptions,
        modelOptionsByCategory: {
          workflow: workflowModelOptions,
          toolUse: toolUseModelOptions,
        },
      };
    },
    getAuthStatus: getAuthStatus ?? defaultGetAuthStatus,
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
