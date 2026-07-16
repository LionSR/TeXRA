// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - webview command constants
import {
  COMMON_COMMANDS,
  MAIN_VIEW_COMMANDS,
  PROGRESS_VIEW_COMMANDS,
  SETTINGS_VIEW_COMMANDS,
} from '@shared/ipc';
import { AgentCategory } from '@shared/schemas/agent';
import { SETTINGS_TAB } from '@shared/schemas/settingsViewMessages';

// Local imports - desktop test paths
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

interface TestDesktopShellActions {
  showRoute: ReturnType<typeof vi.fn>;
  showSettings: ReturnType<typeof vi.fn>;
  signIn: ReturnType<typeof vi.fn>;
  openAgentDirectory: ReturnType<typeof vi.fn>;
  openDesktopDocs: ReturnType<typeof vi.fn>;
  openLogFolder: ReturnType<typeof vi.fn>;
  openWorkspaceFolder: ReturnType<typeof vi.fn>;
  openWorkspaceInNewWindow: ReturnType<typeof vi.fn>;
  resetMainView: ReturnType<typeof vi.fn>;
  showFirstRunWalkthrough: ReturnType<typeof vi.fn>;
  sendRecentCommits: ReturnType<typeof vi.fn>;
  showInfoMessage: ReturnType<typeof vi.fn>;
}

interface MainViewIpcModule {
  installDesktopMainViewIpc(
    window: {
      isDestroyed(): boolean;
      once(event: 'closed', listener: () => void): void;
      webContents: {
        isDestroyed(): boolean;
        send(channel: string, message: unknown): void;
        on(event: string, listener: (...args: never[]) => void): void;
        off(event: string, listener: (...args: never[]) => void): void;
      };
    },
    options: {
      debugMode?: boolean;
      getTheme?: () => 'dark' | 'light' | 'high-contrast';
      fileSelection: { handleMessage(message: { command: string }): boolean };
      settings: { handleMessage(message: { command: string }): boolean };
      progress: { handleMessage(message: { command: string }): boolean };
      prompt: {
        handleMessage(message: { command: string }): boolean;
        cancelPending(): void;
        dispose(): void;
      };
      onboarding: { handleMessage(message: { command: string }): boolean };
      shellActions: TestDesktopShellActions;
      modelListRefresh?: PromiseLike<void>;
      getAuthStatus?: () => Promise<{ authenticated: boolean }>;
      loadStartupOptions?: () => Promise<{
        agentOptions: { workflow: unknown[]; toolUse: unknown[] };
        modelOptions: unknown[];
      }>;
      logs: {
        readLog(): {
          path: string | undefined;
          text: string;
          truncated: boolean;
        };
        copyLog(text: string): Promise<void>;
        exportLog(text: string): Promise<void>;
      };
      executeAgent(message: unknown): Promise<void>;
      onAsyncError?: (error: unknown) => void;
    },
  ): {
    postToRenderer(message: unknown): void;
    dispose(): void;
  };
}

interface HostBridgeModule {
  ELECTRON_WEBVIEW_MESSAGE_CHANNEL: string;
  ELECTRON_WEBVIEW_PUSH_CHANNEL: string;
}

async function loadDesktopMainViewIpcModule(electron: {
  ipcMain: {
    on(
      channel: string,
      listener: (event: { sender: unknown }, message: unknown) => void,
    ): void;
    off(
      channel: string,
      listener: (event: { sender: unknown }, message: unknown) => void,
    ): void;
  };
  nativeTheme: {
    shouldUseDarkColors: boolean;
    shouldUseHighContrastColors: boolean;
    on(event: 'updated', listener: () => void): void;
    off(event: 'updated', listener: () => void): void;
  };
}): Promise<MainViewIpcModule & HostBridgeModule> {
  vi.resetModules();
  vi.doMock('electron', () => electron);
  const hostBridge = (await import(
    moduleFileUrl(desktopSourcePath('hostBridgeChannels.ts'))
  )) as HostBridgeModule;
  const mainViewIpc = (await import(
    moduleFileUrl(desktopSourcePath('main', 'mainViewIpc.ts'))
  )) as MainViewIpcModule;
  return { ...mainViewIpc, ...hostBridge };
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) =>
    setImmediate(() => setImmediate(() => resolve())),
  );
}

function createDeferred(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type RendererListener = (event: { sender: unknown }, message: unknown) => void;

function createIpcMainMock(onMessage: (listener: RendererListener) => void) {
  return {
    on: vi.fn((_channel: string, listener: RendererListener) => {
      onMessage(listener);
    }),
    off: vi.fn(),
  };
}

function createNativeThemeMock(
  options: {
    shouldUseDarkColors?: boolean;
    shouldUseHighContrastColors?: boolean;
    onUpdated?: (listener: () => void) => void;
  } = {},
) {
  return {
    shouldUseDarkColors: options.shouldUseDarkColors ?? false,
    shouldUseHighContrastColors: options.shouldUseHighContrastColors ?? false,
    on: vi.fn((_event: 'updated', listener: () => void) => {
      options.onUpdated?.(listener);
    }),
    off: vi.fn(),
  };
}

function createWindowMock(
  sends: Array<{ channel: string; message: unknown }>,
  onClosed?: (listener: () => void) => void,
) {
  const webContents = {
    isDestroyed: () => false,
    send: vi.fn((channel: string, message: unknown) =>
      sends.push({ channel, message }),
    ),
    on: vi.fn(),
    off: vi.fn(),
  };
  const window = {
    isDestroyed: () => false,
    once: vi.fn((_event: 'closed', listener: () => void) => {
      onClosed?.(listener);
    }),
    webContents,
  };
  return { window, webContents };
}

function createMainViewShellActions(): TestDesktopShellActions {
  return {
    showRoute: vi.fn(),
    showSettings: vi.fn(),
    signIn: vi.fn(),
    openAgentDirectory: vi.fn(),
    openDesktopDocs: vi.fn(),
    openLogFolder: vi.fn(),
    openWorkspaceFolder: vi.fn(),
    openWorkspaceInNewWindow: vi.fn(),
    resetMainView: vi.fn(),
    showFirstRunWalkthrough: vi.fn(),
    sendRecentCommits: vi.fn(),
    showInfoMessage: vi.fn(),
  };
}

function createMainViewCommandCapabilities() {
  const createUnhandledCapability = () => ({
    handleMessage: vi.fn(() => false),
  });
  return {
    executeAgent: vi.fn(async (_message: unknown) => {}),
    fileSelection: createUnhandledCapability(),
    settings: createUnhandledCapability(),
    progress: createUnhandledCapability(),
    prompt: {
      ...createUnhandledCapability(),
      cancelPending: vi.fn(),
      dispose: vi.fn(),
    },
    onboarding: createUnhandledCapability(),
    logs: {
      readLog: () => ({ path: undefined, text: '', truncated: false }),
      copyLog: vi.fn(async (_text: string) => {}),
      exportLog: vi.fn(async (_text: string) => {}),
    },
    shellActions: createMainViewShellActions(),
  };
}

describe('desktop main-view IPC', () => {
  afterEach(() => {
    vi.doUnmock('electron');
    vi.doUnmock('@agent/index/agentRegistry');
    vi.doUnmock('@model/computeModelOptions');
    vi.doUnmock('@model/modelOptionsBasic');
  });

  it('pushes theme and debug state over the fixed host bridge channel', async () => {
    let rendererListener: RendererListener | undefined;
    let themeListener: (() => void) | undefined;
    const ipcMain = createIpcMainMock((listener) => {
      rendererListener = listener;
    });
    const nativeTheme = createNativeThemeMock({
      shouldUseDarkColors: true,
      onUpdated: (listener) => {
        themeListener = listener;
      },
    });
    const {
      ELECTRON_WEBVIEW_MESSAGE_CHANNEL,
      ELECTRON_WEBVIEW_PUSH_CHANNEL,
      installDesktopMainViewIpc,
    } = await loadDesktopMainViewIpcModule({ ipcMain, nativeTheme });
    const sends: Array<{ channel: string; message: unknown }> = [];
    const fileSelection = {
      handleMessage: vi.fn(
        (message: { command: string }) =>
          message.command === MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE,
      ),
    };
    const settings = {
      handleMessage: vi.fn(
        (message: { command: string }) =>
          message.command === SETTINGS_VIEW_COMMANDS.SET_GIT_AUTHOR_NAME,
      ),
    };
    const progress = {
      handleMessage: vi.fn(
        (message: { command: string }) =>
          message.command === PROGRESS_VIEW_COMMANDS.SWITCH_STREAM,
      ),
    };
    const executeAgent = vi.fn(async (_message: unknown) => {});
    const closedListeners: Array<() => void> = [];
    const { window, webContents } = createWindowMock(sends, (listener) => {
      closedListeners.push(listener);
    });

    const capabilities = createMainViewCommandCapabilities();
    const ipc = installDesktopMainViewIpc(window, {
      ...capabilities,
      debugMode: true,
      fileSelection,
      settings,
      progress,
      executeAgent,
    });

    expect(ipcMain.on).toHaveBeenCalledWith(
      ELECTRON_WEBVIEW_MESSAGE_CHANNEL,
      rendererListener,
    );
    rendererListener?.(
      { sender: {} },
      { command: MAIN_VIEW_COMMANDS.GET_THEME },
    );
    expect(sends).toEqual([]);

    rendererListener?.(
      { sender: webContents },
      { command: MAIN_VIEW_COMMANDS.WEBVIEW_READY, view: 'progress' },
    );
    expect(sends).toEqual([]);

    rendererListener?.(
      { sender: webContents },
      { command: MAIN_VIEW_COMMANDS.WEBVIEW_READY, view: 'main' },
    );
    // Filter to the theme/debug-mode pushes: WEBVIEW_READY(view:'main') is a
    // broadcast, so sibling handlers (e.g. main-view startup) also react.
    expect(
      sends.filter(({ message }) =>
        [COMMON_COMMANDS.THEME_SET, COMMON_COMMANDS.DEBUG_MODE_SET].includes(
          (message as { command?: string }).command as never,
        ),
      ),
    ).toEqual([
      {
        channel: ELECTRON_WEBVIEW_PUSH_CHANNEL,
        message: { command: COMMON_COMMANDS.THEME_SET, theme: 'dark' },
      },
      {
        channel: ELECTRON_WEBVIEW_PUSH_CHANNEL,
        message: { command: COMMON_COMMANDS.DEBUG_MODE_SET, debugMode: true },
      },
    ]);

    rendererListener?.(
      { sender: webContents },
      { command: MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE },
    );
    expect(fileSelection.handleMessage).toHaveBeenCalledWith({
      command: MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE,
    });

    rendererListener?.(
      { sender: webContents },
      {
        command: SETTINGS_VIEW_COMMANDS.SET_GIT_AUTHOR_NAME,
        name: 'TeXRA Bot',
      },
    );
    expect(settings.handleMessage).toHaveBeenCalledWith({
      command: SETTINGS_VIEW_COMMANDS.SET_GIT_AUTHOR_NAME,
      name: 'TeXRA Bot',
    });

    rendererListener?.(
      { sender: webContents },
      { command: PROGRESS_VIEW_COMMANDS.SWITCH_STREAM, stream: 'run-1' },
    );
    expect(progress.handleMessage).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.SWITCH_STREAM,
      stream: 'run-1',
    });

    sends.length = 0;
    rendererListener?.(
      { sender: webContents },
      { command: MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS },
    );
    expect(capabilities.shellActions.sendRecentCommits).toHaveBeenCalledOnce();
    expect(sends).toEqual([]);

    sends.length = 0;
    nativeTheme.shouldUseDarkColors = false;
    rendererListener?.(
      { sender: webContents },
      { command: MAIN_VIEW_COMMANDS.GET_THEME },
    );
    expect(sends).toEqual([
      {
        channel: ELECTRON_WEBVIEW_PUSH_CHANNEL,
        message: { command: COMMON_COMMANDS.THEME_SET, theme: 'light' },
      },
    ]);

    sends.length = 0;
    rendererListener?.(
      { sender: webContents },
      { command: MAIN_VIEW_COMMANDS.GET_DEBUG_MODE },
    );
    expect(sends).toEqual([
      {
        channel: ELECTRON_WEBVIEW_PUSH_CHANNEL,
        message: { command: COMMON_COMMANDS.DEBUG_MODE_SET, debugMode: true },
      },
    ]);

    sends.length = 0;
    rendererListener?.(
      { sender: webContents },
      { command: COMMON_COMMANDS.SWITCH_VIEW, view: 'progress' },
    );
    expect(capabilities.shellActions.showRoute).toHaveBeenCalledWith(
      'progress',
    );
    expect(sends).toEqual([]);

    sends.length = 0;
    rendererListener?.(
      { sender: webContents },
      { command: COMMON_COMMANDS.SWITCH_VIEW, view: 'dashboard' },
    );
    rendererListener?.(
      { sender: webContents },
      { command: MAIN_VIEW_COMMANDS.OPEN_MODEL_SETTINGS },
    );
    rendererListener?.(
      { sender: webContents },
      {
        command: MAIN_VIEW_COMMANDS.OPEN_AGENT_SETTINGS,
        sessionType: AgentCategory.ToolUse,
      },
    );
    rendererListener?.(
      { sender: webContents },
      { command: MAIN_VIEW_COMMANDS.OPEN_MULTI_AGENT_SETTINGS },
    );
    rendererListener?.(
      { sender: webContents },
      { command: MAIN_VIEW_COMMANDS.OPEN_AGENT_DIRECTORY },
    );
    expect(capabilities.shellActions.showRoute).toHaveBeenCalledWith(
      'settings',
    );
    expect(capabilities.shellActions.showSettings).toHaveBeenNthCalledWith(
      1,
      SETTINGS_TAB.MODELS,
    );
    expect(capabilities.shellActions.showSettings).toHaveBeenNthCalledWith(
      2,
      SETTINGS_TAB.AGENTS,
      AgentCategory.ToolUse,
    );
    expect(capabilities.shellActions.showSettings).toHaveBeenNthCalledWith(
      3,
      SETTINGS_TAB.MULTI_AGENT,
    );
    expect(capabilities.shellActions.openAgentDirectory).toHaveBeenCalledWith(
      false,
    );
    expect(sends).toEqual([]);

    sends.length = 0;
    rendererListener?.(
      { sender: webContents },
      { command: MAIN_VIEW_COMMANDS.OPEN_AGENT_DIRECTORY, customDirSet: true },
    );
    expect(capabilities.shellActions.openAgentDirectory).toHaveBeenCalledWith(
      true,
    );
    expect(sends).toEqual([]);

    const executeMessage = {
      command: MAIN_VIEW_COMMANDS.EXECUTE,
      agent: 'direct-agent',
      model: 'gpt-5.4',
    };
    rendererListener?.({ sender: webContents }, executeMessage);
    await Promise.resolve();
    expect(executeAgent).toHaveBeenCalledWith(executeMessage);

    nativeTheme.shouldUseHighContrastColors = true;
    themeListener?.();
    expect(sends.at(-1)).toEqual({
      channel: ELECTRON_WEBVIEW_PUSH_CHANNEL,
      message: {
        command: COMMON_COMMANDS.THEME_SET,
        theme: 'high-contrast',
      },
    });

    ipc.postToRenderer({ command: 'customPush' });
    expect(sends.at(-1)).toEqual({
      channel: ELECTRON_WEBVIEW_PUSH_CHANNEL,
      message: { command: 'customPush' },
    });

    const rendererGoneListener = webContents.on.mock.calls.find(
      ([event]) => event === 'render-process-gone',
    )?.[1] as (() => void) | undefined;
    const navigationListener = webContents.on.mock.calls.find(
      ([event]) => event === 'did-start-navigation',
    )?.[1] as
      | ((event: { isMainFrame: boolean; isSameDocument: boolean }) => void)
      | undefined;
    navigationListener?.({ isMainFrame: false, isSameDocument: false });
    navigationListener?.({ isMainFrame: true, isSameDocument: true });
    expect(capabilities.prompt.cancelPending).not.toHaveBeenCalled();
    navigationListener?.({ isMainFrame: true, isSameDocument: false });
    rendererGoneListener?.();
    expect(capabilities.prompt.cancelPending).toHaveBeenCalledTimes(2);

    ipc.dispose();
    expect(nativeTheme.off).toHaveBeenCalledWith('updated', themeListener);
    expect(ipcMain.off).toHaveBeenCalledTimes(1);
    expect(capabilities.prompt.dispose).toHaveBeenCalledOnce();
    expect(webContents.off).toHaveBeenCalledWith(
      'render-process-gone',
      expect.any(Function),
    );
    expect(webContents.off).toHaveBeenCalledWith(
      'did-start-navigation',
      expect.any(Function),
    );
    closedListeners.forEach((listener) => listener());
    expect(ipcMain.off).toHaveBeenCalledTimes(1);
    expect(capabilities.prompt.dispose).toHaveBeenCalledOnce();
  });

  it('uses desktop auth status when posting main-view startup login state', async () => {
    let rendererListener: RendererListener | undefined;
    const ipcMain = createIpcMainMock((listener) => {
      rendererListener = listener;
    });
    const nativeTheme = createNativeThemeMock();
    const { ELECTRON_WEBVIEW_PUSH_CHANNEL, installDesktopMainViewIpc } =
      await loadDesktopMainViewIpcModule({ ipcMain, nativeTheme });
    const sends: Array<{ channel: string; message: unknown }> = [];
    const { window, webContents } = createWindowMock(sends);

    installDesktopMainViewIpc(window, {
      ...createMainViewCommandCapabilities(),
      getAuthStatus: async () => ({ authenticated: true }),
      loadStartupOptions: async () => ({
        agentOptions: {
          workflow: [],
          toolUse: [],
        },
        modelOptions: [],
      }),
    });
    rendererListener?.(
      { sender: webContents },
      { command: MAIN_VIEW_COMMANDS.WEBVIEW_READY, view: 'main' },
    );
    await flushAsyncWork();

    await vi.waitFor(
      () => {
        expect(
          sends.filter(
            ({ channel }) => channel === ELECTRON_WEBVIEW_PUSH_CHANNEL,
          ),
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              message: { command: MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER },
            }),
          ]),
        );
      },
      {
        timeout: 5000,
      },
    );
    expect(
      sends.some(
        ({ message }) =>
          (message as { command?: string }).command ===
          MAIN_VIEW_COMMANDS.SHOW_LOGIN_BANNER,
      ),
    ).toBe(false);
  });

  it('waits for desktop model-list refresh before posting main-view model options', async () => {
    let rendererListener: RendererListener | undefined;
    const ipcMain = createIpcMainMock((listener) => {
      rendererListener = listener;
    });
    const nativeTheme = createNativeThemeMock();
    const modelListRefresh = createDeferred();
    vi.doMock('@agent/index/agentRegistry', () => ({
      computeAgentOptionsData: vi.fn(async () => ({
        workflow: [],
        toolUse: [],
      })),
    }));
    vi.doMock('@model/computeModelOptions', () => ({
      // `label` is required by `ModelOptionDataSchema` (PickerOptionBaseSchema)
      // — `postToRenderer` now runs the SET_MODEL_OPTIONS payload through it
      // (dev/test only), so the stub must match the real shape.
      computeModelOptionsData: vi.fn(async () => [
        { value: 'fresh-model', label: 'Fresh Model' },
      ]),
    }));
    const { ELECTRON_WEBVIEW_PUSH_CHANNEL, installDesktopMainViewIpc } =
      await loadDesktopMainViewIpcModule({ ipcMain, nativeTheme });
    const sends: Array<{ channel: string; message: unknown }> = [];
    const { window, webContents } = createWindowMock(sends);

    installDesktopMainViewIpc(window, {
      ...createMainViewCommandCapabilities(),
      modelListRefresh: modelListRefresh.promise,
    });
    rendererListener?.(
      { sender: webContents },
      { command: MAIN_VIEW_COMMANDS.WEBVIEW_READY, view: 'main' },
    );
    await flushAsyncWork();

    expect(
      sends.some(
        ({ message }) =>
          (message as { command?: string }).command ===
          MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
      ),
    ).toBe(false);

    modelListRefresh.resolve();
    await flushAsyncWork();

    expect(
      sends.find(
        ({ channel, message }) =>
          channel === ELECTRON_WEBVIEW_PUSH_CHANNEL &&
          (message as { command?: string }).command ===
            MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
      ),
    ).toMatchObject({
      message: {
        command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
        optionsData: [{ value: 'fresh-model' }],
      },
    });
  });
});
