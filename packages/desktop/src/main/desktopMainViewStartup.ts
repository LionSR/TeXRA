import { MAIN_VIEW_COMMANDS } from '@shared/ipc/mainViewCommands';

import {
  createCommandHandler,
  type DesktopMessageHandler,
  type DesktopRenderer,
} from './desktopIpcTypes.js';
import { createMainViewStartupController } from '@controllers/mainView/MainViewStartupControllerFactory';
import type { MainViewStartupOptions } from '@controllers/mainView/MainViewStartupController';
import type { MainViewAuthStatus } from '@controllers/mainView/MainViewTypes';

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
  const startupController = createMainViewStartupController({
    modelListRefresh,
    getAuthStatus,
    loadOptions,
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
