// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - webview command constants
import { COMMON_COMMANDS } from '@common/webview/commonCommands';
import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/progressViewCommands';
import { SETTINGS_VIEW_COMMANDS } from '@common/webview/settingsViewCommands';
import { AGENT_CATEGORY } from '@shared/schemas/agent';
import { SETTINGS_TAB } from '@shared/schemas/settingsViewMessages';

// Local imports - desktop test paths
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

interface MainViewIpcModule {
  installDesktopMainViewIpc(
    window: {
      isDestroyed(): boolean;
      once(event: 'closed', listener: () => void): void;
      webContents: {
        isDestroyed(): boolean;
        send(channel: string, message: unknown): void;
      };
    },
    options?: {
      debugMode?: boolean;
      getTheme?: () => 'dark' | 'light' | 'high-contrast';
      fileSelection?: { handleMessage(message: { command: string }): boolean };
      settings?: { handleMessage(message: { command: string }): boolean };
      progress?: { handleMessage(message: { command: string }): boolean };
      modelListRefresh?: PromiseLike<void>;
      getAuthStatus?: () => Promise<{ authenticated: boolean }>;
      loadStartupOptions?: () => Promise<{
        agentOptions: { workflow: unknown[]; toolUse: unknown[] };
        modelOptions: unknown[];
      }>;
      executeAgent?: (message: unknown) => Promise<void>;
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

describe('desktop main-view IPC', () => {
  afterEach(() => {
    vi.doUnmock('electron');
    vi.doUnmock('@agent/index/agentRegistry');
    vi.doUnmock('@model/computeModelOptions');
    vi.doUnmock('@model/modelOptionsBasic');
  });

  it('pushes theme and debug state over the fixed host bridge channel', async () => {
    let rendererListener:
      | ((event: { sender: unknown }, message: unknown) => void)
      | undefined;
    let themeListener: (() => void) | undefined;
    const ipcMain = {
      on: vi.fn((channel, listener) => {
        rendererListener = listener;
      }),
      off: vi.fn(),
    };
    const nativeTheme = {
      shouldUseDarkColors: true,
      shouldUseHighContrastColors: false,
      on: vi.fn((_event: 'updated', listener: () => void) => {
        themeListener = listener;
      }),
      off: vi.fn(),
    };
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
          message.command === SETTINGS_VIEW_COMMANDS.GET_GIT_AUTHOR_SETTINGS,
      ),
    };
    const progress = {
      handleMessage: vi.fn(
        (message: { command: string }) =>
          message.command === PROGRESS_VIEW_COMMANDS.SWITCH_STREAM,
      ),
    };
    const executeAgent = vi.fn(async (_message: unknown) => {});
    const webContents = {
      isDestroyed: () => false,
      send: vi.fn((channel, message) => sends.push({ channel, message })),
    };
    const closedListeners: Array<() => void> = [];
    const window = {
      isDestroyed: () => false,
      once: vi.fn((_event: 'closed', listener: () => void) => {
        closedListeners.push(listener);
      }),
      webContents,
    };

    const ipc = installDesktopMainViewIpc(window, {
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
      { command: MAIN_VIEW_COMMANDS.WEBVIEW_READY },
    );
    expect(sends).toEqual([
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
      { command: SETTINGS_VIEW_COMMANDS.GET_GIT_AUTHOR_SETTINGS },
    );
    expect(settings.handleMessage).toHaveBeenCalledWith({
      command: SETTINGS_VIEW_COMMANDS.GET_GIT_AUTHOR_SETTINGS,
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
    expect(sends).toEqual([
      {
        channel: ELECTRON_WEBVIEW_PUSH_CHANNEL,
        message: {
          command: MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS,
          commits: [],
          isGitRepo: false,
        },
      },
    ]);

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
    expect(sends).toEqual([
      {
        channel: ELECTRON_WEBVIEW_PUSH_CHANNEL,
        message: { command: 'desktop:setRoute', route: 'progress' },
      },
    ]);

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
        sessionType: AGENT_CATEGORY.TOOL_USE,
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
    expect(sends).toEqual([
      {
        channel: ELECTRON_WEBVIEW_PUSH_CHANNEL,
        message: { command: 'desktop:setRoute', route: 'settings' },
      },
      {
        channel: ELECTRON_WEBVIEW_PUSH_CHANNEL,
        message: { command: 'desktop:setRoute', route: 'settings' },
      },
      {
        channel: ELECTRON_WEBVIEW_PUSH_CHANNEL,
        message: {
          command: SETTINGS_VIEW_COMMANDS.SET_TAB,
          tabIndex: SETTINGS_TAB.MODELS,
        },
      },
      {
        channel: ELECTRON_WEBVIEW_PUSH_CHANNEL,
        message: { command: 'desktop:setRoute', route: 'settings' },
      },
      {
        channel: ELECTRON_WEBVIEW_PUSH_CHANNEL,
        message: {
          agentSubTab: AGENT_CATEGORY.TOOL_USE,
          command: SETTINGS_VIEW_COMMANDS.SET_TAB,
          tabIndex: SETTINGS_TAB.AGENTS,
        },
      },
      {
        channel: ELECTRON_WEBVIEW_PUSH_CHANNEL,
        message: { command: 'desktop:setRoute', route: 'settings' },
      },
      {
        channel: ELECTRON_WEBVIEW_PUSH_CHANNEL,
        message: {
          command: SETTINGS_VIEW_COMMANDS.SET_TAB,
          tabIndex: SETTINGS_TAB.MULTI_AGENT,
        },
      },
      {
        channel: ELECTRON_WEBVIEW_PUSH_CHANNEL,
        message: { command: 'desktop:setRoute', route: 'settings' },
      },
      {
        channel: ELECTRON_WEBVIEW_PUSH_CHANNEL,
        message: {
          command: SETTINGS_VIEW_COMMANDS.SET_TAB,
          tabIndex: SETTINGS_TAB.AGENTS,
        },
      },
    ]);

    sends.length = 0;
    rendererListener?.(
      { sender: webContents },
      { command: MAIN_VIEW_COMMANDS.OPEN_AGENT_DIRECTORY, customDirSet: true },
    );
    expect(sends).toEqual([
      {
        channel: ELECTRON_WEBVIEW_PUSH_CHANNEL,
        message: { command: 'desktop:setRoute', route: 'settings' },
      },
      {
        channel: ELECTRON_WEBVIEW_PUSH_CHANNEL,
        message: {
          command: SETTINGS_VIEW_COMMANDS.SET_TAB,
          tabIndex: SETTINGS_TAB.AGENTS,
        },
      },
    ]);

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

    ipc.dispose();
    expect(nativeTheme.off).toHaveBeenCalledWith('updated', themeListener);
    expect(ipcMain.off).toHaveBeenCalledTimes(1);
    closedListeners.forEach((listener) => listener());
    expect(ipcMain.off).toHaveBeenCalledTimes(1);
  });

  it('uses desktop auth status when posting main-view startup login state', async () => {
    let rendererListener:
      | ((event: { sender: unknown }, message: unknown) => void)
      | undefined;
    const ipcMain = {
      on: vi.fn((channel, listener) => {
        rendererListener = listener;
      }),
      off: vi.fn(),
    };
    const nativeTheme = {
      shouldUseDarkColors: false,
      shouldUseHighContrastColors: false,
      on: vi.fn(),
      off: vi.fn(),
    };
    const { ELECTRON_WEBVIEW_PUSH_CHANNEL, installDesktopMainViewIpc } =
      await loadDesktopMainViewIpcModule({ ipcMain, nativeTheme });
    const sends: Array<{ channel: string; message: unknown }> = [];
    const webContents = {
      isDestroyed: () => false,
      send: vi.fn((channel, message) => sends.push({ channel, message })),
    };
    const window = {
      isDestroyed: () => false,
      once: vi.fn(),
      webContents,
    };

    installDesktopMainViewIpc(window, {
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
    let rendererListener:
      | ((event: { sender: unknown }, message: unknown) => void)
      | undefined;
    const ipcMain = {
      on: vi.fn((channel, listener) => {
        rendererListener = listener;
      }),
      off: vi.fn(),
    };
    const nativeTheme = {
      shouldUseDarkColors: false,
      shouldUseHighContrastColors: false,
      on: vi.fn(),
      off: vi.fn(),
    };
    const modelListRefresh = createDeferred();
    vi.doMock('@agent/index/agentRegistry', () => ({
      computeAgentOptionsData: vi.fn(async () => ({
        workflow: [],
        toolUse: [],
      })),
    }));
    vi.doMock('@model/computeModelOptions', () => ({
      computeModelOptionsData: vi.fn(async () => [{ value: 'fresh-model' }]),
    }));
    const { ELECTRON_WEBVIEW_PUSH_CHANNEL, installDesktopMainViewIpc } =
      await loadDesktopMainViewIpcModule({ ipcMain, nativeTheme });
    const sends: Array<{ channel: string; message: unknown }> = [];
    const webContents = {
      isDestroyed: () => false,
      send: vi.fn((channel, message) => sends.push({ channel, message })),
    };
    const window = {
      isDestroyed: () => false,
      once: vi.fn(),
      webContents,
    };

    installDesktopMainViewIpc(window, {
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
