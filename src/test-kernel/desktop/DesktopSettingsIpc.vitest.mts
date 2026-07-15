import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '@test/support/FakePlatform';
import { MODEL_LIST_VERSION } from '@model/modelOptionsBasic';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { LatexSettingsStatus } from '@shared/schemas/settingsViewMessages';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import { DEFAULT_GIT_MARK_COMMITS } from '@shared/constants/git';
import { HOMEBREW_INSTALL_COMMAND } from '@shared/constants/latex';
import {
  isWorktreeSupportEnabled,
  setWorktreeSupportEnabled,
} from '@utils/config/worktreeConfig';
import { getGitAuthorEnv, setGitAuthorEnv } from '@utils/system/gitAuthorEnv';

import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';
import {
  createStubDesktopAgentSettingsController,
  createStubDesktopCredentialSettingsController,
  createStubDesktopHistoryOptions,
} from './desktopSettingsTestSupport';
import type { StateStore } from '@platform/interfaces';

const computeModelOptionsData = vi.hoisted(() =>
  vi.fn(async (models: readonly string[] = []) =>
    models.map((model) => ({ value: model, label: model })),
  ),
);

vi.mock('@model/computeModelOptions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@model/computeModelOptions')>()),
  computeModelOptionsData,
  invalidateModelOptionsCache: vi.fn(),
}));

type DesktopSettingsIpcModule =
  typeof import('@desktop/main/desktopSettingsIpc');

type DesktopSettingsIpcOptions = Parameters<
  DesktopSettingsIpcModule['createDesktopSettingsIpc']
>[0];
type DesktopHistoryOptions = ReturnType<typeof createStubDesktopHistoryOptions>;

type RendererMessage = Parameters<
  DesktopSettingsIpcOptions['postToRenderer']
>[0];

type SettingsFixtureOverrides = Omit<
  Partial<DesktopSettingsIpcOptions>,
  | 'agentSettingsController'
  | 'credentialSettingsController'
  | 'postToRenderer'
  | keyof DesktopHistoryOptions
> & {
  agentSettingsController?: DesktopSettingsIpcOptions['agentSettingsController'];
  credentialSettingsController?: DesktopSettingsIpcOptions['credentialSettingsController'];
  history?: Partial<DesktopHistoryOptions>;
  postToRenderer?: DesktopSettingsIpcOptions['postToRenderer'];
};

type CapturedSettingsFixtureOverrides = Omit<
  SettingsFixtureOverrides,
  'postToRenderer'
>;

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
  // Only recorded when a call site passes an explicit target -- do not
  // default this, or a call site that forgets to pass `target` would still
  // read back as 'workspace' and mask the exact scope-mismatch regression
  // this store exists to catch (see issue #7085).
  readonly updateTargets = new Map<string, 'global' | 'workspace'>();

  get<T>(key: string, defaultValue?: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }

  async update<T>(
    key: string,
    value: T,
    target?: 'global' | 'workspace',
  ): Promise<void> {
    if (target === undefined) {
      this.updateTargets.delete(key);
    } else {
      this.updateTargets.set(key, target);
    }
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

  async getStored(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async listStoredKeys(): Promise<readonly string[]> {
    return [...this.values.keys()];
  }

  getEnv(): string | undefined {
    return undefined;
  }
}

async function loadDesktopSettingsIpc(): Promise<DesktopSettingsIpcModule> {
  return import(
    moduleFileUrl(desktopSourcePath('main', 'desktopSettingsIpc.ts'))
  ) as Promise<DesktopSettingsIpcModule>;
}

let createDesktopSettingsIpc!: DesktopSettingsIpcModule['createDesktopSettingsIpc'];

function createSettingsFixture(overrides: SettingsFixtureOverrides = {}) {
  const { history, ...settingsOverrides } = overrides;
  const globalState = overrides.globalState ?? new MemoryStateStore();
  const workspaceState = overrides.workspaceState ?? new MemoryStateStore();
  const settings = createDesktopSettingsIpc({
    ...settingsOverrides,
    ...createStubDesktopHistoryOptions(history),
    agentSettingsController:
      overrides.agentSettingsController ??
      createStubDesktopAgentSettingsController(),
    credentialSettingsController:
      overrides.credentialSettingsController ??
      createStubDesktopCredentialSettingsController({
        globalState,
        workspaceState,
      }),
    globalState,
    postToRenderer: overrides.postToRenderer ?? (() => undefined),
    workspaceState,
  });
  return { globalState, settings, workspaceState };
}

function createCapturedSettingsFixture(
  overrides: CapturedSettingsFixtureOverrides = {},
) {
  const posted: RendererMessage[] = [];
  const fixture = createSettingsFixture({
    ...overrides,
    postToRenderer: (message) => posted.push(message),
  });
  return { ...fixture, posted };
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

function commandOf(message: unknown): string | undefined {
  return (message as { command?: string }).command;
}

function inactiveLatexSettingsStatus(): LatexSettingsStatus {
  return {
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
  };
}

describe('desktop settings IPC', () => {
  beforeAll(async () => {
    ({ createDesktopSettingsIpc } = await loadDesktopSettingsIpc());
  });

  afterEach(() => {
    vi.clearAllMocks();
    setGitAuthorEnv({});
    setWorktreeSupportEnabled(false);
  });

  it('applies Git author settings on creation and posts only for settings readiness', async () => {
    const workspaceState = new MemoryStateStore();
    workspaceState.values.set(WorkspaceStateKey.GIT_AUTHOR_NAME, 'TeXRA Bot');
    workspaceState.values.set(
      WorkspaceStateKey.GIT_AUTHOR_EMAIL,
      'bot@example.com',
    );

    const { settings, posted } = createCapturedSettingsFixture({
      workspaceState,
    });

    expect(posted).toEqual([]);
    expect(getGitAuthorEnv()).toEqual({
      GIT_AUTHOR_NAME: 'TeXRA Bot',
      GIT_AUTHOR_EMAIL: 'bot@example.com',
      GIT_COMMITTER_NAME: 'TeXRA Bot',
      GIT_COMMITTER_EMAIL: 'bot@example.com',
    });
    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.WEBVIEW_READY,
      }),
    ).toBe(false);
    expect(posted).toEqual([]);
    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.WEBVIEW_READY,
        view: 'settings',
      }),
    ).toBe(false);
    // First post is the derived capability broadcast (commands this host's
    // registry declares `unsupported(...)`); asserted structurally rather
    // than as an exact list so it doesn't need updating every time a
    // command's per-host support decision changes.
    expect(posted[0]).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.SET_UNSUPPORTED_COMMANDS,
      commands: expect.arrayContaining([
        SETTINGS_VIEW_COMMANDS.OPEN_VSCODE_SETTINGS,
      ]),
    });
    expect(posted.slice(1)).toEqual([
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
      {
        command: SETTINGS_VIEW_COMMANDS.UPDATE_GOAL_LIST,
        items: [],
      },
    ]);
  }, 15_000);

  it('delegates agent-selection commands to the required controller', async () => {
    const baseController = createStubDesktopAgentSettingsController();
    const setEnabled = vi.fn(async () => undefined);
    const agentSettingsController = {
      ...baseController,
      actions: { ...baseController.actions, setEnabled },
    };
    const { settings } = createSettingsFixture({ agentSettingsController });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_AGENT_ENABLED,
        category: 'workflow',
        agentSource: 'custom',
        agentName: 'proofreader',
        enabled: false,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(setEnabled).toHaveBeenCalledWith({
      category: 'workflow',
      source: 'custom',
      name: 'proofreader',
      enabled: false,
    });
  });

  it('round-trips Git author writes through workspace state and refreshes the renderer', async () => {
    const workspaceState = new MemoryStateStore();

    const { settings, posted } = createCapturedSettingsFixture({
      workspaceState,
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

  it('round-trips desktop crash reporting settings through global state and secrets', async () => {
    const globalState = new MemoryStateStore();
    const secrets = new MemorySecrets();

    let initializeCalls = 0;

    const { settings, posted } = createCapturedSettingsFixture({
      globalState,
      secrets,
      promptSecret: async () => ' https://example.invalid/123 ',
      initializeCrashReporting: async () => {
        initializeCalls += 1;
      },
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_DESKTOP_CRASH_REPORTING_ENABLED,
        enabled: true,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(
      globalState.values.get(GlobalStateKey.DESKTOP_CRASH_REPORTING_ENABLED),
    ).toBe(true);
    expect(posted.at(-1)).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_DESKTOP_CRASH_REPORTING,
      enabled: true,
      configured: false,
    });
    expect(initializeCalls).toBe(0);

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_DESKTOP_CRASH_REPORTING_DSN,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(posted.at(-1)).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_DESKTOP_CRASH_REPORTING,
      enabled: true,
      configured: true,
    });
    expect(initializeCalls).toBe(1);
  });

  it('initializes desktop crash reporting when users enable an existing DSN', async () => {
    const globalState = new MemoryStateStore();
    const secrets = new MemorySecrets();
    await secrets.set(
      'texra.desktop.crashReporting.dsn',
      'https://example.invalid/123',
    );
    let initializeCalls = 0;

    const { settings } = createSettingsFixture({
      globalState,
      secrets,
      initializeCrashReporting: async () => {
        initializeCalls += 1;
      },
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_DESKTOP_CRASH_REPORTING_ENABLED,
        enabled: true,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(initializeCalls).toBe(1);
  });

  it('serves the goal list instead of the desktop "not available" stub (issue #7751 FS6)', async () => {
    const { settings, posted } = createCapturedSettingsFixture();

    // Was previously declared unsupported and appeared in the derived
    // capability broadcast (SET_UNSUPPORTED_COMMANDS); the fix removes it.
    settings.handleMessage({
      command: SETTINGS_VIEW_COMMANDS.WEBVIEW_READY,
      view: 'settings',
    });
    const capabilities = posted[0] as { commands?: string[] };
    expect(capabilities.commands).not.toContain(
      SETTINGS_VIEW_COMMANDS.GET_GOAL_LIST,
    );
    posted.length = 0;

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.GET_GOAL_LIST,
      }),
    ).toBe(true);

    expect(posted.at(-1)).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_GOAL_LIST,
      items: [],
    });
  });

  it('routes revealGoalStream to the window-owned progress bridge (issue #7751 FS6)', async () => {
    const revealed: string[] = [];

    const { settings } = createSettingsFixture({
      revealStream: async (streamId) => {
        revealed.push(streamId);
      },
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.REVEAL_GOAL_STREAM,
        streamId: 'goal-owning-stream',
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(revealed).toEqual(['goal-owning-stream']);
  });

  it('runs allowlisted LaTeX install commands through the desktop host', async () => {
    const commands: string[] = [];

    const { settings } = createSettingsFixture({
      runInstallCommand: async (command) => {
        commands.push(command);
      },
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.RUN_INSTALL_COMMAND,
        installCommand: HOMEBREW_INSTALL_COMMAND,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(commands).toEqual([HOMEBREW_INSTALL_COMMAND]);
  });

  it('rejects unknown desktop LaTeX install commands', async () => {
    const commands: string[] = [];
    const errors: unknown[] = [];

    const { settings } = createSettingsFixture({
      runInstallCommand: async (command) => {
        commands.push(command);
      },
      onError: (error) => errors.push(error),
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.RUN_INSTALL_COMMAND,
        installCommand: 'echo not-allowlisted',
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(commands).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      message: 'Rejected unknown install command: echo not-allowlisted',
    });
  });

  it('delegates profile and ChatGPT commands to the credential controller', async () => {
    const state = {
      globalState: new MemoryStateStore(),
      workspaceState: new MemoryStateStore(),
    };
    const setProviderKey = vi.fn(async () => undefined);
    const signIn = vi.fn(async () => undefined);
    const signOut = vi.fn(async () => undefined);
    const setPreferSubscription = vi.fn(async () => undefined);
    const stub = createStubDesktopCredentialSettingsController(state);
    const credentialSettingsController =
      createStubDesktopCredentialSettingsController(state, {
        profileActions: {
          ...stub.profileActions,
          signIn,
          signOut,
          setProviderKey,
        },
        chatGptActions: {
          ...stub.chatGptActions,
          setPreferSubscription,
        },
      });
    const { settings } = createSettingsFixture({
      ...state,
      credentialSettingsController,
    });

    expect(
      settings.handleMessage({ command: SETTINGS_VIEW_COMMANDS.SIGN_IN }),
    ).toBe(true);
    expect(
      settings.handleMessage({ command: SETTINGS_VIEW_COMMANDS.SIGN_OUT }),
    ).toBe(true);
    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_PROVIDER_KEY,
        provider: 'google',
        apiKey: 'sk-test',
      }),
    ).toBe(true);
    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_CHATGPT_PREFER_SUBSCRIPTION,
        enabled: true,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(signIn).toHaveBeenCalledOnce();
    expect(signOut).toHaveBeenCalledOnce();
    expect(setProviderKey).toHaveBeenCalledWith('google', 'sk-test');
    expect(setPreferSubscription).toHaveBeenCalledWith(true);
  });

  it('round-trips LaTeX config writes through workspace state and refreshes the renderer', async () => {
    const workspaceState = new MemoryStateStore();

    const { settings, posted } = createCapturedSettingsFixture({
      workspaceState,
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
    const workspaceState = new MemoryStateStore();

    const errors: unknown[] = [];

    const { settings, posted } = createCapturedSettingsFixture({
      workspaceState,
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

    const errors: unknown[] = [];
    const postMainModelOptionsData = vi.fn(async () => undefined);
    const credentialSettingsController =
      createStubDesktopCredentialSettingsController(
        { globalState, workspaceState },
        { postMainModelOptionsData },
      );

    const { settings, posted } = createCapturedSettingsFixture({
      workspaceState,
      globalState,
      credentialSettingsController,
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
          commandOf(message) === SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
      ),
    ).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
      helperModel: 'sonnet46T',
    });
    expect(postMainModelOptionsData).toHaveBeenCalledOnce();

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
    const workspaceState = new MemoryStateStore();
    workspaceState.values.set(
      WorkspaceStateKey.CODEX_SANDBOX_MODE,
      'danger-full-access',
    );
    const config = new MemoryConfigStore();
    config.values.set('texra.toolUse.requireBashApproval', false);
    const agentSettingsController = createStubDesktopAgentSettingsController();
    const postStartupData = vi.fn(async () => undefined);
    agentSettingsController.postStartupData = postStartupData;

    const { settings, posted } = createCapturedSettingsFixture({
      agentSettingsController,
      workspaceState,
      config,
      sendStartupCatalogData: true,
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
      detectLatexSettingsStatus: async () => inactiveLatexSettingsStatus(),
      onError: () => undefined,
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.WEBVIEW_READY,
        view: 'settings',
      }),
    ).toBe(false);
    await flushAsyncWork();

    expect(postStartupData).toHaveBeenCalledOnce();

    expect(
      posted.find(
        (message) =>
          commandOf(message) ===
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
          commandOf(message) === SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
      ),
    ).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
      items: [expect.objectContaining({ id: 'file-ops' })],
    });
  });

  it('writes the bash-approval toggle to the workspace config scope, not global', async () => {
    const config = new MemoryConfigStore();

    const { settings, posted } = createCapturedSettingsFixture({
      config,
      detectLatexSettingsStatus: async () => inactiveLatexSettingsStatus(),
      onError: () => undefined,
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_BASH_APPROVAL_ENABLED,
        enabled: false,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(config.values.get('texra.toolUse.requireBashApproval')).toBe(false);
    // Security-adjacent scope pin: a per-workspace approval bypass must never
    // be written to the global config target (see issue #7085).
    expect(config.updateTargets.get('texra.toolUse.requireBashApproval')).toBe(
      'workspace',
    );
    expect(
      posted.find(
        (message) =>
          commandOf(message) ===
          SETTINGS_VIEW_COMMANDS.UPDATE_APPROVAL_SETTINGS,
      ),
    ).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_APPROVAL_SETTINGS,
      bashApprovalEnabled: false,
    });
  });

  it('does not delay unrelated startup settings behind model-list refresh', async () => {
    const modelListRefresh = createDeferred();
    const state = {
      globalState: new MemoryStateStore(),
      workspaceState: new MemoryStateStore(),
    };
    const credentialSettingsController =
      createStubDesktopCredentialSettingsController(state, {
        prepareModelSelectionData: () => modelListRefresh.promise,
      });

    const { settings, posted } = createCapturedSettingsFixture({
      ...state,
      config: new MemoryConfigStore(),
      sendStartupCatalogData: true,
      credentialSettingsController,
      buildToolDashboardItems: async () => [],
      detectLatexSettingsStatus: async () => inactiveLatexSettingsStatus(),
      onError: () => undefined,
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
          commandOf(message) === SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
      ),
    ).toBe(false);
    expect(
      posted.find(
        (message) =>
          commandOf(message) ===
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
          commandOf(message) === SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
      ),
    ).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
    });
  });

  it('handles desktop tool dashboard refreshes and toggles', async () => {
    const globalState = new MemoryStateStore();

    let refreshCount = 0;
    const buildCalls: unknown[][] = [];

    const { settings, posted } = createCapturedSettingsFixture({
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
                string[] | undefined
            )?.includes('zotero'),
          },
        ];
      },
      refreshToolAvailability: async () => {
        refreshCount++;
      },
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
    expect(buildCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('refreshes credentials before conditionally refreshing the agent catalog', async () => {
    const state = {
      globalState: new MemoryStateStore(),
      workspaceState: new MemoryStateStore(),
    };
    const events: string[] = [];
    const refreshAuthDependentData = vi.fn(async () => {
      events.push('credentials');
    });
    const credentialSettingsController =
      createStubDesktopCredentialSettingsController(state, {
        refreshAuthDependentData,
      });
    const agentSettingsController = createStubDesktopAgentSettingsController();
    agentSettingsController.refreshCatalogData = vi.fn(async () => {
      events.push('agents');
    });
    const { settings } = createSettingsFixture({
      ...state,
      agentSettingsController,
      credentialSettingsController,
    });

    await settings.refreshAuthDependentData();

    expect(events).toEqual(['credentials', 'agents']);

    events.length = 0;
    await settings.refreshAuthDependentData({
      deferAgentCatalogRefresh: true,
    });

    expect(events).toEqual(['credentials']);
    expect(refreshAuthDependentData).toHaveBeenCalledTimes(2);
    expect(refreshAuthDependentData).toHaveBeenLastCalledWith();
    expect(agentSettingsController.refreshCatalogData).toHaveBeenCalledOnce();
  });

  it('handles desktop memory toggle messages', async () => {
    const globalState = new MemoryStateStore();

    const { settings, posted } = createCapturedSettingsFixture({
      globalState,
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_MEMORY_ENABLED,
        enabled: false,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(globalState.values.get(GlobalStateKey.MEMORY_ENABLED)).toBe(false);
    expect(posted.at(-1)).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_ENABLED,
      enabled: false,
    });
  });

  it('reruns an agent from history through the shared runAgent path', async () => {
    const { clearStoreCache, getExecutionStore } =
      await import('@agent/storage');
    const { AgentConfigSchema } =
      await import('@agent/core/definition/AgentConfig');
    const { AgentCategory } = await import('@shared/schemas/agent');
    const { installPlatform } = await import('@test/support/setupPlatform');

    clearStoreCache();
    await installPlatform();

    const historyId = 'aaaa1111';
    const config = AgentConfigSchema.parse({
      agent: 'chat',
      model: 'deepseekT',
      instruction: 'Check a proof.',
      agentCategory: AgentCategory.ToolUse,
    });
    await getExecutionStore(historyId).writeConfig(config);

    const infos: string[] = [];
    const runRequests: unknown[] = [];
    const { settings } = createSettingsFixture({
      showInfoMessage: async (message) => {
        infos.push(message);
      },
      history: {
        runExecution: async (request) => {
          runRequests.push(request);
        },
      },
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.RERUN_AGENT,
        historyId,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(infos).toEqual(['Rerunning agent from history']);
    expect(runRequests).toEqual([{ config, executionId: undefined }]);
  });

  it('ignores unsupported or malformed settings messages', async () => {
    const { settings, posted } = createCapturedSettingsFixture();

    expect(settings.handleMessage({ command: 'unknown' })).toBe(false);
    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_GIT_AUTHOR_NAME,
      }),
    ).toBe(false);
    expect(posted).toEqual([]);
  });
});
