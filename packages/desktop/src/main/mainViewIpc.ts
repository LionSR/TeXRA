import { installDesktopHostBridge } from './hostBridge.js';
import { createDesktopExecutionIpc } from './desktopExecutionIpc.js';
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
import type { DesktopProgressIpc } from './desktopProgressIpc.js';
import type { DesktopSettingsIpc } from './desktopSettingsIpc.js';
import type { DesktopFileSelection } from './desktopFileSelection.js';
import type { MainViewExecuteMessage } from '@controllers/mainView/MainViewExecutionController';
import type { BrowserWindow } from 'electron';

export interface DesktopMainViewIpcOptions {
  debugMode?: boolean;
  getTheme?: () => DesktopTheme;
  getCustomAgentDirectory?: () => Promise<string>;
  openPath?: (filePath: string) => Promise<void>;
  fileSelection?: DesktopFileSelection;
  settings?: DesktopSettingsIpc;
  progress?: DesktopProgressIpc;
  shellActions?: DesktopShellActions;
  executeAgent?: (message: MainViewExecuteMessage) => Promise<void>;
  onAsyncError?: (error: unknown) => void;
}

export interface DesktopMainViewIpc {
  postToRenderer(message: unknown): void;
  dispose(): void;
}

export function installDesktopMainViewIpc(
  window: BrowserWindow,
  options: DesktopMainViewIpcOptions = {},
): DesktopMainViewIpc {
  let disposed = false;
  let messageHandlers: DesktopMessageHandler[] = [];

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
  const shell = createDesktopShellIpc(bridge, {
    actions: options.shellActions,
    getCustomAgentDirectory: options.getCustomAgentDirectory,
    openPath: options.openPath,
    onAsyncError: options.onAsyncError,
  });
  const execution = createDesktopExecutionIpc({
    executeAgent: options.executeAgent,
    onAsyncError: options.onAsyncError,
  });
  const startup = createDesktopMainViewStartup({
    renderer: bridge,
    onAsyncError: options.onAsyncError,
  });
  messageHandlers = [
    startup,
    options.fileSelection,
    options.settings,
    options.progress,
    viewState,
    shell,
    execution,
  ].filter((handler): handler is DesktopMessageHandler => handler != null);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    viewState.dispose();
    bridge.dispose();
  };
  window.once('closed', dispose);

  return {
    postToRenderer: (message) => bridge.postToRenderer(message),
    dispose,
  };
}
