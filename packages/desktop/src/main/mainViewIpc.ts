import type {
  MainViewAuthStatus,
  MainViewStartupOptions,
} from '@controllers/mainView/MainViewStartupController';
import type { StateStore } from '@platform/interfaces';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type { MainViewExecuteMessage } from '@shared/schemas';
import { installDesktopHostBridge } from './hostBridge.js';
import { createDesktopExecutionIpc } from './desktopExecutionIpc.js';
import {
  createDesktopLogIpc,
  type DesktopLogIpcOptions,
} from './desktopLogIpc.js';
import { createDesktopMainViewStartup } from './desktopMainViewStartup.js';
import {
  createCommandHandler,
  isDesktopCommandMessage,
  type DesktopCommandMessage,
  type DesktopMessageHandler,
} from './desktopIpcTypes.js';
import {
  createDesktopShellIpc,
  type DesktopShellActions,
} from './desktopShellIpc.js';
import { createDesktopViewStateIpc } from './desktopViewStateIpc.js';
import type { BrowserWindow } from 'electron';
import type { DesktopPromptIpc } from './desktopPromptController.js';
import type { DesktopFileSelection } from './desktopFileSelection.js';

interface DesktopMainViewIpcOptions {
  fileSelection: DesktopFileSelection;
  prompt: DesktopPromptIpc;
  /** The paper-scoped settings surface, reached through the window's current one. */
  settings: DesktopMessageHandler;
  progress: DesktopMessageHandler;
  onboarding: DesktopMessageHandler;
  /** Open-paper selection and the papers list the main view needs once ready. */
  papers?: DesktopMessageHandler;
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
  /**
   * Runs every renderer message dispatch inside the active paper's session
   * scope, so session-rooted services resolve to the paper the window shows.
   */
  inActiveSession?: (dispatch: () => void) => void;
  onAsyncError?: (error: unknown) => void;
}

interface DesktopMainViewIpc {
  postToRenderer(message: unknown): void;
  dispose(): void;
}

export function installDesktopMainViewIpc(
  window: BrowserWindow,
  options: DesktopMainViewIpcOptions,
): DesktopMainViewIpc {
  let disposed = false;

  function dispatchRendererMessage(message: DesktopCommandMessage): void {
    for (const handler of messageHandlers) {
      if (handler.handleMessage(message)) return;
    }
  }

  function handleRendererMessage(message: unknown): void {
    if (!isDesktopCommandMessage(message)) return;
    const dispatch = () => dispatchRendererMessage(message);
    if (options.inActiveSession) options.inActiveSession(dispatch);
    else dispatch();
  }

  const bridge = installDesktopHostBridge(window, {
    onRendererMessage: handleRendererMessage,
  });
  const banner = createCommandHandler({
    // Banner state is frontend-owned, so renderer updates round-trip through
    // the host just as they do in the extension.
    [MAIN_VIEW_COMMANDS.SET_BANNER]: bridge.postToRenderer,
  });
  const viewState = createDesktopViewStateIpc(bridge);
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
    banner,
    startup,
    options.fileSelection,
    options.prompt,
    options.settings,
    options.progress,
    options.onboarding,
    // Filtered because these are optional; an undefined entry in the chain
    // would throw on the first message dispatched.
    ...(options.papers ? [options.papers] : []),
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
    postToRenderer: bridge.postToRenderer,
    dispose,
  };
}
