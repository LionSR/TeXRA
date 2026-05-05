import { MainViewStartupController } from '@controllers/mainView/MainViewStartupController';
import { computeAgentOptionsData } from '@agent/index/agentRegistry';
import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';
import { buildBasicModelOptionsData } from '@model/modelOptionsBasic';
import { getConfig } from '@utils/config/configUtils';

import {
  createDesktopErrorReporter,
  type DesktopCommandMessage,
  type DesktopMessageHandler,
  type DesktopRenderer,
} from './desktopIpcTypes.js';

export interface DesktopMainViewStartupOptions {
  renderer: DesktopRenderer;
  onAsyncError?: (error: unknown) => void;
}

export function createDesktopMainViewStartup({
  renderer,
  onAsyncError,
}: DesktopMainViewStartupOptions): DesktopMessageHandler {
  const reportAsyncError = createDesktopErrorReporter(onAsyncError);
  const startupController = new MainViewStartupController({
    getConfig,
    loadOptions: async () => ({
      agentOptions: await computeAgentOptionsData(),
      modelOptions: buildBasicModelOptionsData(),
    }),
    getAuthStatus: async () => ({ authenticated: false }),
  });

  async function postStartupMessages(): Promise<void> {
    renderer.postToRenderer(startupController.getOrchestratorBannerMessage());
    const messages = await startupController.getOptionsAndLoginMessages();
    for (const message of messages) {
      renderer.postToRenderer(message);
    }
  }

  return {
    handleMessage(message: DesktopCommandMessage): boolean {
      if (
        message.command !== MAIN_VIEW_COMMANDS.WEBVIEW_READY ||
        message.view !== 'main'
      ) {
        return false;
      }

      void postStartupMessages().catch(reportAsyncError);
      return false;
    },
  };
}
