// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - shared host bridge
import {
  ELECTRON_WEBVIEW_MESSAGE_CHANNEL,
  ELECTRON_WEBVIEW_PUSH_CHANNEL,
} from '@desktop/hostBridgeChannels';

// Local imports - webview command constants
import {
  COMMON_COMMANDS,
  MAIN_VIEW_COMMANDS,
  PROGRESS_VIEW_COMMANDS,
  SETTINGS_VIEW_COMMANDS,
} from '@shared/ipc';
import { AgentCategory } from '@shared/schemas/agent';
import { AGENT_MODE_PRESETS } from '@shared/schemas/agentPresets';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { SETTINGS_TAB } from '@shared/schemas/settingsViewMessages';
import { createDeferred } from '@test/support/asyncTestUtils';

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
  vi.doMock('electron', () => electron);
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
    showRoute: vi.fn(),
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
    executeAgent: vi.fn(async (_message: unknown) => {}),
    fileSelection: createUnhandledCapability(),
    prompt: { ...createUnhandledCapability(), dispose: vi.fn() },
    settings: createUnhandledCapability(),
    progress: createUnhandledCapability(),
    onboarding: createUnhandledCapability(),
    logs: {
      readLog: () => ({ path: undefined, text: '', truncated: false }),
      copyLog: vi.fn(async (_text: string) => {}),
      exportLog: vi.fn(async (_text: string) => {}),
    },
    shellActions: createMainViewShellActions(),
  };
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

describe('desktop main-view IPC', () => {
  afterEach(() => {
    vi.doUnmock('electron');
    vi.doUnmock('@agent/index');
    vi.doUnmock('@auth/SupabaseClient');
    vi.doUnmock('@model/computeModelOptions');
  });

  it('pushes theme and debug state over the fixed host bridge channel', async () => {
    let themeListener: (() => void) | undefined;
    const {
      installDesktopMainViewIpc,
      ipcMain,
      nativeTheme,
      sends,
      window,
      closedListeners,
      getRendererListener,
      sendFromRenderer,
    } = await createMainViewHarness({
      shouldUseDarkColors: true,
      onUpdated: (listener) => {
        themeListener = listener;
      },
    });
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
    const executeAgent = vi.fn(async (_message: unknown) => {});

    const capabilities = createMainViewCommandCapabilities();
    const ipc = installDesktopMainViewIpc(window, {
      ...capabilities,
      debugMode: true,
      fileSelection,
      settings,
      progress,
      executeAgent,
      // This test only cares about theme/debug pushes; keep the startup
      // catalog loader (which reads platform workspace state) out of scope.
      loadStartupOptions: async () => ({
        agentOptions: { workflow: [], toolUse: [] },
        modelOptions: [],
        teamOptions: [],
      }),
    });

    expect(ipcMain.on).toHaveBeenCalledWith(
      ELECTRON_WEBVIEW_MESSAGE_CHANNEL,
      getRendererListener(),
    );
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
    });
    expect(progress.handleMessage).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.SWITCH_STREAM,
      stream: 'run-1',
    });

    sends.length = 0;
    sendFromRenderer({ command: MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS });
    expect(capabilities.shellActions.sendRecentCommits).toHaveBeenCalledOnce();
    expect(sends).toEqual([]);

    sends.length = 0;
    nativeTheme.shouldUseDarkColors = false;
    sendFromRenderer({ command: MAIN_VIEW_COMMANDS.GET_THEME });
    expect(sends).toEqual([
      {
        channel: ELECTRON_WEBVIEW_PUSH_CHANNEL,
        message: { command: COMMON_COMMANDS.THEME_SET, theme: 'light' },
      },
    ]);

    sends.length = 0;
    sendFromRenderer({ command: MAIN_VIEW_COMMANDS.GET_DEBUG_MODE });
    expect(sends).toEqual([
      {
        channel: ELECTRON_WEBVIEW_PUSH_CHANNEL,
        message: { command: COMMON_COMMANDS.DEBUG_MODE_SET, debugMode: true },
      },
    ]);

    sends.length = 0;
    sendFromRenderer({
      command: COMMON_COMMANDS.SWITCH_VIEW,
      view: 'main',
    });
    expect(capabilities.shellActions.showRoute).toHaveBeenCalledWith('main');
    expect(sends).toEqual([]);

    sends.length = 0;
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
    sendFromRenderer({
      command: MAIN_VIEW_COMMANDS.OPEN_AGENT_DIRECTORY,
      customDirSet: true,
    });
    expect(capabilities.shellActions.openAgentDirectory).toHaveBeenCalledWith(
      true,
    );
    expect(sends).toEqual([]);

    const executeMessage = {
      command: MAIN_VIEW_COMMANDS.EXECUTE,
      agent: 'direct-agent',
      model: 'gpt-5.4',
    };
    sendFromRenderer(executeMessage);
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
    expect(capabilities.prompt.dispose).toHaveBeenCalledOnce();
    closedListeners.forEach((listener) => listener());
    expect(ipcMain.off).toHaveBeenCalledTimes(1);
    expect(capabilities.prompt.dispose).toHaveBeenCalledOnce();
  });

  it('uses desktop auth status when posting main-view startup login state', async () => {
    const { installDesktopMainViewIpc, sends, window, sendFromRenderer } =
      await createMainViewHarness();

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
      {
        timeout: 5000,
      },
    );
    expect(
      sends.some(
        ({ message }) =>
          commandOf(message) === MAIN_VIEW_COMMANDS.SHOW_LOGIN_BANNER,
      ),
    ).toBe(false);
  });

  it('waits for desktop model-list refresh before posting main-view model options', async () => {
    const modelListRefresh = createDeferred();
    // desktopMainViewStartup resolves the whole startup catalog through the
    // `@agent/index` barrel (agent options plus the team-option loader's
    // catalog/refresh ports), so the barrel — not the agentRegistry leaf
    // module — is the mock boundary here.
    vi.doMock('@agent/index', () => ({
      computeAgentOptionsData: vi.fn(async () => ({
        workflow: [],
        toolUse: [],
      })),
      loadAgents: vi.fn(async () => undefined),
      getAgentsByCategory: vi.fn(() => []),
      refresh: vi.fn(async () => undefined),
    }));
    vi.doMock('@auth/SupabaseClient', () => ({
      SupabaseClient: {
        canAccessRemoteAgentCatalog: vi.fn(async () => false),
      },
    }));
    vi.doMock('@model/computeModelOptions', () => ({
      // `label` is required by `ModelOptionDataSchema` (PickerOptionBaseSchema) —
      // `postToRenderer` now runs the SET_MODEL_OPTIONS payload through it
      // (dev/test only), so the stub must match the real shape.
      computeModelOptionsData: vi.fn(async () => [
        { value: 'fresh-model', label: 'Fresh Model' },
      ]),
    }));
    const { installDesktopMainViewIpc, sends, window, sendFromRenderer } =
      await createMainViewHarness();
    // The default startup loader reads custom team presets through the
    // platform workspace state; re-init the fresh module instance that
    // loadDesktopMainViewIpcModule's vi.resetModules() just produced.
    const [{ initPlatform }, { createFakePlatform }] = await Promise.all([
      import('@platform/platform'),
      import('@test/support/FakePlatform'),
    ]);
    initPlatform(createFakePlatform({}));

    installDesktopMainViewIpc(window, {
      ...createMainViewCommandCapabilities(),
      modelListRefresh: modelListRefresh.promise,
    });
    sendFromRenderer({
      command: MAIN_VIEW_COMMANDS.WEBVIEW_READY,
      view: 'main',
    });
    await flushAsyncWork();

    expect(
      sends.some(
        ({ message }) =>
          commandOf(message) === MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
      ),
    ).toBe(false);

    modelListRefresh.resolve();
    await flushAsyncWork();

    expect(findPush(sends, MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS)).toMatchObject(
      {
        message: {
          command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
          optionsData: [{ value: 'fresh-model' }],
        },
      },
    );

    // The default loader also resolves team options: every built-in team is
    // listed (disabled while its roster cannot resolve in this environment).
    const teamPush = findPush(sends, MAIN_VIEW_COMMANDS.SET_TEAM_OPTIONS);
    expect(teamPush).toBeDefined();
    const teamOptions = (teamPush!.message as { optionsData: unknown[] })
      .optionsData;
    expect(
      teamOptions.map((option) => (option as { value?: string }).value),
    ).toEqual(AGENT_MODE_PRESETS.map((preset) => preset.id));
    expect(
      teamOptions.every(
        (option) => (option as { source?: string }).source === 'built-in',
      ),
    ).toBe(true);
  });

  it('posts the injected startup team options on main-view ready', async () => {
    const { installDesktopMainViewIpc, sends, window, sendFromRenderer } =
      await createMainViewHarness();

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
    installDesktopMainViewIpc(window, {
      ...createMainViewCommandCapabilities(),
      loadStartupOptions: async () => ({
        agentOptions: { workflow: [], toolUse: [] },
        modelOptions: [],
        teamOptions,
      }),
    });
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
