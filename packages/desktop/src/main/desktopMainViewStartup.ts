import {
  MainViewStartupController,
  type MainViewStartupOptions,
} from '@controllers/mainView/MainViewStartupController';
import { computeAgentOptionsData } from '@agent/index/agentRegistry';
import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';
import { computeModelOptionsData } from '@model/computeModelOptions';
import { getConfig } from '@utils/config/configUtils';

import {
  createCommandHandler,
  type DesktopMessageHandler,
  type DesktopRenderer,
} from './desktopIpcTypes.js';
import type { MainViewAuthStatus } from '@controllers/mainView/MainViewTypes';

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
      const [agentOptions, modelOptions] = await Promise.all([
        computeAgentOptionsData(),
        computeModelOptionsData(),
      ]);
      return { agentOptions, modelOptions };
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
