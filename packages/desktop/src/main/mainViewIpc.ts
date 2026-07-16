import type { MainViewExecuteMessage } from '@shared/mainView';
import { installDesktopHostBridge } from './hostBridge.js';
import { createDesktopExecutionIpc } from './desktopExecutionIpc.js';
import {
  createDesktopLogIpc,
  type DesktopLogIpcOptions,
} from './desktopLogIpc.js';
import { createDesktopMainViewStartup } from './desktopMainViewStartup.js';
import {
  isDesktopCommandMessage,
  type DesktopMessageHandler,
} from './desktopIpcTypes.js';
import {
  createDesktopShellIpc,
  type DesktopShellActions,
} from './desktopShellIpc.js';
import {
  createDesktopViewStateIpc,
  type DesktopTheme,
} from './desktopViewStateIpc.js';
import type {
  BrowserWindow,
  Event as ElectronEvent,
  WebContentsDidStartNavigationEventParams,
} from 'electron';
import type { DesktopProgressIpc } from './desktopProgressIpc.js';
import type { DesktopSettingsIpc } from './desktopSettingsIpc.js';
import type { DesktopFileSelection } from './desktopFileSelection.js';
import type { DesktopPromptIpc } from './desktopPromptIpc.js';
import type { MainViewAuthStatus } from '@controllers/mainView/MainViewTypes';
import type { MainViewStartupOptions } from '@controllers/mainView/MainViewStartupController';

export interface DesktopMainViewIpcOptions {
  debugMode?: boolean;
  getTheme?: () => DesktopTheme;
  fileSelection: DesktopFileSelection;
  settings: DesktopSettingsIpc;
  progress: DesktopProgressIpc;
  prompt: DesktopPromptIpc;
  onboarding: DesktopMessageHandler;
  logs: DesktopLogIpcOptions;
  shellActions: DesktopShellActions;
  modelListRefresh?: PromiseLike<void>;
  getAuthStatus?: () => Promise<MainViewAuthStatus>;
  loadStartupOptions?: () => Promise<MainViewStartupOptions>;
  executeAgent(message: MainViewExecuteMessage): Promise<void>;
  onAsyncError?: (error: unknown) => void;
}

export interface DesktopMainViewIpc {
  postToRenderer(message: unknown): void;
  dispose(): void;
}

export function installDesktopMainViewIpc(
  window: BrowserWindow,
  options: DesktopMainViewIpcOptions,
): DesktopMainViewIpc {
  let disposed = false;
  let messageHandlers: DesktopMessageHandler[] = [];
  const webContents = window.webContents;

  function handleRendererMessage(message: unknown) {
    if (!isDesktopCommandMessage(message)) return;
    for (const handler of messageHandlers) {
      if (handler.handleMessage(message)) return;
    }
  }

  const bridge = installDesktopHostBridge(window, {
    onRendererMessage: handleRendererMessage,
  });
  const viewState = createDesktopViewStateIpc(bridge, {
    debugMode: options.debugMode,
    getTheme: options.getTheme,
  });
  const shell = createDesktopShellIpc(options.shellActions);
  const execution = createDesktopExecutionIpc({
    executeAgent: options.executeAgent,
    onAsyncError: options.onAsyncError,
  });
  const logs = createDesktopLogIpc(bridge, {
    ...options.logs,
    onAsyncError: options.onAsyncError,
  });
  const startup = createDesktopMainViewStartup({
    renderer: bridge,
    modelListRefresh: options.modelListRefresh,
    getAuthStatus: options.getAuthStatus,
    loadOptions: options.loadStartupOptions,
    onAsyncError: options.onAsyncError,
  });
  messageHandlers = [
    startup,
    options.fileSelection,
    options.settings,
    options.progress,
    options.prompt,
    options.onboarding,
    viewState,
    logs,
    shell,
    execution,
  ];
  const cancelPromptsAfterRendererExit = () => options.prompt.cancelPending();
  const cancelPromptsBeforeMainFrameNavigation = (
    event: ElectronEvent<WebContentsDidStartNavigationEventParams>,
  ) => {
    if (event.isMainFrame && !event.isSameDocument) {
      options.prompt.cancelPending();
    }
  };
  webContents.on('render-process-gone', cancelPromptsAfterRendererExit);
  webContents.on(
    'did-start-navigation',
    cancelPromptsBeforeMainFrameNavigation,
  );

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    viewState.dispose();
    webContents.off('render-process-gone', cancelPromptsAfterRendererExit);
    webContents.off(
      'did-start-navigation',
      cancelPromptsBeforeMainFrameNavigation,
    );
    options.prompt.dispose();
    bridge.dispose();
  }
  window.once('closed', dispose);

  return {
    postToRenderer: (message) => bridge.postToRenderer(message),
    dispose,
  };
}
