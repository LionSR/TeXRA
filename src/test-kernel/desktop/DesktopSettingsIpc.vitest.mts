import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

import { createFakePlatform } from '@test/support/FakePlatform';
import { DEFAULT_MODELS, MODEL_LIST_VERSION } from '@model/modelOptionsBasic';
import { MAIN_VIEW_COMMANDS, SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { LatexSettingsStatus } from '@shared/schemas/settingsViewMessages';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import { DEFAULT_GIT_MARK_COMMITS } from '@shared/constants/git';
import { HOMEBREW_INSTALL_COMMAND } from '@shared/constants/latex';
import {
  isWorktreeSupportEnabled,
  setWorktreeSupportEnabled,
} from '@tools/worktreeConfig';
import { getGitAuthorEnv, setGitAuthorEnv } from '@utils/system/gitAuthorEnv';

import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';
import type { StateStore } from '@platform/interfaces';

const invalidateModelOptionsCache = vi.hoisted(() => vi.fn());
const computeModelOptionsData = vi.hoisted(() =>
  vi.fn(async (models: readonly string[] = []) =>
    models.map((model) => ({ value: model })),
  ),
);

vi.mock('@model/computeModelOptions', () => ({
  computeModelOptionsData,
  invalidateModelOptionsCache,
}));

type DesktopSettingsIpcModule =
  typeof import('@desktop/main/desktopSettingsIpc');

type DesktopSettingsIpcOptions = Parameters<
  DesktopSettingsIpcModule['createDesktopSettingsIpc']
>[0];

type RendererMessage = Parameters<
  DesktopSettingsIpcOptions['postToRenderer']
>[0];

type SettingsFixtureOverrides = Omit<
  DesktopSettingsIpcOptions,
  'postToRenderer'
> & {
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
  const globalState = overrides.globalState ?? new MemoryStateStore();
  const workspaceState = overrides.workspaceState ?? new MemoryStateStore();
  const settings = createDesktopSettingsIpc({
    ...overrides,
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

  it('shows provider key rows and stores desktop API keys', async () => {
    const secrets = new MemorySecrets();

    const infoMessages: string[] = [];
    let promptCalls = 0;

    const { settings, posted } = createCapturedSettingsFixture({
      secrets,
      promptSecret: async () => {
        promptCalls += 1;
        return '  sk-test  ';
      },
      showInfoMessage: async (message) => {
        infoMessages.push(message);
      },
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
          commandOf(message) === SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE,
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
    const secrets = new MemorySecrets();

    const { settings } = createSettingsFixture({
      secrets,
      promptSecret: async () => '  sk-prompt  ',
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
    let signInCalls = 0;

    const { settings, posted } = createCapturedSettingsFixture({
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
          commandOf(message) === SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE,
      ),
    ).toBe(false);
  });

  it('handles ChatGPT subscription preference commands in desktop settings', async () => {
    const { initPlatform } = await import('@platform/platform');
    initPlatform(createFakePlatform());

    const { settings, posted } = createCapturedSettingsFixture({
      modelListRefresh: Promise.resolve(),
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_CHATGPT_PREFER_SUBSCRIPTION,
        enabled: true,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(invalidateModelOptionsCache).toHaveBeenCalledTimes(1);
    expect(
      posted.findLast(
        (message) =>
          commandOf(message) ===
          SETTINGS_VIEW_COMMANDS.UPDATE_CHATGPT_AUTH_STATUS,
      ),
    ).toMatchObject({
      status: {
        signedIn: false,
        preferSubscription: true,
        subscriptionToolUseOnly: false,
      },
    });
    posted.length = 0;
    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_CHATGPT_SUBSCRIPTION_TOOL_USE_ONLY,
        enabled: false,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(invalidateModelOptionsCache).toHaveBeenCalledTimes(2);
    expect(
      posted.findLast(
        (message) =>
          commandOf(message) ===
          SETTINGS_VIEW_COMMANDS.UPDATE_CHATGPT_AUTH_STATUS,
      ),
    ).toMatchObject({
      status: {
        signedIn: false,
        preferSubscription: true,
        subscriptionToolUseOnly: false,
      },
    });
    expect(
      posted.some(
        (message) =>
          commandOf(message) === SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
      ),
    ).toBe(true);
    expect(
      posted.some(
        (message) =>
          commandOf(message) === MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
      ),
    ).toBe(true);
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

    const { settings, posted } = createCapturedSettingsFixture({
      workspaceState,
      globalState,
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
    const workspaceState = new MemoryStateStore();
    workspaceState.values.set(
      WorkspaceStateKey.CODEX_SANDBOX_MODE,
      'danger-full-access',
    );
    const config = new MemoryConfigStore();
    config.values.set('texra.toolUse.requireBashApproval', false);

    const { settings, posted } = createCapturedSettingsFixture({
      workspaceState,
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
      loadAgents: async () => undefined,
      getCustomAgentDirectory: async () => '',
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

    const { settings, posted } = createCapturedSettingsFixture({
      config: new MemoryConfigStore(),
      sendStartupCatalogData: true,
      modelListRefresh: modelListRefresh.promise,
      loadAgents: async () => undefined,
      getCustomAgentDirectory: async () => '',
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

  it('refreshes launcher agent options after agent visibility changes', async () => {
    const workspaceState = new MemoryStateStore();

    const { settings, posted } = createCapturedSettingsFixture({
      workspaceState,
      loadAgents: async () => undefined,
      loadAgentOptionsData: async () => ({
        workflow: [{ value: 'builtInWorkflow:correct', label: 'correct' }],
        toolUse: [],
      }),
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
          commandOf(message) === SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION,
      ),
    ).toBe(true);
    expect(
      posted.some(
        (message) =>
          commandOf(message) === MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
      ),
    ).toBe(true);
  });

  it('opens the desktop custom agent directory through the shell opener', async () => {
    const openPath = vi.fn(async (_filePath: string) => undefined);

    const { settings } = createSettingsFixture({
      getCustomAgentDirectory: async () => '/agents/custom',
      openPath,
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.OPEN_AGENT_FOLDER,
        folderType: 'custom',
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(openPath).toHaveBeenCalledWith('/agents/custom');
  });

  it('applies desktop team presets and refreshes settings plus launcher options', async () => {
    const workspaceState = new MemoryStateStore();

    const infoMessages: string[] = [];
    const errorMessages: string[] = [];
    let loadCount = 0;

    const catalog = {
      workflow: [
        {
          source: 'builtInWorkflow' as const,
          name: 'correct',
          path: '/agents/correct.yaml',
          category: 'workflow' as const,
        },
        {
          source: 'builtInWorkflow' as const,
          name: 'polish',
          path: '/agents/polish.yaml',
          category: 'workflow' as const,
        },
      ],
      toolUse: [
        {
          source: 'builtInToolUse' as const,
          name: 'orchestrator',
          path: '/agents/orchestrator.yaml',
          category: 'toolUse' as const,
          tools: ['delegate'],
        },
        {
          source: 'custom' as const,
          name: 'research',
          path: '/agents/research.yaml',
          category: 'toolUse' as const,
        },
        {
          source: 'builtInToolUse' as const,
          name: 'numerics',
          path: '/agents/numerics.yaml',
          category: 'toolUse' as const,
        },
        {
          source: 'builtInToolUse' as const,
          name: 'review',
          path: '/agents/review.yaml',
          category: 'toolUse' as const,
        },
        {
          source: 'builtInToolUse' as const,
          name: 'presenter',
          path: '/agents/presenter.yaml',
          category: 'toolUse' as const,
        },
        {
          source: 'builtInToolUse' as const,
          name: 'latexFixer',
          path: '/agents/latexFixer.yaml',
          category: 'toolUse' as const,
        },
      ],
    };

    const { settings, posted } = createCapturedSettingsFixture({
      workspaceState,
      loadAgents: async () => {
        loadCount += 1;
      },
      loadAgentOptionsData: async () => ({
        workflow: [{ value: 'builtInWorkflow:correct', label: 'correct' }],
        toolUse: [
          { value: 'builtInToolUse:orchestrator', label: 'orchestrator' },
        ],
      }),
      getAgents: (category) => catalog[category],
      getVisibleAgents: (category) => catalog[category],
      chooseTeamAvailability: async () => 'continue',
      showInfoMessage: async (message) => {
        infoMessages.push(message);
      },
      showErrorMessage: async (message) => {
        errorMessages.push(message);
      },
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.APPLY_AGENT_MODE_PRESET,
        presetId: 'physicist',
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(loadCount).toBeGreaterThanOrEqual(1);
    // Catalog-resolved names become source-qualified keys, preserving the
    // winning source when a custom agent overrides a built-in name.
    expect(workspaceState.values.get(WorkspaceStateKey.ENABLED_AGENTS)).toEqual(
      [
        'builtInWorkflow:correct',
        'builtInWorkflow:polish',
        'generic',
        'devise',
        'apply',
        'criticize',
      ],
    );
    expect(
      workspaceState.values.get(WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS),
    ).toEqual([
      'builtInToolUse:orchestrator',
      'custom:research',
      'builtInToolUse:numerics',
      'builtInToolUse:review',
      'builtInToolUse:presenter',
      'simplifier',
      'builtInToolUse:latexFixer',
      'progressCheck',
      'search',
    ]);
    expect(errorMessages).toEqual([]);
    expect(infoMessages).toEqual(['Applied "Physicist" team']);

    expect(
      posted.find(
        (message) =>
          commandOf(message) === SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION,
      ),
    ).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION,
      workflow: expect.arrayContaining([
        expect.objectContaining({ name: 'correct', enabled: true }),
        expect.objectContaining({ name: 'polish', enabled: true }),
      ]),
      toolUse: expect.arrayContaining([
        expect.objectContaining({ name: 'orchestrator', enabled: true }),
        expect.objectContaining({ name: 'research', enabled: true }),
      ]),
    });
    expect(
      posted.find(
        (message) =>
          commandOf(message) === MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
      ),
    ).toMatchObject({
      command: MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
      selectedToolUseAgent: 'orchestrator',
      optionsData: {
        workflow: [
          expect.objectContaining({ value: 'builtInWorkflow:correct' }),
        ],
        toolUse: [
          expect.objectContaining({ value: 'builtInToolUse:orchestrator' }),
        ],
      },
    });
  });

  it('signs in, forces one catalog refresh, then commits a desktop team once', async () => {
    const workspaceState = new MemoryStateStore();
    workspaceState.values.set(WorkspaceStateKey.CUSTOM_AGENT_PRESETS, [
      {
        id: 'remote-team',
        name: 'Remote team',
        description: 'Uses a hosted root',
        icon: 'tools',
        workflowAgents: [],
        toolUseAgents: ['orchestrator'],
        texraHostedAgents: ['orchestrator'],
      },
    ]);
    let toolUseAgents: Array<{
      source: 'remote';
      name: string;
      path: string;
      category: 'toolUse';
      tools: string[];
    }> = [];
    const refreshAgents = vi.fn(async () => {
      toolUseAgents = [
        {
          source: 'remote',
          name: 'orchestrator',
          path: '/remote/orchestrator.yaml',
          category: 'toolUse',
          tools: ['delegate_agent'],
        },
      ];
    });
    const signInForRemoteAgentCatalog = vi.fn(async () => true);
    const update = vi.spyOn(workspaceState, 'update');
    const { settings } = createSettingsFixture({
      workspaceState,
      loadAgents: vi.fn(async () => undefined),
      refreshAgents,
      getAgents: (category) => (category === 'workflow' ? [] : toolUseAgents),
      getVisibleAgents: (category) =>
        category === 'workflow' ? [] : toolUseAgents,
      canAccessRemoteAgentCatalog: async () => false,
      chooseTeamAvailability: async () => 'sign-in',
      signInForRemoteAgentCatalog,
    });
    update.mockClear();

    settings.handleMessage({
      command: SETTINGS_VIEW_COMMANDS.APPLY_AGENT_MODE_PRESET,
      presetId: 'remote-team',
    });
    await flushAsyncWork();

    expect(signInForRemoteAgentCatalog).toHaveBeenCalledOnce();
    expect(refreshAgents).toHaveBeenCalledOnce();
    expect(refreshAgents).toHaveBeenCalledWith({ includeRemote: true });
    expect(
      update.mock.calls.filter(
        ([key]) => key === WorkspaceStateKey.ENABLED_AGENTS,
      ),
    ).toHaveLength(1);
    expect(
      update.mock.calls.filter(
        ([key]) => key === WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
      ),
    ).toHaveLength(1);
    expect(
      workspaceState.values.get(WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS),
    ).toEqual(['remote:orchestrator']);
  });

  it('does not write desktop roster state when team preflight is cancelled', async () => {
    const workspaceState = new MemoryStateStore();
    workspaceState.values.set(WorkspaceStateKey.CUSTOM_AGENT_PRESETS, [
      {
        id: 'legacy-remote-team',
        name: 'Legacy remote team',
        description: 'Legacy hosted metadata is inferred',
        icon: 'tools',
        workflowAgents: [],
        toolUseAgents: ['orchestrator'],
      },
    ]);
    const update = vi.spyOn(workspaceState, 'update');
    const refreshAgents = vi.fn(async () => undefined);
    const { settings } = createSettingsFixture({
      workspaceState,
      loadAgents: vi.fn(async () => undefined),
      refreshAgents,
      getAgents: () => [],
      getVisibleAgents: () => [],
      canAccessRemoteAgentCatalog: async () => false,
      chooseTeamAvailability: async () => 'cancel',
    });
    update.mockClear();

    settings.handleMessage({
      command: SETTINGS_VIEW_COMMANDS.APPLY_AGENT_MODE_PRESET,
      presetId: 'legacy-remote-team',
    });
    await flushAsyncWork();

    expect(refreshAgents).not.toHaveBeenCalled();
    expect(
      update.mock.calls.some(
        ([key]) =>
          key === WorkspaceStateKey.ENABLED_AGENTS ||
          key === WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
      ),
    ).toBe(false);
  });

  it('saves desktop team presets from currently visible agents', async () => {
    const workspaceState = new MemoryStateStore();

    const infoMessages: string[] = [];
    const catalog = {
      workflow: [
        {
          source: 'builtInWorkflow' as const,
          name: 'correct',
          path: '/agents/correct.yaml',
          category: 'workflow' as const,
        },
        {
          source: 'builtInWorkflow' as const,
          name: 'polish',
          path: '/agents/polish.yaml',
          category: 'workflow' as const,
        },
      ],
      toolUse: [
        {
          source: 'builtInToolUse' as const,
          name: 'review',
          path: '/agents/review.yaml',
          category: 'toolUse' as const,
        },
        {
          source: 'builtInToolUse' as const,
          name: 'latexFixer',
          path: '/agents/latexFixer.yaml',
          category: 'toolUse' as const,
        },
      ],
    };

    const { settings, posted } = createCapturedSettingsFixture({
      workspaceState,
      loadAgents: async () => undefined,
      getAgents: (category) => catalog[category],
      getVisibleAgents: (category) =>
        category === 'workflow' ? [catalog.workflow[0]] : [catalog.toolUse[0]],
      promptText: async () => '  Paper Team  ',
      showInfoMessage: async (message) => {
        infoMessages.push(message);
      },
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SAVE_AGENT_MODE_PRESET,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(
      workspaceState.values.get(WorkspaceStateKey.CUSTOM_AGENT_PRESETS),
    ).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^custom-/),
        name: 'Paper Team',
        workflowAgents: ['correct'],
        toolUseAgents: ['review'],
      }),
    ]);
    expect(infoMessages).toEqual(['Saved team "Paper Team"']);
    expect(posted.at(-1)).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_MODE_PRESETS,
      orchestratorAgents: expect.arrayContaining([
        'engineer',
        'leanOrchestrator',
        'orchestrator',
      ]),
      customPresets: [
        expect.objectContaining({
          name: 'Paper Team',
          workflowAgents: ['correct'],
          toolUseAgents: ['review'],
        }),
      ],
    });
  });

  it('deletes desktop custom team presets and reports unknown team ids', async () => {
    const workspaceState = new MemoryStateStore();

    const errorMessages: string[] = [];
    workspaceState.values.set(WorkspaceStateKey.CUSTOM_AGENT_PRESETS, [
      {
        id: 'custom-team',
        name: 'Custom Team',
        description: 'test',
        icon: 'codicon-bookmark',
        workflowAgents: ['correct'],
        toolUseAgents: ['review'],
      },
    ]);

    const { settings, posted } = createCapturedSettingsFixture({
      workspaceState,
      showErrorMessage: async (message) => {
        errorMessages.push(message);
      },
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.DELETE_AGENT_MODE_PRESET,
        presetId: 'custom-team',
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(
      workspaceState.values.get(WorkspaceStateKey.CUSTOM_AGENT_PRESETS),
    ).toEqual([]);
    expect(posted.at(-1)).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_MODE_PRESETS,
      customPresets: [],
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.DELETE_AGENT_MODE_PRESET,
        presetId: 'missing-team',
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(errorMessages).toEqual(['Unknown custom team: missing-team']);
  });

  it('surfaces a visible desktop error for unknown team presets', async () => {
    const workspaceState = new MemoryStateStore();
    const errorMessages: string[] = [];

    const { settings } = createSettingsFixture({
      workspaceState,
      loadAgents: async () => undefined,
      showErrorMessage: async (message) => {
        errorMessages.push(message);
      },
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.APPLY_AGENT_MODE_PRESET,
        presetId: 'missing-team',
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(errorMessages).toEqual(['Unknown team: missing-team']);
    expect(workspaceState.values.has(WorkspaceStateKey.ENABLED_AGENTS)).toBe(
      false,
    );
    expect(
      workspaceState.values.has(WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS),
    ).toBe(false);
  });

  it('persists desktop API access mode changes before refreshing settings data', async () => {
    const persistedModes: string[] = [];

    const { settings, posted } = createCapturedSettingsFixture({
      setApiAccessMode: async (mode) => {
        persistedModes.push(mode);
      },
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_API_ACCESS_MODE,
        mode: 'personal',
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(persistedModes).toEqual(['personal']);
    expect(invalidateModelOptionsCache).toHaveBeenCalledTimes(1);
    expect(
      posted.some(
        (message) =>
          commandOf(message) === SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE,
      ),
    ).toBe(true);
    expect(
      posted.some(
        (message) =>
          commandOf(message) === SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
      ),
    ).toBe(true);
  });

  it('clears OpenRouter routing when desktop users enable included access', async () => {
    const globalState = new MemoryStateStore();
    globalState.values.set(GlobalStateKey.USE_OPENROUTER, true);
    const persistedModes: string[] = [];

    const { settings } = createSettingsFixture({
      globalState,
      setApiAccessMode: async (mode) => {
        persistedModes.push(mode);
      },
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
    expect(invalidateModelOptionsCache).toHaveBeenCalledTimes(1);
  });

  it('refreshes agent and model options after desktop auth changes', async () => {
    let loadCount = 0;

    const { settings, posted } = createCapturedSettingsFixture({
      loadAgents: async () => {
        loadCount += 1;
      },
      loadAgentOptionsData: async () => ({
        workflow: [
          { value: 'remote:remote-workflow', label: 'remote-workflow' },
        ],
        toolUse: [{ value: 'remote:remote-tool', label: 'remote-tool' }],
      }),
    });

    await settings.refreshAuthDependentData();

    expect(loadCount).toBe(1);
    expect(invalidateModelOptionsCache).toHaveBeenCalled();
    expect(computeModelOptionsData).toHaveBeenCalled();
    expect(
      invalidateModelOptionsCache.mock.invocationCallOrder[0],
    ).toBeLessThan(computeModelOptionsData.mock.invocationCallOrder[0]);
    expect(posted.map((message) => commandOf(message))).toEqual(
      expect.arrayContaining([
        SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE,
        SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION,
        SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
        MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
        MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
      ]),
    );
  });

  it('defers agent catalog loading while roster sign-in owns the refresh', async () => {
    const loadAgents = vi.fn(async () => undefined);
    const { settings, posted } = createCapturedSettingsFixture({
      loadAgents,
    });

    await settings.refreshAuthDependentData({
      deferAgentCatalogRefresh: true,
    });

    expect(loadAgents).not.toHaveBeenCalled();
    expect(
      posted.some(
        (message) =>
          commandOf(message) === SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE,
      ),
    ).toBe(true);
    expect(
      posted.some(
        (message) =>
          commandOf(message) === SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION,
      ),
    ).toBe(false);
    expect(
      posted.some(
        (message) =>
          commandOf(message) === MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
      ),
    ).toBe(false);
  });

  it('refreshes persisted model list on desktop startup', async () => {
    const globalState = new MemoryStateStore();
    globalState.values.set(GlobalStateKey.MODEL_LIST_VERSION, 12);
    globalState.values.set(GlobalStateKey.ENABLED_MODELS, [
      'custom-model',
      'gpt54pro',
      'opus46T',
      'haiku3',
    ]);
    const errors: unknown[] = [];

    createSettingsFixture({
      globalState,
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

  it('strips retired models from recent persisted model lists', async () => {
    const globalState = new MemoryStateStore();
    globalState.values.set(GlobalStateKey.MODEL_LIST_VERSION, 20);
    globalState.values.set(GlobalStateKey.ENABLED_MODELS, [
      'custom-model',
      'haiku3',
    ]);
    const errors: unknown[] = [];

    createSettingsFixture({
      globalState,
      onError: (error) => errors.push(error),
    });
    await flushAsyncWork();

    expect(errors).toEqual([]);
    expect(globalState.values.get(GlobalStateKey.MODEL_LIST_VERSION)).toBe(
      MODEL_LIST_VERSION,
    );
    const expectedDefaults = DEFAULT_MODELS.filter(
      (model) =>
        !(MODEL_CONFIGS[model]?.deprecated ?? false) &&
        !(MODEL_CONFIGS[model]?.retired ?? false),
    );
    expect(globalState.values.get(GlobalStateKey.ENABLED_MODELS)).toEqual([
      'custom-model',
      ...expectedDefaults,
    ]);
  });

  it('does not duplicate profile refresh after delegated desktop sign-out', async () => {
    let signOutCalls = 0;

    const { settings, posted } = createCapturedSettingsFixture({
      signOut: async () => {
        signOutCalls += 1;
      },
    });

    expect(
      settings.handleMessage({ command: SETTINGS_VIEW_COMMANDS.SIGN_OUT }),
    ).toBe(true);
    await flushAsyncWork();

    expect(signOutCalls).toBe(1);
    expect(
      posted.filter(
        (message) =>
          commandOf(message) === SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE,
      ),
    ).toEqual([]);
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
      runExecution: async (request) => {
        runRequests.push(request);
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
