import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeStateStore } from '@test/support/FakePlatform';
import { MODEL_LIST_VERSION } from '@model/modelOptionsBasic';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import { DEFAULT_GIT_MARK_COMMITS } from '@shared/schemas/stateSettings';
import {
  isWorktreeSupportEnabled,
  setWorktreeSupportEnabled,
} from '@utils/config/worktreeConfig';
import { getGitAuthorEnv, setGitAuthorEnv } from '@utils/system/gitAuthorEnv';

import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';
import {
  createStubDesktopAgentSettingsController,
  createStubDesktopCrashReportingSettingsController,
  createStubDesktopCredentialSettingsController,
  createStubDesktopHistorySettingsController,
  createStubDesktopSettingsUiHost,
  createStubDesktopToolingSettingsController,
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
type RendererMessage = Parameters<
  DesktopSettingsIpcOptions['postToRenderer']
>[0];

type SettingsFixtureOverrides = Omit<
  Partial<DesktopSettingsIpcOptions>,
  | 'agentSettingsController'
  | 'crashReportingSettingsController'
  | 'credentialSettingsController'
  | 'state'
  | 'config'
  | 'historySettingsController'
  | 'ui'
  | 'toolingSettingsController'
  | 'postToRenderer'
> & {
  agentSettingsController?: DesktopSettingsIpcOptions['agentSettingsController'];
  crashReportingSettingsController?: DesktopSettingsIpcOptions['crashReportingSettingsController'];
  credentialSettingsController?: DesktopSettingsIpcOptions['credentialSettingsController'];
  globalState?: StateStore;
  workspaceState?: StateStore;
  config?: DesktopSettingsIpcOptions['config'];
  historySettingsController?: DesktopSettingsIpcOptions['historySettingsController'];
  ui?: Partial<DesktopSettingsIpcOptions['ui']>;
  toolingSettingsController?: DesktopSettingsIpcOptions['toolingSettingsController'];
  postToRenderer?: DesktopSettingsIpcOptions['postToRenderer'];
};

type CapturedSettingsFixtureOverrides = Omit<
  SettingsFixtureOverrides,
  'postToRenderer'
>;

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

async function loadDesktopSettingsIpc(): Promise<DesktopSettingsIpcModule> {
  return import(
    moduleFileUrl(desktopSourcePath('main', 'desktopSettingsIpc.ts'))
  ) as Promise<DesktopSettingsIpcModule>;
}

let createDesktopSettingsIpc!: DesktopSettingsIpcModule['createDesktopSettingsIpc'];

function createSettingsFixture(overrides: SettingsFixtureOverrides = {}) {
  const {
    globalState = new FakeStateStore(),
    workspaceState = new FakeStateStore(),
    config = new MemoryConfigStore(),
    ui,
    ...settingsOverrides
  } = overrides;
  const postToRenderer = overrides.postToRenderer ?? (() => undefined);
  const settings = createDesktopSettingsIpc({
    ...settingsOverrides,
    agentSettingsController:
      overrides.agentSettingsController ??
      createStubDesktopAgentSettingsController(),
    crashReportingSettingsController:
      overrides.crashReportingSettingsController ??
      createStubDesktopCrashReportingSettingsController(),
    credentialSettingsController:
      overrides.credentialSettingsController ??
      createStubDesktopCredentialSettingsController({
        globalState,
        workspaceState,
      }),
    historySettingsController:
      overrides.historySettingsController ??
      createStubDesktopHistorySettingsController(),
    toolingSettingsController:
      overrides.toolingSettingsController ??
      createStubDesktopToolingSettingsController({
        postLatexConfigValues: () =>
          postToRenderer({
            command: SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_CONFIG_VALUES,
            values: {},
          }),
      }),
    state: { globalState, workspaceState },
    config,
    ui: createStubDesktopSettingsUiHost(ui),
    postToRenderer,
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
    const workspaceState = new FakeStateStore({
      [WorkspaceStateKey.GIT_AUTHOR_NAME]: 'TeXRA Bot',
      [WorkspaceStateKey.GIT_AUTHOR_EMAIL]: 'bot@example.com',
    });

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
    await flushAsyncWork();
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
    expect(
      posted.find(
        (message) =>
          commandOf(message) ===
          SETTINGS_VIEW_COMMANDS.UPDATE_GIT_AUTHOR_SETTINGS,
      ),
    ).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_GIT_AUTHOR_SETTINGS,
      markCommits: DEFAULT_GIT_MARK_COMMITS,
      authorName: 'TeXRA Bot',
      authorEmail: 'bot@example.com',
      worktreeSupport: false,
    });
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

  it('delegates history commands to the required controller', async () => {
    const baseController = createStubDesktopHistorySettingsController();
    const rerunAgent = vi.fn(async () => undefined);
    const historySettingsController = {
      ...baseController,
      actions: { ...baseController.actions, rerunAgent },
    };
    const { settings } = createSettingsFixture({
      historySettingsController,
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.RERUN_AGENT,
        historyId: 'history-entry',
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(rerunAgent).toHaveBeenCalledWith({
      command: SETTINGS_VIEW_COMMANDS.RERUN_AGENT,
      historyId: 'history-entry',
    });
  });

  it('round-trips Git author writes through workspace state and refreshes the renderer', async () => {
    const workspaceState = new FakeStateStore();

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

    expect(workspaceState.get(WorkspaceStateKey.GIT_AUTHOR_NAME)).toBe(
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
    expect(workspaceState.get(WorkspaceStateKey.GIT_MARK_COMMITS)).toBe(false);
    expect(getGitAuthorEnv()).toEqual({});

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_GIT_WORKTREE_SUPPORT,
        enabled: true,
      }),
    ).toBe(true);
    await Promise.resolve();
    expect(workspaceState.get(WorkspaceStateKey.GIT_WORKTREE_SUPPORT)).toBe(
      true,
    );
    expect(isWorktreeSupportEnabled()).toBe(true);
  });

  it('delegates crash-reporting commands to the required controller', async () => {
    const get = vi.fn(async () => undefined);
    const setEnabled = vi.fn(async () => undefined);
    const setDsn = vi.fn(async () => undefined);
    const crashReportingSettingsController =
      createStubDesktopCrashReportingSettingsController({
        actions: { get, setEnabled, setDsn },
      });
    const { settings } = createSettingsFixture({
      crashReportingSettingsController,
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.GET_DESKTOP_CRASH_REPORTING,
      }),
    ).toBe(true);
    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_DESKTOP_CRASH_REPORTING_ENABLED,
        enabled: true,
      }),
    ).toBe(true);
    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_DESKTOP_CRASH_REPORTING_DSN,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(get).toHaveBeenCalledOnce();
    expect(setEnabled).toHaveBeenCalledWith(true);
    expect(setDsn).toHaveBeenCalledOnce();
  });

  it('serves the goal list instead of the desktop "not available" stub (issue #7751 FS6)', async () => {
    const { settings, posted } = createCapturedSettingsFixture();

    // Was previously declared unsupported and appeared in the derived
    // capability broadcast (SET_UNSUPPORTED_COMMANDS); the fix removes it.
    settings.handleMessage({
      command: SETTINGS_VIEW_COMMANDS.WEBVIEW_READY,
      view: 'settings',
    });
    await flushAsyncWork();
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
      ui: {
        revealStream: async (streamId) => {
          revealed.push(streamId);
        },
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

  it('shows unsupported-command reasons without reporting an error', async () => {
    const showInfoMessage = vi.fn(async () => undefined);
    const onError = vi.fn();
    const { settings } = createSettingsFixture({
      ui: { showInfoMessage, onError },
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.OPEN_VSCODE_SETTINGS,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(showInfoMessage).toHaveBeenCalledWith(
      'No VS Code settings in the desktop app.',
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports a failure to show an unsupported-command reason', async () => {
    const failure = new Error('notification failed');
    const showInfoMessage = vi.fn(async () => Promise.reject(failure));
    const onError = vi.fn();
    const { settings } = createSettingsFixture({
      ui: { showInfoMessage, onError },
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.OPEN_VSCODE_SETTINGS,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it('delegates Tools and LaTeX commands to the required controller', async () => {
    const baseController = createStubDesktopToolingSettingsController();
    const toggle = vi.fn(async () => undefined);
    const runInstallCommand = vi.fn(async () => undefined);
    const setConfigValue = vi.fn(async () => undefined);
    const toolingSettingsController =
      createStubDesktopToolingSettingsController({
        toolsActions: { ...baseController.toolsActions, toggle },
        latexActions: {
          ...baseController.latexActions,
          runInstallCommand,
          setConfigValue,
        },
      });
    const { settings } = createSettingsFixture({ toolingSettingsController });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.TOGGLE_TOOL,
        toolId: 'zotero',
        enabled: false,
      }),
    ).toBe(true);
    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.RUN_INSTALL_COMMAND,
        installCommand: 'brew install --cask mactex-no-gui',
      }),
    ).toBe(true);
    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_LATEX_CONFIG_VALUE,
        field: 'latexFormatter',
        value: 'none',
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(toggle).toHaveBeenCalledWith('zotero', false);
    expect(runInstallCommand).toHaveBeenCalledWith(
      'brew install --cask mactex-no-gui',
    );
    expect(setConfigValue).toHaveBeenCalledWith({
      field: 'latexFormatter',
      value: 'none',
    });
  });

  it('delegates profile and ChatGPT commands to the credential controller', async () => {
    const state = {
      globalState: new FakeStateStore(),
      workspaceState: new FakeStateStore(),
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

  it('persists model settings through global state', async () => {
    const workspaceState = new FakeStateStore();
    const globalState = new FakeStateStore({
      [GlobalStateKey.ENABLED_MODELS]: ['gpt55', 'sonnet46T'],
      [GlobalStateKey.MODEL_LIST_VERSION]: MODEL_LIST_VERSION,
      [GlobalStateKey.HELPER_MODEL]: 'gpt55',
    });

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
      ui: { onError: (error) => errors.push(error) },
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_MODEL_ENABLED,
        modelName: 'gpt55',
        enabled: false,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(globalState.get(GlobalStateKey.ENABLED_MODELS)).toEqual([
      'sonnet46T',
    ]);
    expect(globalState.get(GlobalStateKey.HELPER_MODEL)).toBe('sonnet46T');
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

    expect(globalState.get(GlobalStateKey.PREFER_SHORT_MODEL_NAMES)).toBe(true);
    expect(posted.at(-1)).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
      preferShortModelNames: true,
    });
  });

  it('delegates domain startup and posts approval settings on readiness', async () => {
    const workspaceState = new FakeStateStore({
      [WorkspaceStateKey.CODEX_SANDBOX_MODE]: 'danger-full-access',
    });
    const config = new MemoryConfigStore();
    config.values.set('texra.toolUse.requireBashApproval', false);
    const agentSettingsController = createStubDesktopAgentSettingsController();
    const postAgentStartupData = vi.fn(async () => undefined);
    agentSettingsController.postStartupData = postAgentStartupData;
    const postCrashReportingStartupData = vi.fn(async () => undefined);
    const crashReportingSettingsController =
      createStubDesktopCrashReportingSettingsController({
        postStartupData: postCrashReportingStartupData,
      });
    const postToolingStartupData = vi.fn(async () => undefined);
    const postLatexConfigValues = vi.fn();
    const toolingSettingsController =
      createStubDesktopToolingSettingsController({
        postLatexConfigValues,
        postStartupData: postToolingStartupData,
      });
    const postHistoryData = vi.fn(async () => undefined);
    const historySettingsController =
      createStubDesktopHistorySettingsController({ postHistoryData });

    const { settings, posted } = createCapturedSettingsFixture({
      agentSettingsController,
      crashReportingSettingsController,
      historySettingsController,
      toolingSettingsController,
      workspaceState,
      config,
      ui: { onError: () => undefined },
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.WEBVIEW_READY,
        view: 'settings',
      }),
    ).toBe(false);
    await flushAsyncWork();

    expect(postLatexConfigValues).toHaveBeenCalledOnce();
    expect(postToolingStartupData).toHaveBeenCalledOnce();
    expect(postCrashReportingStartupData).toHaveBeenCalledOnce();
    expect(postHistoryData).toHaveBeenCalledOnce();
    expect(postAgentStartupData).toHaveBeenCalledOnce();

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
  });

  it('writes the bash-approval toggle to the workspace config scope, not global', async () => {
    const config = new MemoryConfigStore();

    const { settings, posted } = createCapturedSettingsFixture({
      config,
      ui: { onError: () => undefined },
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
      globalState: new FakeStateStore(),
      workspaceState: new FakeStateStore(),
    };
    const credentialSettingsController =
      createStubDesktopCredentialSettingsController(state, {
        prepareModelSelectionData: () => modelListRefresh.promise,
      });

    const { settings, posted } = createCapturedSettingsFixture({
      ...state,
      config: new MemoryConfigStore(),
      credentialSettingsController,
      ui: { onError: () => undefined },
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

  it('refreshes credentials before conditionally refreshing the agent catalog', async () => {
    const state = {
      globalState: new FakeStateStore(),
      workspaceState: new FakeStateStore(),
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
    const globalState = new FakeStateStore();

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

    expect(globalState.get(GlobalStateKey.MEMORY_ENABLED)).toBe(false);
    expect(posted.at(-1)).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_ENABLED,
      enabled: false,
    });
  });

  it('requires UI confirmation before deleting memory', async () => {
    const confirmAction = vi.fn(async () => false);
    const { settings, posted } = createCapturedSettingsFixture({
      ui: { confirmAction },
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.DELETE_MEMORY,
        storagePath: 'memory/example.md',
        displayPath: 'example.md',
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(confirmAction).toHaveBeenCalledWith(
      'Delete "example.md"?',
      'Delete',
    );
    expect(posted).toEqual([]);
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
