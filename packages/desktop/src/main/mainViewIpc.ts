import type {
  MainViewAuthStatus,
  MainViewStartupOptions,
} from '@controllers/mainView/MainViewStartupController';
import type { StateStore } from '@platform/interfaces';
import type { DesktopThemeKind } from '@shared/schemas';
import type { MainViewExecuteMessage } from '@shared/schemas/mainView/executeMessage';
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
import { createDesktopViewStateIpc } from './desktopViewStateIpc.js';
import type { BrowserWindow } from 'electron';
import type { DesktopProgressIpc } from './desktopProgressIpc.js';
import type { DesktopPromptIpc } from './desktopPromptController.js';
import type { DesktopSettingsIpc } from './desktopSettingsIpc.js';
import type { DesktopFileSelection } from './desktopFileSelection.js';

export interface DesktopMainViewIpcOptions {
  debugMode?: boolean;
  getTheme?: () => DesktopThemeKind;
  fileSelection: DesktopFileSelection;
  prompt: DesktopPromptIpc;
  settings: DesktopSettingsIpc;
  progress: DesktopProgressIpc;
  onboarding: DesktopMessageHandler;
  /**
   * Editor file I/O, terminal pty sessions, and embedded browser control.
   * Owned by the caller because the pty host and browser views outlive a single
   * IPC install and need window-level disposal.
   *
   * Optional: these surfaces are additive, and a harness exercising only the
   * main-view message flow shouldn't have to stand up a pty host and a
   * WebContentsView factory to do it.
   */
  workspace?: DesktopMessageHandler;
  logs: DesktopLogIpcOptions;
  shellActions: DesktopShellActions;
  getAuthStatus?: () => Promise<MainViewAuthStatus>;
  loadStartupOptions?: () => Promise<MainViewStartupOptions>;
  handleExecuteMessage(message: MainViewExecuteMessage): Promise<void>;
  /** Main-process global store, threaded in by the caller (windows outlive a
   *  single platform init in some hosts). */
  globalState: StateStore;
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

  function handleRendererMessage(message: unknown): void {
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
    handleExecuteMessage: options.handleExecuteMessage,
    onAsyncError: options.onAsyncError,
  });
  const logs = createDesktopLogIpc(bridge, {
    ...options.logs,
    onAsyncError: options.onAsyncError,
  });
  const startup = createDesktopMainViewStartup({
    renderer: bridge,
    getAuthStatus: options.getAuthStatus,
    loadOptions: options.loadStartupOptions,
    onAsyncError: options.onAsyncError,
    globalState: options.globalState,
  });
  const messageHandlers: DesktopMessageHandler[] = [
    startup,
    options.fileSelection,
    options.prompt,
    options.settings,
    options.progress,
    options.onboarding,
    // Filtered because `workspace` is optional; an undefined entry in the chain
    // would throw on the first message dispatched.
    ...(options.workspace ? [options.workspace] : []),
    viewState,
    logs,
    shell,
    execution,
  ];

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    viewState.dispose();
    options.prompt.dispose();
    bridge.dispose();
  }
  window.once('closed', dispose);

  return {
    postToRenderer: (message) => bridge.postToRenderer(message),
    dispose,
  };
}
