// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - shared host bridge
import {
  ELECTRON_WEBVIEW_MESSAGE_CHANNEL,
  ELECTRON_WEBVIEW_PUSH_CHANNEL,
} from '@desktop/shared/hostBridgeChannels';

// Local imports - webview command constants
import {
  COMMON_COMMANDS,
  MAIN_VIEW_COMMANDS,
  PROGRESS_VIEW_COMMANDS,
  SETTINGS_VIEW_COMMANDS,
} from '@shared/ipc';
import { AgentCategory, SETTINGS_TAB } from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { FakeStateStore } from '@test/support/FakePlatform';
import { createModuleMocks } from '@test/support/moduleMocks';

// Local imports - desktop test paths
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.ts';

const mocks = createModuleMocks();

interface TestDesktopShellActions {
  showLauncher: ReturnType<typeof vi.fn>;
  openWorkbench: ReturnType<typeof vi.fn>;
  showSettings: ReturnType<typeof vi.fn>;
  signIn: ReturnType<typeof vi.fn>;
  openAgentDirectory: ReturnType<typeof vi.fn>;
  openDesktopDocs: ReturnType<typeof vi.fn>;
  openLogFolder: ReturnType<typeof vi.fn>;
  openWorkspaceFolder: ReturnType<typeof vi.fn>;
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
      };
    },
    options: {
      debugMode?: boolean;
      getTheme?: () => 'dark' | 'light' | 'high-contrast';
      fileSelection: { handleMessage(message: { command: string }): boolean };
      prompt: {
        handleMessage(message: { command: string }): boolean;
        dispose(): void;
      };
      settings: { handleMessage(message: { command: string }): boolean };
      progress: { handleMessage(message: { command: string }): boolean };
      onboarding: { handleMessage(message: { command: string }): boolean };
      shellActions: TestDesktopShellActions;
      getAuthStatus?: () => Promise<{ authenticated: boolean }>;
      loadStartupOptions?: () => Promise<{
        agentOptions: { workflow: unknown[]; toolUse: unknown[] };
        modelOptionsByCategory: { workflow: unknown[]; toolUse: unknown[] };
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
      handleExecuteMessage(message: unknown): Promise<void>;
      onAsyncError?: (error: unknown) => void;
    },
  ): {
    postToRenderer(message: unknown): void;
    dispose(): void;
  };
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
}): Promise<MainViewIpcModule> {
  vi.resetModules();
  mocks.doMock('electron', () => electron);
  return import(
    moduleFileUrl(desktopSourcePath('main', 'mainViewIpc.ts'))
  ) as Promise<MainViewIpcModule>;
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) =>
    setImmediate(() => setImmediate(() => resolve())),
  );
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
    showLauncher: vi.fn(),
    openWorkbench: vi.fn(),
    showSettings: vi.fn(),
    signIn: vi.fn(),
    openAgentDirectory: vi.fn(),
    openDesktopDocs: vi.fn(),
    openLogFolder: vi.fn(),
    openWorkspaceFolder: vi.fn(),
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
    handleExecuteMessage: vi.fn(async (_message: unknown) => {}),
    fileSelection: createUnhandledCapability(),
    prompt: { ...createUnhandledCapability(), dispose: vi.fn() },
    settings: createUnhandledCapability(),
    progress: createUnhandledCapability(),
    onboarding: createUnhandledCapability(),
    globalState: new FakeStateStore(),
    logs: {
      readLog: () => ({ path: undefined, text: '', truncated: false }),
      copyLog: vi.fn(async (_text: string) => {}),
      exportLog: vi.fn(async (_text: string) => {}),
    },
    shellActions: createMainViewShellActions(),
  };
}

function emptyStartupOptionsLoader(teamOptions?: unknown[]) {
  return async () => ({
    agentOptions: { workflow: [] as unknown[], toolUse: [] as unknown[] },
    modelOptionsByCategory: {
      workflow: [] as unknown[],
      toolUse: [] as unknown[],
    },
    ...(teamOptions === undefined ? {} : { teamOptions }),
  });
}

type RendererSend = { channel: string; message: unknown };

function commandOf(message: unknown): string | undefined {
  return (message as { command?: string }).command;
}

function pushedCommands(sends: RendererSend[]): Array<string | undefined> {
  return sends
    .filter(({ channel }) => channel === ELECTRON_WEBVIEW_PUSH_CHANNEL)
    .map(({ message }) => commandOf(message));
}

function findPush(
  sends: RendererSend[],
  command: string,
): RendererSend | undefined {
  return sends.find(
    ({ channel, message }) =>
      channel === ELECTRON_WEBVIEW_PUSH_CHANNEL &&
      commandOf(message) === command,
  );
}

async function createMainViewHarness(
  themeOptions: Parameters<typeof createNativeThemeMock>[0] = {},
) {
  let rendererListener: RendererListener | undefined;
  const ipcMain = createIpcMainMock((listener) => {
    rendererListener = listener;
  });
  const nativeTheme = createNativeThemeMock(themeOptions);
  const { installDesktopMainViewIpc } = await loadDesktopMainViewIpcModule({
    ipcMain,
    nativeTheme,
  });
  const sends: RendererSend[] = [];
  const closedListeners: Array<() => void> = [];
  const { window, webContents } = createWindowMock(sends, (listener) => {
    closedListeners.push(listener);
  });
  return {
    installDesktopMainViewIpc,
    ipcMain,
    nativeTheme,
    sends,
    window,
    closedListeners,
    getRendererListener: () => rendererListener,
    sendFromRenderer(message: unknown, sender: unknown = webContents) {
      rendererListener?.({ sender }, message);
    },
  };
}

type MainViewIpcOptions = Parameters<
  MainViewIpcModule['installDesktopMainViewIpc']
>[1];

type MainViewHarness = Awaited<ReturnType<typeof createMainViewHarness>>;

/**
 * Installs the IPC router over a fresh harness with the default (all
 * unhandled) capabilities plus the given overrides. The startup catalog
 * loader is stubbed empty so only the behavior under test posts to the
 * renderer.
 */
function installMainView(
  harness: MainViewHarness,
  overrides: Partial<MainViewIpcOptions> = {},
): {
  capabilities: ReturnType<typeof createMainViewCommandCapabilities>;
  ipc: ReturnType<MainViewIpcModule['installDesktopMainViewIpc']>;
} {
  const capabilities = createMainViewCommandCapabilities();
  const ipc = harness.installDesktopMainViewIpc(harness.window, {
    ...capabilities,
    loadStartupOptions: emptyStartupOptionsLoader([]),
    ...overrides,
  });
  return { capabilities, ipc };
}

describe('desktop main-view IPC', () => {
  it('registers one listener on the fixed host bridge channel', async () => {
    const harness = await createMainViewHarness();
    installMainView(harness);

    expect(harness.ipcMain.on).toHaveBeenCalledWith(
      ELECTRON_WEBVIEW_MESSAGE_CHANNEL,
      harness.getRendererListener(),
    );
  });

  it('defers theme and debug pushes until the main view signals ready', async () => {
    const harness = await createMainViewHarness({
      shouldUseDarkColors: true,
    });
    installMainView(harness, { debugMode: true });
    const { sends, sendFromRenderer } = harness;

    sendFromRenderer({ command: MAIN_VIEW_COMMANDS.GET_THEME }, {});
    expect(sends).toEqual([]);

    sendFromRenderer({
      command: MAIN_VIEW_COMMANDS.WEBVIEW_READY,
      view: 'progress',
    });
    expect(sends).toEqual([]);

    sendFromRenderer({
      command: MAIN_VIEW_COMMANDS.WEBVIEW_READY,
      view: 'main',
    });
    // Filter to the theme/debug-mode pushes: WEBVIEW_READY(view:'main') is a
    // broadcast, so sibling handlers (e.g. main-view startup) also react.
    expect(
      sends.filter(({ message }) =>
        [COMMON_COMMANDS.THEME_SET, COMMON_COMMANDS.DEBUG_MODE_SET].includes(
          commandOf(message) as never,
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
  });

  it('routes file-selection, settings, and progress messages to their handlers', async () => {
    const harness = await createMainViewHarness();
    const fileSelection = {
      handleMessage: vi.fn(
        (message: { command: string }) =>
          message.command === MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE,
      ),
    };
    const settings = {
      handleMessage: vi.fn(
        (message: { command: string }) =>
          message.command === SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
      ),
    };
    const progress = {
      handleMessage: vi.fn(
        (message: { command: string }) =>
          message.command === PROGRESS_VIEW_COMMANDS.SWITCH_STREAM,
      ),
    };
    installMainView(harness, { fileSelection, settings, progress });
    const { sendFromRenderer } = harness;

    sendFromRenderer({ command: MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE });
    expect(fileSelection.handleMessage).toHaveBeenCalledWith({
      command: MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE,
    });

    sendFromRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
      key: WorkspaceStateKey.GIT_AUTHOR_NAME,
      value: 'TeXRA Bot',
    });
    expect(settings.handleMessage).toHaveBeenCalledWith({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
      key: WorkspaceStateKey.GIT_AUTHOR_NAME,
      value: 'TeXRA Bot',
    });

    sendFromRenderer({
      command: PROGRESS_VIEW_COMMANDS.SWITCH_STREAM,
      stream: 'run-1',
      requestId: 'request-1',
    });
    expect(progress.handleMessage).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.SWITCH_STREAM,
      stream: 'run-1',
      requestId: 'request-1',
    });
  });

  it('routes recent-commit requests to the shell without renderer pushes', async () => {
    const harness = await createMainViewHarness();
    const { capabilities } = installMainView(harness);
    const { sends, sendFromRenderer } = harness;

    sendFromRenderer({ command: MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS });
    expect(capabilities.shellActions.sendRecentCommits).toHaveBeenCalledOnce();
    expect(sends).toEqual([]);
  });

  it('answers GET_THEME with the current native theme', async () => {
    const harness = await createMainViewHarness({
      shouldUseDarkColors: true,
    });
    installMainView(harness);
    const { nativeTheme, sends, sendFromRenderer } = harness;

    sendFromRenderer({
      command: MAIN_VIEW_COMMANDS.WEBVIEW_READY,
      view: 'main',
    });
    sends.length = 0;

    nativeTheme.shouldUseDarkColors = false;
    sendFromRenderer({ command: MAIN_VIEW_COMMANDS.GET_THEME });
    expect(sends).toEqual([
      {
        channel: ELECTRON_WEBVIEW_PUSH_CHANNEL,
        message: { command: COMMON_COMMANDS.THEME_SET, theme: 'light' },
      },
    ]);
  });

  it('answers GET_DEBUG_MODE with the configured flag', async () => {
    const harness = await createMainViewHarness();
    installMainView(harness, { debugMode: true });
    const { sends, sendFromRenderer } = harness;

    sendFromRenderer({
      command: MAIN_VIEW_COMMANDS.WEBVIEW_READY,
      view: 'main',
    });
    sends.length = 0;

    sendFromRenderer({ command: MAIN_VIEW_COMMANDS.GET_DEBUG_MODE });
    expect(sends).toEqual([
      {
        channel: ELECTRON_WEBVIEW_PUSH_CHANNEL,
        message: { command: COMMON_COMMANDS.DEBUG_MODE_SET, debugMode: true },
      },
    ]);
  });

  it('routes SWITCH_VIEW to the launcher without renderer pushes', async () => {
    const harness = await createMainViewHarness();
    const { capabilities } = installMainView(harness);
    const { sends, sendFromRenderer } = harness;

    sendFromRenderer({
      command: COMMON_COMMANDS.SWITCH_VIEW,
      view: 'main',
    });
    expect(capabilities.shellActions.showLauncher).toHaveBeenCalledOnce();
    expect(sends).toEqual([]);
  });

  it('routes settings and agent-directory commands to shell actions', async () => {
    const harness = await createMainViewHarness();
    const { capabilities } = installMainView(harness);
    const { sends, sendFromRenderer } = harness;

    sendFromRenderer({
      command: COMMON_COMMANDS.SWITCH_VIEW,
      view: 'dashboard',
    });
    sendFromRenderer({ command: MAIN_VIEW_COMMANDS.OPEN_MODEL_SETTINGS });
    sendFromRenderer({
      command: MAIN_VIEW_COMMANDS.OPEN_AGENT_SETTINGS,
      sessionType: AgentCategory.ToolUse,
    });
    sendFromRenderer({ command: MAIN_VIEW_COMMANDS.OPEN_MULTI_AGENT_SETTINGS });
    sendFromRenderer({ command: MAIN_VIEW_COMMANDS.OPEN_AGENT_DIRECTORY });
    expect(capabilities.shellActions.showSettings).toHaveBeenNthCalledWith(1);
    expect(capabilities.shellActions.showSettings).toHaveBeenNthCalledWith(
      2,
      SETTINGS_TAB.MODELS,
    );
    expect(capabilities.shellActions.showSettings).toHaveBeenNthCalledWith(
      3,
      SETTINGS_TAB.AGENTS,
      AgentCategory.ToolUse,
    );
    expect(capabilities.shellActions.showSettings).toHaveBeenNthCalledWith(
      4,
      SETTINGS_TAB.MULTI_AGENT,
    );
    expect(capabilities.shellActions.openAgentDirectory).toHaveBeenCalledWith(
      false,
    );
    expect(sends).toEqual([]);

    sendFromRenderer({
      command: MAIN_VIEW_COMMANDS.OPEN_AGENT_DIRECTORY,
      customDirSet: true,
    });
    expect(capabilities.shellActions.openAgentDirectory).toHaveBeenCalledWith(
      true,
    );
    expect(sends).toEqual([]);
  });

  it('forwards EXECUTE messages to the injected executor', async () => {
    const harness = await createMainViewHarness();
    const handleExecuteMessage = vi.fn(async (_message: unknown) => {});
    installMainView(harness, { handleExecuteMessage });
    const { sendFromRenderer } = harness;

    const executeMessage = {
      command: MAIN_VIEW_COMMANDS.EXECUTE,
      agent: 'direct-agent',
      model: 'gpt-5.4',
    };
    sendFromRenderer(executeMessage);
    await Promise.resolve();
    expect(handleExecuteMessage).toHaveBeenCalledWith(executeMessage);
  });

  it('pushes the new theme when the native theme changes', async () => {
    let themeListener: (() => void) | undefined;
    const harness = await createMainViewHarness({
      shouldUseDarkColors: true,
      onUpdated: (listener) => {
        themeListener = listener;
      },
    });
    installMainView(harness);
    const { nativeTheme, sends, sendFromRenderer } = harness;

    sendFromRenderer({
      command: MAIN_VIEW_COMMANDS.WEBVIEW_READY,
      view: 'main',
    });

    nativeTheme.shouldUseHighContrastColors = true;
    themeListener?.();
    expect(sends.at(-1)).toEqual({
      channel: ELECTRON_WEBVIEW_PUSH_CHANNEL,
      message: {
        command: COMMON_COMMANDS.THEME_SET,
        theme: 'high-contrast',
      },
    });
  });

  it('relays postToRenderer over the push channel', async () => {
    const harness = await createMainViewHarness();
    const { ipc } = installMainView(harness);
    const { sends } = harness;

    ipc.postToRenderer({ command: 'customPush' });
    expect(sends.at(-1)).toEqual({
      channel: ELECTRON_WEBVIEW_PUSH_CHANNEL,
      message: { command: 'customPush' },
    });
  });

  it('disposes listeners idempotently', async () => {
    let themeListener: (() => void) | undefined;
    const harness = await createMainViewHarness({
      onUpdated: (listener) => {
        themeListener = listener;
      },
    });
    const { capabilities, ipc } = installMainView(harness);
    const { closedListeners, ipcMain, nativeTheme } = harness;

    ipc.dispose();
    expect(nativeTheme.off).toHaveBeenCalledWith('updated', themeListener);
    expect(ipcMain.off).toHaveBeenCalledTimes(1);
    expect(capabilities.prompt.dispose).toHaveBeenCalledOnce();

    closedListeners.forEach((listener) => listener());
    expect(ipcMain.off).toHaveBeenCalledTimes(1);
    expect(capabilities.prompt.dispose).toHaveBeenCalledOnce();
  });

  it('uses desktop auth status when posting main-view startup login state', async () => {
    const harness = await createMainViewHarness();
    installMainView(harness, {
      getAuthStatus: async () => ({ authenticated: true }),
      loadStartupOptions: emptyStartupOptionsLoader(),
    });
    const { sends, sendFromRenderer } = harness;

    sendFromRenderer({
      command: MAIN_VIEW_COMMANDS.WEBVIEW_READY,
      view: 'main',
    });
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
      { timeout: 5000 },
    );
    expect(
      sends.some(
        ({ message }) =>
          commandOf(message) === MAIN_VIEW_COMMANDS.SHOW_LOGIN_BANNER,
      ),
    ).toBe(false);
  });

  it('posts the injected startup team options on main-view ready', async () => {
    const harness = await createMainViewHarness();

    const teamOptions = [
      {
        value: 'physicist',
        label: 'Physicist',
        icon: 'atom',
        source: 'built-in',
        description: 'A physics research team.',
        unavailableMembers: [],
        rootAgentName: 'orchestrator',
      },
      {
        value: 'my-team',
        label: 'My Team',
        icon: 'bookmark',
        source: 'custom',
        description: '',
        unavailableMembers: ['writer'],
        rootAgentName: 'lead',
      },
    ];
    installMainView(harness, {
      loadStartupOptions: emptyStartupOptionsLoader(teamOptions),
    });
    const { sends, sendFromRenderer } = harness;
    sendFromRenderer({
      command: MAIN_VIEW_COMMANDS.WEBVIEW_READY,
      view: 'main',
    });
    await flushAsyncWork();

    const teamPush = findPush(sends, MAIN_VIEW_COMMANDS.SET_TEAM_OPTIONS);
    expect(teamPush).toMatchObject({
      message: {
        command: MAIN_VIEW_COMMANDS.SET_TEAM_OPTIONS,
        optionsData: teamOptions,
      },
    });
    // Startup pushes land in controller order: model, agent, team, login.
    const startupCommands = pushedCommands(sends);
    const teamIndex = startupCommands.indexOf(
      MAIN_VIEW_COMMANDS.SET_TEAM_OPTIONS,
    );
    expect(teamIndex).toBeGreaterThan(-1);
    expect(startupCommands[teamIndex - 1]).toBe(
      MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
    );
    expect(startupCommands[teamIndex + 1]).toBe(
      MAIN_VIEW_COMMANDS.SHOW_LOGIN_BANNER,
    );
  });
});
