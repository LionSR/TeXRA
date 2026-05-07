import { afterEach, describe, expect, it } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

import { GlobalStateKey, WorkspaceStateKey } from '@common/state/stateKeys';
import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';
import { SETTINGS_VIEW_COMMANDS } from '@common/webview/settingsViewCommands';
import { DEFAULT_MODELS, MODEL_LIST_VERSION } from '@model/modelOptionsBasic';
import { DEFAULT_GIT_MARK_COMMITS } from '@shared/constants/git';
import {
  isWorktreeSupportEnabled,
  setWorktreeSupportEnabled,
} from '@tools/worktreeConfig';
import { getGitAuthorEnv, setGitAuthorEnv } from '@utils/system/gitAuthorEnv';

import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

interface StateStore {
  get<T>(key: string, defaultValue?: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

interface DesktopSettingsIpcModule {
  createDesktopSettingsIpc(options: {
    postToRenderer(message: unknown): void;
    sendStartupCatalogData?: boolean;
    globalState?: StateStore;
    workspaceState?: StateStore;
    config?: {
      get<T>(key: string, defaultValue?: T): T;
      update<T>(
        key: string,
        value: T,
        target?: 'global' | 'workspace',
      ): Promise<void>;
      inspect<T = unknown>(key: string): { effectiveValue?: T } | undefined;
      isExplicitlySet(key: string): boolean;
      watch(
        key: string | readonly string[] | RegExp,
        listener: () => void,
      ): { dispose(): void };
    };
    loadAgents?: () => Promise<void>;
    loadAgentOptionsData?: () => Promise<{
      workflow: unknown[];
      toolUse: unknown[];
    }>;
    buildToolDashboardItems?: (cachedResults?: unknown[]) => Promise<unknown[]>;
    refreshToolAvailability?: () => Promise<void>;
    getCustomAgentDirectory?: () => Promise<string>;
    selectCustomAgentDirectory?: () => Promise<string | undefined>;
    openExternalUrl?: (url: string) => Promise<void>;
    installToolExtension?: (extensionId: string) => Promise<void>;
    promptSecret?: (input: {
      title: string;
      prompt: string;
    }) => Promise<string | undefined>;
    promptText?: (input: {
      title: string;
      prompt: string;
    }) => Promise<string | undefined>;
    showInfoMessage?: (message: string) => Promise<void>;
    showErrorMessage?: (message: string) => Promise<void>;
    signIn?: () => Promise<void>;
    signOut?: () => Promise<void>;
    getAuthProfileData?: () => Promise<Record<string, unknown>>;
    setApiAccessMode?: (mode: 'included' | 'personal') => Promise<void>;
    secrets?: {
      get(key: string): Promise<string | undefined>;
      set(key: string, value: string): Promise<void>;
      delete(key: string): Promise<void>;
    };
    detectLatexSettingsStatus?: () => Promise<unknown>;
    runInstallCommand?: (command: string) => Promise<void>;
    onError?: (error: unknown) => void;
    modelListRefresh?: PromiseLike<void>;
  }): {
    refreshAuthDependentData(): Promise<void>;
    handleMessage(
      message: { command: string } & Record<string, unknown>,
    ): boolean;
  };
}

class MemoryStateStore implements StateStore {
  readonly values = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, value);
    }
  }
}

class MemoryConfigStore {
  readonly values = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }

  async update<T>(
    key: string,
    value: T,
    _target?: 'global' | 'workspace',
  ): Promise<void> {
    if (value === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, value);
    }
  }

  inspect<T = unknown>(key: string): { effectiveValue?: T } | undefined {
    return { effectiveValue: this.get<T>(key) };
  }

  isExplicitlySet(key: string): boolean {
    return this.values.has(key);
  }

  watch(): { dispose(): void } {
    return { dispose: () => undefined };
  }
}

class MemorySecrets {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

async function loadDesktopSettingsIpc(): Promise<DesktopSettingsIpcModule> {
  return import(
    moduleFileUrl(desktopSourcePath('main', 'desktopSettingsIpc.ts'))
  ) as Promise<DesktopSettingsIpcModule>;
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

describe('desktop settings IPC', () => {
  afterEach(() => {
    setGitAuthorEnv({});
    setWorktreeSupportEnabled(false);
  });

  it('applies Git author settings on creation and posts only for settings readiness', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const workspaceState = new MemoryStateStore();
    workspaceState.values.set(WorkspaceStateKey.GIT_AUTHOR_NAME, 'TeXRA Bot');
    workspaceState.values.set(
      WorkspaceStateKey.GIT_AUTHOR_EMAIL,
      'bot@example.com',
    );
    const posted: unknown[] = [];

    const settings = createDesktopSettingsIpc({
      workspaceState,
      globalState: new MemoryStateStore(),
      postToRenderer: (message) => posted.push(message),
    });

    expect(posted).toEqual([]);
    expect(getGitAuthorEnv()).toEqual({
      GIT_AUTHOR_NAME: 'TeXRA Bot',
      GIT_AUTHOR_EMAIL: 'bot@example.com',
      GIT_COMMITTER_NAME: 'TeXRA Bot',
      GIT_COMMITTER_EMAIL: 'bot@example.com',
    });
    expect(
      settings.handleMessage({ command: SETTINGS_VIEW_COMMANDS.WEBVIEW_READY }),
    ).toBe(false);
    expect(posted).toEqual([]);
    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.WEBVIEW_READY,
        view: 'settings',
      }),
    ).toBe(false);
    expect(posted).toEqual([
      {
        command: SETTINGS_VIEW_COMMANDS.UPDATE_GIT_AUTHOR_SETTINGS,
        markCommits: DEFAULT_GIT_MARK_COMMITS,
        authorName: 'TeXRA Bot',
        authorEmail: 'bot@example.com',
        worktreeSupport: false,
      },
      {
        command: SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_CONFIG_VALUES,
        values: {},
      },
    ]);
  });

  it('round-trips Git author writes through workspace state and refreshes the renderer', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const workspaceState = new MemoryStateStore();
    const posted: unknown[] = [];

    const settings = createDesktopSettingsIpc({
      workspaceState,
      globalState: new MemoryStateStore(),
      postToRenderer: (message) => posted.push(message),
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_GIT_AUTHOR_NAME,
        name: 'Desktop TeXRA',
      }),
    ).toBe(true);
    await Promise.resolve();

    expect(workspaceState.values.get(WorkspaceStateKey.GIT_AUTHOR_NAME)).toBe(
      'Desktop TeXRA',
    );
    expect(posted.at(-1)).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_GIT_AUTHOR_SETTINGS,
      authorName: 'Desktop TeXRA',
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_GIT_MARK_COMMITS,
        enabled: false,
      }),
    ).toBe(true);
    await Promise.resolve();
    expect(workspaceState.values.get(WorkspaceStateKey.GIT_MARK_COMMITS)).toBe(
      false,
    );
    expect(getGitAuthorEnv()).toEqual({});

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_GIT_WORKTREE_SUPPORT,
        enabled: true,
      }),
    ).toBe(true);
    await Promise.resolve();
    expect(
      workspaceState.values.get(WorkspaceStateKey.GIT_WORKTREE_SUPPORT),
    ).toBe(true);
    expect(isWorktreeSupportEnabled()).toBe(true);
  });

  it('serves Git author read requests without reapplying process env', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const workspaceState = new MemoryStateStore();
    workspaceState.values.set(WorkspaceStateKey.GIT_AUTHOR_NAME, 'Applied');
    workspaceState.values.set(
      WorkspaceStateKey.GIT_AUTHOR_EMAIL,
      'applied@example.com',
    );
    const posted: unknown[] = [];

    const settings = createDesktopSettingsIpc({
      workspaceState,
      globalState: new MemoryStateStore(),
      postToRenderer: (message) => posted.push(message),
    });

    workspaceState.values.set(WorkspaceStateKey.GIT_AUTHOR_NAME, 'Read Only');
    workspaceState.values.set(
      WorkspaceStateKey.GIT_AUTHOR_EMAIL,
      'read@example.com',
    );

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.GET_GIT_AUTHOR_SETTINGS,
      }),
    ).toBe(true);
    expect(posted.at(-1)).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_GIT_AUTHOR_SETTINGS,
      authorName: 'Read Only',
      authorEmail: 'read@example.com',
    });
    expect(getGitAuthorEnv()).toEqual({
      GIT_AUTHOR_NAME: 'Applied',
      GIT_AUTHOR_EMAIL: 'applied@example.com',
      GIT_COMMITTER_NAME: 'Applied',
      GIT_COMMITTER_EMAIL: 'applied@example.com',
    });
  });

  it('serves storage-backed LaTeX config reads through workspace state', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const workspaceState = new MemoryStateStore();
    workspaceState.values.set(WorkspaceStateKey.WORKFLOW_AUTO_COMPILE, false);
    workspaceState.values.set(
      WorkspaceStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS,
      30_000,
    );
    workspaceState.values.set(WorkspaceStateKey.LATEXDIFF_TIMEOUT_MS, 5_000);
    workspaceState.values.set(WorkspaceStateKey.LATEXDIFF_MATH_MARKUP, 'fine');
    workspaceState.values.set(WorkspaceStateKey.LATEX_FORMATTER, 'tex-fmt');
    workspaceState.values.set('texra.invalidLatexValue', 'ignored');
    const posted: unknown[] = [];

    const settings = createDesktopSettingsIpc({
      workspaceState,
      globalState: new MemoryStateStore(),
      postToRenderer: (message) => posted.push(message),
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.GET_LATEX_CONFIG_VALUES,
      }),
    ).toBe(true);

    expect(posted.at(-1)).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_CONFIG_VALUES,
      values: {
        workflowAutoCompile: false,
        workflowAutoCompileTimeoutMs: 30_000,
        latexdiffTimeoutMs: 5_000,
        latexdiffMathMarkup: 'fine',
        latexFormatter: 'tex-fmt',
      },
    });
  });

  it('loads desktop LaTeX tooling status instead of leaving the tab spinning', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const posted: unknown[] = [];

    const settings = createDesktopSettingsIpc({
      workspaceState: new MemoryStateStore(),
      globalState: new MemoryStateStore(),
      detectLatexSettingsStatus: async () => ({
        outDir: true,
        autoRevealExclude: true,
        texDistributionInstalled: true,
        latexWorkshopInstalled: false,
        latexdiffInstalled: true,
        latexindentInstalled: false,
        texcountInstalled: true,
        imageProcessingInstalled: false,
        platform: 'darwin',
        pdflatexPath: '/Library/TeX/texbin/pdflatex',
        latexmkPath: '/Library/TeX/texbin/latexmk',
        latexdiffPath: '/opt/homebrew/bin/latexdiff',
        latexindentPath: null,
        texcountPath: '/opt/homebrew/bin/texcount',
        ghostscriptPath: null,
        graphicsmagickPath: null,
        packageManager: 'brew',
      }),
      postToRenderer: (message) => posted.push(message),
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.GET_LATEX_SETTINGS_STATUS,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(posted.at(-1)).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_SETTINGS_STATUS,
      settings: expect.objectContaining({
        platform: 'darwin',
        texDistributionInstalled: true,
        latexdiffInstalled: true,
      }),
    });
  });

  it('shows provider key rows and stores desktop API keys', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const secrets = new MemorySecrets();
    const posted: unknown[] = [];
    const infoMessages: string[] = [];
    let promptCalls = 0;

    const settings = createDesktopSettingsIpc({
      workspaceState: new MemoryStateStore(),
      globalState: new MemoryStateStore(),
      secrets,
      promptSecret: async () => {
        promptCalls += 1;
        return '  sk-test  ';
      },
      showInfoMessage: async (message) => {
        infoMessages.push(message);
      },
      postToRenderer: (message) => posted.push(message),
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.GET_PROFILE_DATA,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(posted.at(-1)).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE,
      providerKeyStatuses: expect.arrayContaining([
        expect.objectContaining({ provider: 'google', status: 'not-set' }),
      ]),
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_PROVIDER_KEY,
        provider: 'google',
        apiKey: '  sk-modal  ',
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(promptCalls).toBe(0);
    expect(secrets.values.get('apiKey.google')).toBe('sk-modal');
    expect(infoMessages).toEqual(['Google API key has been set']);
    expect(
      posted.findLast(
        (message) =>
          (message as { command?: string }).command ===
          SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE,
      ),
    ).toMatchObject({
      providerKeyStatuses: expect.arrayContaining([
        expect.objectContaining({ provider: 'google', status: 'set' }),
      ]),
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.REMOVE_PROVIDER_KEY,
        provider: 'google',
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(secrets.values.has('apiKey.google')).toBe(false);
    expect(infoMessages).toEqual([
      'Google API key has been set',
      'Google API key has been removed',
    ]);
  });

  it('falls back to the host secret prompt when no provider key is submitted', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const secrets = new MemorySecrets();

    const settings = createDesktopSettingsIpc({
      workspaceState: new MemoryStateStore(),
      globalState: new MemoryStateStore(),
      secrets,
      promptSecret: async () => '  sk-prompt  ',
      postToRenderer: () => {},
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_PROVIDER_KEY,
        provider: 'google',
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(secrets.values.get('apiKey.google')).toBe('sk-prompt');
  });

  it('delegates desktop sign-in without posting stale profile data', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const posted: unknown[] = [];
    let signInCalls = 0;

    const settings = createDesktopSettingsIpc({
      workspaceState: new MemoryStateStore(),
      globalState: new MemoryStateStore(),
      postToRenderer: (message) => posted.push(message),
      signIn: async () => {
        signInCalls += 1;
      },
    });

    expect(
      settings.handleMessage({ command: SETTINGS_VIEW_COMMANDS.SIGN_IN }),
    ).toBe(true);
    await flushAsyncWork();

    expect(signInCalls).toBe(1);
    expect(
      posted.some(
        (message) =>
          (message as { command?: string }).command ===
          SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE,
      ),
    ).toBe(false);
  });

  it('round-trips LaTeX config writes through workspace state and refreshes the renderer', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const workspaceState = new MemoryStateStore();
    const posted: unknown[] = [];

    const settings = createDesktopSettingsIpc({
      workspaceState,
      globalState: new MemoryStateStore(),
      postToRenderer: (message) => posted.push(message),
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_LATEX_CONFIG_VALUE,
        field: 'latexFormatter',
        value: 'none',
      }),
    ).toBe(true);
    await Promise.resolve();

    expect(workspaceState.values.get(WorkspaceStateKey.LATEX_FORMATTER)).toBe(
      'none',
    );
    expect(posted.at(-1)).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_CONFIG_VALUES,
      values: {
        latexFormatter: 'none',
      },
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_LATEX_CONFIG_VALUE,
        field: 'latexFormatter',
        value: null,
      }),
    ).toBe(true);
    await Promise.resolve();

    expect(workspaceState.values.get(WorkspaceStateKey.LATEX_FORMATTER)).toBe(
      undefined,
    );
    expect(workspaceState.values.has(WorkspaceStateKey.LATEX_FORMATTER)).toBe(
      false,
    );
    expect(posted.at(-1)).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_CONFIG_VALUES,
      values: {},
    });
  });

  it('reports invalid LaTeX config writes without mutating workspace state', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const workspaceState = new MemoryStateStore();
    const posted: unknown[] = [];
    const errors: unknown[] = [];

    const settings = createDesktopSettingsIpc({
      workspaceState,
      globalState: new MemoryStateStore(),
      postToRenderer: (message) => posted.push(message),
      onError: (error) => errors.push(error),
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_LATEX_CONFIG_VALUE,
        field: 'latexdiffTimeoutMs',
        value: 100,
      }),
    ).toBe(true);
    await Promise.resolve();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      message: 'Invalid LaTeX config value for latexdiffTimeoutMs',
    });
    expect(
      workspaceState.values.has(WorkspaceStateKey.LATEXDIFF_TIMEOUT_MS),
    ).toBe(false);
    expect(posted).toEqual([]);
  });

  it('persists model settings through global state', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const workspaceState = new MemoryStateStore();
    const globalState = new MemoryStateStore();
    globalState.values.set(GlobalStateKey.ENABLED_MODELS, [
      'gpt55',
      'sonnet46T',
    ]);
    globalState.values.set(
      GlobalStateKey.MODEL_LIST_VERSION,
      MODEL_LIST_VERSION,
    );
    globalState.values.set(GlobalStateKey.HELPER_MODEL, 'gpt55');
    const posted: unknown[] = [];
    const errors: unknown[] = [];

    const settings = createDesktopSettingsIpc({
      workspaceState,
      globalState,
      postToRenderer: (message) => posted.push(message),
      onError: (error) => errors.push(error),
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_MODEL_ENABLED,
        modelName: 'gpt55',
        enabled: false,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(globalState.values.get(GlobalStateKey.ENABLED_MODELS)).toEqual([
      'sonnet46T',
    ]);
    expect(globalState.values.get(GlobalStateKey.HELPER_MODEL)).toBe(
      'sonnet46T',
    );
    expect(errors).toEqual([]);
    expect(
      posted.findLast(
        (message) =>
          (message as { command?: string }).command ===
          SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
      ),
    ).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
      helperModel: 'sonnet46T',
    });
    const modelOptionsMessage = posted.at(-1) as {
      command?: string;
      optionsData?: Array<{ value?: string }>;
    };
    expect(modelOptionsMessage.command).toBe('setModelOptions');
    expect(modelOptionsMessage.optionsData).toContainEqual(
      expect.objectContaining({
        value: 'sonnet46T',
      }),
    );

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_PREFER_SHORT_MODEL_NAMES,
        enabled: true,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(
      globalState.values.get(GlobalStateKey.PREFER_SHORT_MODEL_NAMES),
    ).toBe(true);
    expect(posted.at(-1)).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
      preferShortModelNames: true,
    });
  });

  it('loads desktop tool dashboard and approval settings on settings readiness', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const workspaceState = new MemoryStateStore();
    workspaceState.values.set(
      WorkspaceStateKey.CODEX_SANDBOX_MODE,
      'danger-full-access',
    );
    const config = new MemoryConfigStore();
    config.values.set('texra.toolUse.requireBashApproval', false);
    const posted: unknown[] = [];

    const settings = createDesktopSettingsIpc({
      workspaceState,
      globalState: new MemoryStateStore(),
      config,
      sendStartupCatalogData: true,
      loadAgents: async () => undefined,
      getCustomAgentDirectory: async () => '',
      buildToolDashboardItems: async () => [
        {
          id: 'file-ops',
          name: 'File & Shell Operations',
          category: 'file',
          description: 'Built-in file tools',
          tools: [],
          status: 'available',
          requiresSetup: false,
        },
      ],
      detectLatexSettingsStatus: async () => ({
        outDir: true,
        autoRevealExclude: true,
        texDistributionInstalled: false,
        latexWorkshopInstalled: false,
        latexdiffInstalled: false,
        latexindentInstalled: false,
        texcountInstalled: false,
        imageProcessingInstalled: false,
        platform: 'linux',
        pdflatexPath: null,
        latexmkPath: null,
        latexdiffPath: null,
        latexindentPath: null,
        texcountPath: null,
        ghostscriptPath: null,
        graphicsmagickPath: null,
        packageManager: null,
      }),
      postToRenderer: (message) => posted.push(message),
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.WEBVIEW_READY,
        view: 'settings',
      }),
    ).toBe(false);
    await flushAsyncWork();

    expect(
      posted.find(
        (message) =>
          (message as { command?: string }).command ===
          SETTINGS_VIEW_COMMANDS.UPDATE_APPROVAL_SETTINGS,
      ),
    ).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_APPROVAL_SETTINGS,
      bashApprovalEnabled: false,
      codexSandboxMode: 'danger-full-access',
    });
    expect(
      posted.find(
        (message) =>
          (message as { command?: string }).command ===
          SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
      ),
    ).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
      items: [expect.objectContaining({ id: 'file-ops' })],
    });
  });

  it('does not delay unrelated startup settings behind model-list refresh', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const modelListRefresh = createDeferred();
    const posted: unknown[] = [];

    const settings = createDesktopSettingsIpc({
      workspaceState: new MemoryStateStore(),
      globalState: new MemoryStateStore(),
      config: new MemoryConfigStore(),
      sendStartupCatalogData: true,
      modelListRefresh: modelListRefresh.promise,
      postToRenderer: (message) => posted.push(message),
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.WEBVIEW_READY,
        view: 'settings',
      }),
    ).toBe(false);
    await flushAsyncWork();

    expect(
      posted.some(
        (message) =>
          (message as { command?: string }).command ===
          SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
      ),
    ).toBe(false);
    expect(
      posted.find(
        (message) =>
          (message as { command?: string }).command ===
          SETTINGS_VIEW_COMMANDS.UPDATE_APPROVAL_SETTINGS,
      ),
    ).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_APPROVAL_SETTINGS,
    });

    modelListRefresh.resolve();
    await flushAsyncWork();

    expect(
      posted.find(
        (message) =>
          (message as { command?: string }).command ===
          SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
      ),
    ).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
    });
  });

  it('handles desktop tool dashboard refreshes and toggles', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const globalState = new MemoryStateStore();
    const posted: unknown[] = [];
    let refreshCount = 0;
    const buildCalls: unknown[][] = [];

    const settings = createDesktopSettingsIpc({
      workspaceState: new MemoryStateStore(),
      globalState,
      config: new MemoryConfigStore(),
      buildToolDashboardItems: async (cachedResults = []) => {
        buildCalls.push(cachedResults);
        return [
          {
            id: 'zotero',
            name: 'Zotero Integration',
            category: 'academic',
            description: 'Citation tools',
            tools: [],
            status: 'available',
            requiresSetup: true,
            toggleable: true,
            enabled: !(
              globalState.values.get(GlobalStateKey.DISABLED_TOOLS) as
                | string[]
                | undefined
            )?.includes('zotero'),
          },
        ];
      },
      refreshToolAvailability: async () => {
        refreshCount++;
      },
      postToRenderer: (message) => posted.push(message),
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.GET_TOOL_DASHBOARD_DATA,
      }),
    ).toBe(true);
    await flushAsyncWork();
    expect(posted.at(-1)).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
      items: [expect.objectContaining({ id: 'zotero', enabled: true })],
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.TOGGLE_TOOL,
        toolId: 'zotero',
        enabled: false,
      }),
    ).toBe(true);
    await flushAsyncWork();
    expect(globalState.values.get(GlobalStateKey.DISABLED_TOOLS)).toEqual([
      'zotero',
    ]);
    expect(posted.at(-1)).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
      items: [expect.objectContaining({ id: 'zotero', enabled: false })],
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.RECHECK_TOOL_STATUS,
      }),
    ).toBe(true);
    await flushAsyncWork();
    expect(refreshCount).toBe(1);
    expect(buildCalls.length).toBeGreaterThanOrEqual(3);
  });

  it('refreshes launcher agent options after agent visibility changes', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const workspaceState = new MemoryStateStore();
    const posted: unknown[] = [];

    const settings = createDesktopSettingsIpc({
      workspaceState,
      globalState: new MemoryStateStore(),
      loadAgents: async () => undefined,
      loadAgentOptionsData: async () => ({
        workflow: [{ value: 'builtInWorkflow:correct', label: 'correct' }],
        toolUse: [],
      }),
      postToRenderer: (message) => posted.push(message),
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_AGENT_ENABLED,
        category: 'workflow',
        agentSource: 'builtInWorkflow',
        agentName: 'polish',
        enabled: false,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(workspaceState.values.get(WorkspaceStateKey.ENABLED_AGENTS)).toEqual(
      expect.not.arrayContaining(['builtInWorkflow:polish', 'polish']),
    );
    expect(
      posted.some(
        (message) =>
          (message as { command?: string }).command ===
          SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION,
      ),
    ).toBe(true);
    expect(
      posted.some(
        (message) =>
          (message as { command?: string }).command ===
          MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
      ),
    ).toBe(true);
  });

  it('persists desktop API access mode changes before refreshing settings data', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const posted: unknown[] = [];
    const persistedModes: string[] = [];

    const settings = createDesktopSettingsIpc({
      workspaceState: new MemoryStateStore(),
      globalState: new MemoryStateStore(),
      postToRenderer: (message) => posted.push(message),
      setApiAccessMode: async (mode) => {
        persistedModes.push(mode);
      },
      getAuthProfileData: async () => ({
        authenticated: false,
        user: null,
        tier: 'free',
        permissions: [],
        remoteAgents: [],
        apiAccessMode: 'personal',
        allowedModels: [],
        accessExpiresAt: null,
      }),
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_API_ACCESS_MODE,
        mode: 'personal',
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(persistedModes).toEqual(['personal']);
    expect(
      posted.some(
        (message) =>
          (message as { command?: string }).command ===
          SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE,
      ),
    ).toBe(true);
    expect(
      posted.some(
        (message) =>
          (message as { command?: string }).command ===
          SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
      ),
    ).toBe(true);
  });

  it('clears OpenRouter routing when desktop users enable included access', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const globalState = new MemoryStateStore();
    globalState.values.set(GlobalStateKey.USE_OPENROUTER, true);
    const persistedModes: string[] = [];

    const settings = createDesktopSettingsIpc({
      workspaceState: new MemoryStateStore(),
      globalState,
      postToRenderer: () => {},
      setApiAccessMode: async (mode) => {
        persistedModes.push(mode);
      },
      getAuthProfileData: async () => ({
        authenticated: false,
        user: null,
        tier: 'free',
        permissions: [],
        remoteAgents: [],
        apiAccessMode: 'personal',
        allowedModels: [],
        accessExpiresAt: null,
      }),
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_API_ACCESS_MODE,
        mode: 'included',
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(persistedModes).toEqual(['included']);
    expect(globalState.values.get(GlobalStateKey.USE_OPENROUTER)).toBe(false);
  });

  it('refreshes agent and model options after desktop auth changes', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const posted: unknown[] = [];
    let loadCount = 0;

    const settings = createDesktopSettingsIpc({
      workspaceState: new MemoryStateStore(),
      globalState: new MemoryStateStore(),
      postToRenderer: (message) => posted.push(message),
      loadAgents: async () => {
        loadCount += 1;
      },
      loadAgentOptionsData: async () => ({
        workflow: [{ name: 'remote-workflow' }],
        toolUse: [{ name: 'remote-tool' }],
      }),
      getAuthProfileData: async () => ({
        authenticated: true,
        user: { email: 'user@example.com', id: 'user-1' },
        tier: 'free',
        permissions: [],
        remoteAgents: [],
        apiAccessMode: 'included',
        allowedModels: [],
        accessExpiresAt: null,
      }),
    });

    await settings.refreshAuthDependentData();

    expect(loadCount).toBe(1);
    expect(
      posted.map((message) => (message as { command?: string }).command),
    ).toEqual(
      expect.arrayContaining([
        SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE,
        SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION,
        SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
        MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
        MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
      ]),
    );
  });

  it('refreshes persisted model list on desktop startup', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const globalState = new MemoryStateStore();
    globalState.values.set(GlobalStateKey.MODEL_LIST_VERSION, 12);
    globalState.values.set(GlobalStateKey.ENABLED_MODELS, [
      'custom-model',
      'gpt54pro',
      'opus46T',
    ]);
    const errors: unknown[] = [];

    createDesktopSettingsIpc({
      workspaceState: new MemoryStateStore(),
      globalState,
      postToRenderer: () => {},
      onError: (error) => errors.push(error),
    });
    await flushAsyncWork();

    expect(errors).toEqual([]);
    expect(globalState.values.get(GlobalStateKey.MODEL_LIST_VERSION)).toBe(
      MODEL_LIST_VERSION,
    );
    const expectedDefaults = DEFAULT_MODELS.filter(
      (model) => !(MODEL_CONFIGS[model]?.deprecated ?? false),
    );
    expect(globalState.values.get(GlobalStateKey.ENABLED_MODELS)).toEqual([
      'custom-model',
      ...expectedDefaults,
    ]);
  });

  it('waits for desktop model-list refresh before serving model selection', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const refreshGate = createDeferred();
    const globalState = new (class extends MemoryStateStore {
      override async update(key: string, value: unknown): Promise<void> {
        if (key === GlobalStateKey.ENABLED_MODELS) {
          await refreshGate.promise;
        }
        await super.update(key, value);
      }
    })();
    globalState.values.set(GlobalStateKey.MODEL_LIST_VERSION, 12);
    globalState.values.set(GlobalStateKey.ENABLED_MODELS, ['custom-model']);
    const posted: unknown[] = [];

    const settings = createDesktopSettingsIpc({
      workspaceState: new MemoryStateStore(),
      globalState,
      postToRenderer: (message) => posted.push(message),
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.GET_MODEL_SELECTION,
      }),
    ).toBe(true);
    await Promise.resolve();

    expect(posted).toEqual([]);

    refreshGate.resolve();
    await flushAsyncWork();

    expect(globalState.values.get(GlobalStateKey.MODEL_LIST_VERSION)).toBe(
      MODEL_LIST_VERSION,
    );
    expect(
      (posted.at(-1) as { command?: string; models?: Array<{ name: string }> })
        .command,
    ).toBe(SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION);
    expect(
      (posted.at(-1) as { models?: Array<{ name: string }> }).models,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: DEFAULT_MODELS[0] }),
      ]),
    );
  });

  it('does not duplicate profile refresh after delegated desktop sign-out', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const posted: unknown[] = [];
    let signOutCalls = 0;

    const settings = createDesktopSettingsIpc({
      workspaceState: new MemoryStateStore(),
      globalState: new MemoryStateStore(),
      postToRenderer: (message) => posted.push(message),
      signOut: async () => {
        signOutCalls += 1;
      },
      getAuthProfileData: async () => ({
        authenticated: false,
        user: null,
        tier: 'free',
        permissions: [],
        remoteAgents: [],
        apiAccessMode: 'personal',
        allowedModels: [],
        accessExpiresAt: null,
      }),
    });

    expect(
      settings.handleMessage({ command: SETTINGS_VIEW_COMMANDS.SIGN_OUT }),
    ).toBe(true);
    await flushAsyncWork();

    expect(signOutCalls).toBe(1);
    expect(
      posted.filter(
        (message) =>
          (message as { command?: string }).command ===
          SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE,
      ),
    ).toEqual([]);
  });

  it('ignores unsupported or malformed settings messages', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const posted: unknown[] = [];
    const settings = createDesktopSettingsIpc({
      workspaceState: new MemoryStateStore(),
      globalState: new MemoryStateStore(),
      postToRenderer: (message) => posted.push(message),
    });

    expect(settings.handleMessage({ command: 'unknown' })).toBe(false);
    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_GIT_AUTHOR_NAME,
      }),
    ).toBe(false);
    expect(posted).toEqual([]);
  });
});
