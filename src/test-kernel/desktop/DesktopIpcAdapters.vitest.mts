// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - webview command constants
import { COMMON_COMMANDS } from '@common/webview/commonCommands';
import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';
import { SETTINGS_VIEW_COMMANDS } from '@common/webview/settingsViewCommands';
import { AGENT_CATEGORY } from '@shared/schemas/agent';
import { SETTINGS_TAB } from '@shared/schemas/settingsViewMessages';

// Local imports - desktop test paths
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

interface DesktopRenderer {
  postToRenderer(message: unknown): void;
}

interface DesktopShellIpcModule {
  createDesktopShellIpc(
    renderer: DesktopRenderer,
    options?: {
      getCustomAgentDirectory?: () => Promise<string>;
      openPath?: (filePath: string) => Promise<void>;
      signIn?: () => Promise<void>;
      onAsyncError?: (error: unknown) => void;
    },
  ): {
    handleMessage(
      message: { command: string } & Record<string, unknown>,
    ): boolean;
  };
}

interface DesktopExecutionIpcModule {
  createDesktopExecutionIpc(options?: {
    executeAgent?: (message: unknown) => Promise<void>;
    onAsyncError?: (error: unknown) => void;
  }): {
    handleMessage(
      message: { command: string } & Record<string, unknown>,
    ): boolean;
  };
}

interface DesktopOnboardingIpcModule {
  DESKTOP_ONBOARDING_DISMISSED_STATE_KEY: string;
  createDesktopOnboardingIpc(
    renderer: DesktopRenderer,
    options?: {
      state?: {
        get<T>(key: string, defaultValue?: T): T;
        update(key: string, value: unknown): PromiseLike<void>;
      };
      onAsyncError?: (error: unknown) => void;
    },
  ): {
    handleMessage(message: { command: string }): boolean;
  };
}

interface DesktopViewStateIpcModule {
  createDesktopViewStateIpc(
    renderer: DesktopRenderer,
    options?: {
      debugMode?: boolean;
      getTheme?: () => 'dark' | 'light' | 'high-contrast';
    },
  ): {
    handleMessage(message: { command: string }): boolean;
    dispose(): void;
  };
}

async function loadDesktopShellIpc(): Promise<DesktopShellIpcModule> {
  return import(
    moduleFileUrl(desktopSourcePath('main', 'desktopShellIpc.ts'))
  ) as Promise<DesktopShellIpcModule>;
}

async function loadDesktopExecutionIpc(): Promise<DesktopExecutionIpcModule> {
  return import(
    moduleFileUrl(desktopSourcePath('main', 'desktopExecutionIpc.ts'))
  ) as Promise<DesktopExecutionIpcModule>;
}

async function loadDesktopOnboardingIpc(): Promise<DesktopOnboardingIpcModule> {
  const [onboardingIpc, onboardingMessages] = await Promise.all([
    import(
      moduleFileUrl(desktopSourcePath('main', 'desktopOnboardingIpc.ts'))
    ) as Promise<DesktopOnboardingIpcModule>,
    import(
      moduleFileUrl(desktopSourcePath('desktopOnboardingMessages.ts'))
    ) as Promise<{ DESKTOP_ONBOARDING_DISMISSED_STATE_KEY: string }>,
  ]);
  return { ...onboardingIpc, ...onboardingMessages };
}

async function loadDesktopViewStateIpc(nativeTheme: {
  shouldUseDarkColors: boolean;
  shouldUseHighContrastColors: boolean;
  on(event: 'updated', listener: () => void): void;
  off(event: 'updated', listener: () => void): void;
}): Promise<DesktopViewStateIpcModule> {
  vi.resetModules();
  vi.doMock('electron', () => ({ nativeTheme }));
  return import(
    moduleFileUrl(desktopSourcePath('main', 'desktopViewStateIpc.ts'))
  ) as Promise<DesktopViewStateIpcModule>;
}

describe('desktop IPC adapters', () => {
  afterEach(() => {
    vi.doUnmock('electron');
  });

  it('keeps theme and debug state in the view-state adapter', async () => {
    let themeListener: (() => void) | undefined;
    const nativeTheme = {
      shouldUseDarkColors: true,
      shouldUseHighContrastColors: false,
      on: vi.fn((_event: 'updated', listener: () => void) => {
        themeListener = listener;
      }),
      off: vi.fn(),
    };
    const { createDesktopViewStateIpc } =
      await loadDesktopViewStateIpc(nativeTheme);
    const postToRenderer = vi.fn();
    const stateIpc = createDesktopViewStateIpc(
      { postToRenderer },
      { debugMode: true },
    );

    expect(
      stateIpc.handleMessage({ command: MAIN_VIEW_COMMANDS.WEBVIEW_READY }),
    ).toBe(true);
    expect(postToRenderer).toHaveBeenCalledWith({
      command: COMMON_COMMANDS.THEME_SET,
      theme: 'dark',
    });
    expect(postToRenderer).toHaveBeenCalledWith({
      command: COMMON_COMMANDS.DEBUG_MODE_SET,
      debugMode: true,
    });

    nativeTheme.shouldUseHighContrastColors = true;
    themeListener?.();
    expect(postToRenderer).toHaveBeenLastCalledWith({
      command: COMMON_COMMANDS.THEME_SET,
      theme: 'high-contrast',
    });

    stateIpc.dispose();
    expect(nativeTheme.off).toHaveBeenCalledWith('updated', themeListener);
  });

  it('keeps shell routing and launcher fallbacks in the shell adapter', async () => {
    const { createDesktopShellIpc } = await loadDesktopShellIpc();
    const postToRenderer = vi.fn();
    const openPath = vi.fn(async (_filePath: string) => {});
    const shellIpc = createDesktopShellIpc(
      { postToRenderer },
      {
        getCustomAgentDirectory: async () => '/agents/custom',
        openPath,
      },
    );

    shellIpc.handleMessage({
      command: COMMON_COMMANDS.SWITCH_VIEW,
      view: 'progress',
    });
    shellIpc.handleMessage({ command: MAIN_VIEW_COMMANDS.OPEN_MODEL_SETTINGS });
    shellIpc.handleMessage({
      command: MAIN_VIEW_COMMANDS.OPEN_AGENT_SETTINGS,
      sessionType: AGENT_CATEGORY.TOOL_USE,
    });
    shellIpc.handleMessage({
      command: MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS,
    });

    expect(postToRenderer).toHaveBeenNthCalledWith(1, {
      command: 'desktop:setRoute',
      route: 'progress',
    });
    expect(postToRenderer).toHaveBeenNthCalledWith(2, {
      command: 'desktop:setRoute',
      route: 'settings',
    });
    expect(postToRenderer).toHaveBeenNthCalledWith(3, {
      command: SETTINGS_VIEW_COMMANDS.SET_TAB,
      tabIndex: SETTINGS_TAB.MODELS,
    });
    expect(postToRenderer).toHaveBeenNthCalledWith(4, {
      command: 'desktop:setRoute',
      route: 'settings',
    });
    expect(postToRenderer).toHaveBeenNthCalledWith(5, {
      agentSubTab: AGENT_CATEGORY.TOOL_USE,
      command: SETTINGS_VIEW_COMMANDS.SET_TAB,
      tabIndex: SETTINGS_TAB.AGENTS,
    });
    expect(postToRenderer).toHaveBeenNthCalledWith(6, {
      command: MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS,
      commits: [],
      isGitRepo: false,
    });

    shellIpc.handleMessage({
      command: MAIN_VIEW_COMMANDS.OPEN_AGENT_DIRECTORY,
      customDirSet: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(openPath).toHaveBeenCalledWith('/agents/custom');

    postToRenderer.mockClear();
    createDesktopShellIpc({ postToRenderer }).handleMessage({
      command: MAIN_VIEW_COMMANDS.OPEN_AGENT_DIRECTORY,
      customDirSet: true,
    });
    expect(postToRenderer).toHaveBeenCalledWith({
      command: 'desktop:setRoute',
      route: 'settings',
    });
    expect(postToRenderer).toHaveBeenCalledWith({
      command: SETTINGS_VIEW_COMMANDS.SET_TAB,
      tabIndex: SETTINGS_TAB.AGENTS,
    });
  });

  it('wires the main login banner to desktop sign-in', async () => {
    const { createDesktopShellIpc } = await loadDesktopShellIpc();
    const postToRenderer = vi.fn();
    const signIn = vi.fn(async () => {});
    const shellIpc = createDesktopShellIpc({ postToRenderer }, { signIn });

    expect(
      shellIpc.handleMessage({
        command: MAIN_VIEW_COMMANDS.SIGN_IN_FROM_BANNER,
      }),
    ).toBe(true);
    await Promise.resolve();

    expect(signIn).toHaveBeenCalledOnce();
    expect(postToRenderer).not.toHaveBeenCalled();
  });

  it('keeps execution forwarding in the execution adapter', async () => {
    const { createDesktopExecutionIpc } = await loadDesktopExecutionIpc();
    const executeMessage = {
      command: MAIN_VIEW_COMMANDS.EXECUTE,
      agent: 'direct-agent',
      model: 'gpt-5.4',
    };
    const executeAgent = vi.fn(async (_message: unknown) => {});
    const executionIpc = createDesktopExecutionIpc({ executeAgent });

    expect(executionIpc.handleMessage(executeMessage)).toBe(true);
    await Promise.resolve();
    expect(executeAgent).toHaveBeenCalledWith(executeMessage);

    const error = new Error('execution failed');
    const onAsyncError = vi.fn();
    createDesktopExecutionIpc({
      executeAgent: vi.fn(async () => {
        throw error;
      }),
      onAsyncError,
    }).handleMessage(executeMessage);
    await Promise.resolve();
    await Promise.resolve();
    expect(onAsyncError).toHaveBeenCalledWith(error);
  });

  it('persists first-run walkthrough dismissal in the onboarding adapter', async () => {
    const {
      DESKTOP_ONBOARDING_DISMISSED_STATE_KEY,
      createDesktopOnboardingIpc,
    } = await loadDesktopOnboardingIpc();
    const values = new Map<string, unknown>();
    const update = vi.fn(async (key: string, value: unknown) => {
      values.set(key, value);
    });
    const state = {
      get<T>(key: string, defaultValue?: T): T {
        return (values.has(key) ? values.get(key) : defaultValue) as T;
      },
      update,
    };
    const postToRenderer = vi.fn();
    const onboarding = createDesktopOnboardingIpc(
      { postToRenderer },
      { state },
    );

    expect(
      onboarding.handleMessage({ command: 'desktop:requestOnboarding' }),
    ).toBe(true);
    expect(postToRenderer).toHaveBeenLastCalledWith({
      command: 'desktop:setOnboarding',
      shouldShow: true,
    });

    expect(
      onboarding.handleMessage({ command: 'desktop:dismissOnboarding' }),
    ).toBe(true);
    await Promise.resolve();
    expect(update).toHaveBeenCalledWith(
      DESKTOP_ONBOARDING_DISMISSED_STATE_KEY,
      true,
    );
    expect(postToRenderer).toHaveBeenLastCalledWith({
      command: 'desktop:setOnboarding',
      shouldShow: false,
    });

    expect(
      onboarding.handleMessage({ command: 'desktop:requestOnboarding' }),
    ).toBe(true);
    expect(postToRenderer).toHaveBeenLastCalledWith({
      command: 'desktop:setOnboarding',
      shouldShow: false,
    });

    expect(
      onboarding.handleMessage({ command: 'desktop:showOnboarding' }),
    ).toBe(true);
    expect(postToRenderer).toHaveBeenLastCalledWith({
      command: 'desktop:setOnboarding',
      shouldShow: true,
    });
  });
});
