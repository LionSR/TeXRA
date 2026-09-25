import '@test/support/defaultSessionTestSetup';

import { it } from '@effect/vitest';
import { Effect, Exit, Scope } from 'effect';
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  onTestFinished,
  vi,
} from 'vitest';
import { NotificationFailed } from '@hosts/uiHosts';
import type { ModelOptionStores } from '@model/computeModelOptions';
import {
  StateWriteFailed,
  type ConfigProvider,
  type StateStore,
} from '@platform/interfaces';
import { withProcessServices } from '@platform/processRuntime';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  BASH_APPROVAL_CONFIG_KEY,
  AGENT_SKILLS_CONFIG_KEY,
} from '@shared/schemas';
import type { ModelOptionData } from '@shared/schemas';
import type { DerivedSettingsSnapshot } from '@shared/settingsView/settingsViewMessages';
import { DEFAULT_HELPER_MODEL } from '@shared/constants/providers';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { testRuntime } from '@test/support/testProcessRuntime';
import {
  FakeScopedConfigProvider,
  FakeSecrets,
  FakeStateStore,
} from '@test/support/FakePlatform';
import { createTestSession } from '@test/support/sessionTestUtils';

import {
  commandOf,
  createStubDesktopAgentSettingsController,
  createStubDesktopCredentialSettingsController,
  createStubDesktopSettingsUiHost,
  createStubDesktopToolingSettingsController,
} from './desktopSettingsTestSupport';

const readModelAvailabilityInputs = vi.hoisted(() =>
  vi.fn((_stores: ModelOptionStores, models: readonly string[] = []) =>
    Effect.succeed(models.map((model) => ({ value: model, label: model }))),
  ),
);

vi.mock('@model/computeModelOptions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@model/computeModelOptions')>()),
  readModelAvailabilityInputs,
  // The mocked read resolves the rows this fixture wants; the pure finisher
  // hands them back.
  modelOptionsFrom: (rows: readonly ModelOptionData[]) => rows,
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
  'ui'
> & {
  workspaceState?: StateStore;
  config?: ConfigProvider;
  ui?: Partial<DesktopSettingsIpcOptions['ui']>;
};

type CapturedSettingsFixtureOverrides = Omit<
  SettingsFixtureOverrides,
  'postToRenderer'
>;

let createDesktopSettingsIpc!: DesktopSettingsIpcModule['createDesktopSettingsIpc'];

const liveScopes: Scope.Closeable[] = [];

function createSettingsFixture(overrides: SettingsFixtureOverrides = {}) {
  const {
    globalState = new FakeStateStore(),
    secrets = new FakeSecrets(),
    workspaceState = new FakeStateStore(),
    config = new FakeScopedConfigProvider(),
    ui,
    ...settingsOverrides
  } = overrides;
  const postToRenderer = overrides.postToRenderer ?? (() => undefined);
  // The paper's workspace state and config reach the IPC through its
  // session's roots, as the desktop passes them.
  const session =
    overrides.session ??
    createTestSession({
      roots: {
        ...testWorkspaceRoots(),
        storage: '/workspace/settings-ipc/storage',
        config,
        workspaceState,
      },
    });
  // One root holds one session: released at test end, or the next fixture
  // over this root would get this test's session and its workspace state.
  if (overrides.session === undefined) {
    onTestFinished(() => Effect.runPromise(session.dispose()));
  }
  // The IPC subscribes to the process app-signal bus, so a fixture whose scope stayed open would keep reacting to later
  // tests' emits.
  const scope = Scope.makeUnsafe();
  liveScopes.push(scope);
  const settings = testRuntime().runSync(
    createDesktopSettingsIpc({
      runtime: testRuntime(),
      ...settingsOverrides,
      agentSettingsController:
        overrides.agentSettingsController ??
        createStubDesktopAgentSettingsController(),
      credentialSettingsController:
        overrides.credentialSettingsController ??
        createStubDesktopCredentialSettingsController({
          globalState,
          workspaceState,
        }),
      toolingSettingsController:
        overrides.toolingSettingsController ??
        createStubDesktopToolingSettingsController(),
      globalState,
      secrets,
      externalOpener: overrides.externalOpener ?? {
        openExternal: () => Effect.void,
      },
      ui: createStubDesktopSettingsUiHost(ui),
      session,
      postToRenderer,
    }).pipe(
      // Runs an owned command's program the way the window's router does.
      Effect.map((ipc) => ({
        ...ipc,
        handleMessage(message: Parameters<typeof ipc.handleMessage>[0]) {
          const program = ipc.handleMessage(message);
          if (program) testRuntime().runFork(program);
          return program !== undefined;
        },
      })),
      Scope.provide(scope),
    ),
  );
  return { globalState, session, settings, workspaceState };
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

function findPosted(
  posted: readonly RendererMessage[],
  command: string,
): RendererMessage | undefined {
  return posted.find((message) => commandOf(message) === command);
}

function isSnapshot(
  message: RendererMessage,
  snapshot: DerivedSettingsSnapshot,
): boolean {
  return (
    commandOf(message) === SETTINGS_VIEW_COMMANDS.UPDATE_SETTINGS_SNAPSHOT &&
    (message as { snapshot?: unknown }).snapshot === snapshot
  );
}

function findSnapshot(
  posted: readonly RendererMessage[],
  snapshot: DerivedSettingsSnapshot,
): RendererMessage | undefined {
  return posted.find((message) => isSnapshot(message, snapshot));
}

function latexSnapshotCount(posted: readonly RendererMessage[]): number {
  return posted.filter((message) => isSnapshot(message, 'latex')).length;
}

function createFailureReportingFixture(workspaceState: FakeStateStore) {
  const onError = vi.fn();
  const showErrorMessage = vi.fn(() => Effect.void);
  const { settings, posted } = createCapturedSettingsFixture({
    workspaceState,
    ui: { onError, showErrorMessage },
  });
  return { settings, onError, showErrorMessage, posted };
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) =>
    setImmediate(() => setImmediate(() => resolve())),
  );
}

function newStatePorts() {
  return {
    globalState: new FakeStateStore(),
    workspaceState: new FakeStateStore(),
  };
}

describe('desktop settings IPC', () => {
  beforeAll(async () => {
    ({ createDesktopSettingsIpc } =
      await import('@desktop/main/desktopSettingsIpc'));
  });

  afterEach(() => {
    for (const scope of liveScopes.splice(0))
      testRuntime().runFork(Scope.close(scope, Exit.void));
    vi.clearAllMocks();
  });

  it('posts only for settings readiness', async () => {
    const workspaceState = new FakeStateStore({
      [WorkspaceStateKey.GIT_AUTHOR_NAME]: 'TeXRA Bot',
      [WorkspaceStateKey.GIT_AUTHOR_EMAIL]: 'bot@example.com',
    });

    const { settings, posted } = createCapturedSettingsFixture({
      workspaceState,
    });

    expect(posted).toEqual([]);
    // Claimed either way — the settings surface owns the command — but only
    // its own view's readiness posts anything.
    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.WEBVIEW_READY,
      }),
    ).toBe(true);
    expect(posted).toEqual([]);
    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.WEBVIEW_READY,
        view: 'settings',
      }),
    ).toBe(true);
    await flushAsyncWork();
    expect(findSnapshot(posted, 'git-author')).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_SETTINGS_SNAPSHOT,
      snapshot: 'git-author',
      values: {
        [WorkspaceStateKey.GIT_MARK_COMMITS]: true,
        [WorkspaceStateKey.GIT_AUTHOR_NAME]: 'TeXRA Bot',
        [WorkspaceStateKey.GIT_AUTHOR_EMAIL]: 'bot@example.com',
        [WorkspaceStateKey.GIT_WORKTREE_SUPPORT]: false,
      },
    });
  }, 15_000);

  it('loads usage only for the subscription command and rejects malformed refresh payloads', async () => {
    const postSubscriptionUsage = vi.fn(() => Effect.void);
    const onError = vi.fn();
    const credentialSettingsController =
      createStubDesktopCredentialSettingsController(newStatePorts(), {
        postSubscriptionUsage,
      });
    const { settings } = createSettingsFixture({
      credentialSettingsController,
      ui: { onError },
    });

    settings.handleMessage({
      command: SETTINGS_VIEW_COMMANDS.WEBVIEW_READY,
      view: 'settings',
    });
    await flushAsyncWork();
    expect(postSubscriptionUsage).not.toHaveBeenCalled();

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.GET_SUBSCRIPTION_USAGE,
        forceRefresh: true,
      }),
    ).toBe(true);
    await flushAsyncWork();
    expect(postSubscriptionUsage).toHaveBeenCalledExactlyOnceWith(true);

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.GET_SUBSCRIPTION_USAGE,
        forceRefresh: 'yes',
      } as never),
    ).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });

  it('routes a close-during-usage-fetch failure without an unhandled rejection', async () => {
    let rejectFetch: ((error: Error) => void) | undefined;
    const postSubscriptionUsage = vi.fn(() =>
      Effect.tryPromise({
        try: () =>
          new Promise<void>((_resolve, reject) => {
            rejectFetch = reject;
          }),
        catch: (cause) => cause as Error,
      }),
    );
    const onError = vi.fn();
    const credentialSettingsController =
      createStubDesktopCredentialSettingsController(newStatePorts(), {
        postSubscriptionUsage,
      });
    const { settings } = createSettingsFixture({
      credentialSettingsController,
      ui: { onError },
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.GET_SUBSCRIPTION_USAGE,
      }),
    ).toBe(true);
    rejectFetch?.(new Error('renderer closed'));
    await flushAsyncWork();

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'renderer closed' }),
    );
  });

  it.live(
    'round-trips Git author writes through workspace state and refreshes the renderer',
    () =>
      Effect.gen(function* () {
        const workspaceState = new FakeStateStore();

        const { settings, posted } = createCapturedSettingsFixture({
          workspaceState,
        });

        expect(
          settings.handleMessage({
            command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
            key: WorkspaceStateKey.GIT_AUTHOR_NAME,
            value: 'Desktop TeXRA',
          }),
        ).toBe(true);
        yield* Effect.promise(() => flushAsyncWork());

        expect(
          yield* withProcessServices(
            testRuntime(),
            workspaceState.get(WorkspaceStateKey.GIT_AUTHOR_NAME),
          ),
        ).toBe('Desktop TeXRA');
        expect(posted.at(-1)).toMatchObject({
          command: SETTINGS_VIEW_COMMANDS.UPDATE_SETTINGS_SNAPSHOT,
          snapshot: 'git-author',
          values: { [WorkspaceStateKey.GIT_AUTHOR_NAME]: 'Desktop TeXRA' },
        });

        expect(
          settings.handleMessage({
            command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
            key: WorkspaceStateKey.GIT_MARK_COMMITS,
            value: false,
          }),
        ).toBe(true);
        yield* Effect.promise(() => flushAsyncWork());
        expect(
          yield* withProcessServices(
            testRuntime(),
            workspaceState.get(WorkspaceStateKey.GIT_MARK_COMMITS),
          ),
        ).toBe(false);

        expect(
          settings.handleMessage({
            command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
            key: WorkspaceStateKey.GIT_WORKTREE_SUPPORT,
            value: true,
          }),
        ).toBe(true);
        yield* Effect.promise(() => flushAsyncWork());
        expect(
          yield* withProcessServices(
            testRuntime(),
            workspaceState.get(WorkspaceStateKey.GIT_WORKTREE_SUPPORT),
          ),
        ).toBe(true);
      }),
  );

  it.live('round-trips tool path protection through workspace state', () =>
    Effect.gen(function* () {
      const workspaceState = new FakeStateStore();
      const { settings, posted } = createCapturedSettingsFixture({
        workspaceState,
      });

      expect(
        settings.handleMessage({
          command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
          key: WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED,
          value: false,
        }),
      ).toBe(true);
      yield* Effect.promise(() => flushAsyncWork());

      expect(
        yield* withProcessServices(
          testRuntime(),
          workspaceState.get(WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED),
        ),
      ).toBe(false);
      expect(posted.at(-1)).toMatchObject({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_SETTINGS_SNAPSHOT,
        snapshot: 'approval',
        values: {
          [WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED]: false,
        },
      });
    }),
  );

  it.live(
    'round-trips multi-agent coordination and refreshes its snapshot',
    () =>
      Effect.gen(function* () {
        const globalState = new FakeStateStore();
        const { settings, posted } = createCapturedSettingsFixture({
          globalState,
        });

        expect(
          settings.handleMessage({
            command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
            key: GlobalStateKey.DETACH_SUBAGENTS_ON_STOP,
            value: true,
          }),
        ).toBe(true);
        yield* Effect.promise(() => flushAsyncWork());

        expect(
          yield* withProcessServices(
            testRuntime(),
            globalState.get(GlobalStateKey.DETACH_SUBAGENTS_ON_STOP),
          ),
        ).toBe(true);
        expect(posted.at(-1)).toMatchObject({
          command: SETTINGS_VIEW_COMMANDS.UPDATE_SETTINGS_SNAPSHOT,
          snapshot: 'multi-agent',
          values: { [GlobalStateKey.DETACH_SUBAGENTS_ON_STOP]: true },
        });
      }),
  );

  it('shows unsupported-command reasons without reporting an error', async () => {
    const showInfoMessage = vi.fn(() => Effect.void);
    const onError = vi.fn();
    const { settings } = createSettingsFixture({
      ui: { showInfoMessage, onError },
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.INSTALL_LATEX_WORKSHOP,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(showInfoMessage).toHaveBeenCalledWith(
      'Desktop cannot host VS Code extensions.',
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it.live.each([
    SETTINGS_VIEW_COMMANDS.INSTALL_LATEX_WORKSHOP,
    SETTINGS_VIEW_COMMANDS.SIGN_IN_CHATGPT,
  ])('reports the underlying notification failure from %s', (command) =>
    Effect.gen(function* () {
      const failure = new Error('window is gone');
      const notice = Effect.fail(
        new NotificationFailed({
          member: 'showErrorMessage',
          message: 'notification failed',
          cause: failure,
        }),
      );
      const onError = vi.fn();
      const credentialSettingsController =
        createStubDesktopCredentialSettingsController(
          {
            globalState: new FakeStateStore(),
            workspaceState: new FakeStateStore(),
          },
          {
            chatGptHandlers: {
              signInChatGpt: () => notice,
              signOutChatGpt: () => Effect.void,
              setChatGptPreferSubscription: () => Effect.void,
            },
          },
        );
      const { settings } = createSettingsFixture({
        credentialSettingsController,
        ui: { showInfoMessage: () => notice, onError },
      });

      expect(settings.handleMessage({ command })).toBe(true);
      yield* Effect.promise(() => flushAsyncWork());

      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(failure);
    }),
  );

  it.live(
    'round-trips the LaTeX formatter through workspace state and refreshes config values',
    () =>
      Effect.gen(function* () {
        const { settings, workspaceState, posted } =
          createCapturedSettingsFixture();

        expect(
          settings.handleMessage({
            command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
            key: WorkspaceStateKey.LATEX_FORMATTER,
            value: 'none',
          }),
        ).toBe(true);
        yield* Effect.promise(() => flushAsyncWork());

        expect(
          yield* withProcessServices(
            testRuntime(),
            workspaceState.get(WorkspaceStateKey.LATEX_FORMATTER),
          ),
        ).toBe('none');
        expect(latexSnapshotCount(posted)).toBe(1);

        expect(
          settings.handleMessage({
            command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
            key: WorkspaceStateKey.LATEX_FORMATTER,
            value: null,
          }),
        ).toBe(true);
        yield* Effect.promise(() => flushAsyncWork());
        expect(
          yield* withProcessServices(
            testRuntime(),
            workspaceState.get(WorkspaceStateKey.LATEX_FORMATTER),
          ),
        ).toBeUndefined();
        expect(latexSnapshotCount(posted)).toBe(2);
      }),
  );

  it.live('persists model settings through global state', () =>
    Effect.gen(function* () {
      const workspaceState = new FakeStateStore();
      const globalState = new FakeStateStore({
        [GlobalStateKey.MODEL_SELECTION]: {
          enabledExtras: ['gpt55'],
          disabledDefaults: [],
        },
        [GlobalStateKey.HELPER_MODEL]: 'gpt55',
      });

      const errors: unknown[] = [];
      const refreshModelOptions = vi.fn(() => Effect.void);
      const credentialSettingsController =
        createStubDesktopCredentialSettingsController(
          { globalState, workspaceState },
          { refreshModelOptions },
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
      yield* Effect.promise(() => flushAsyncWork());

      expect(
        yield* withProcessServices(
          testRuntime(),
          globalState.get(GlobalStateKey.MODEL_SELECTION),
        ),
      ).toEqual({
        enabledExtras: [],
        disabledDefaults: [],
      });
      expect(errors).toEqual([]);
      expect(
        posted.findLast(
          (message) =>
            commandOf(message) ===
            SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
        ),
      ).toMatchObject({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
        helperModel: DEFAULT_HELPER_MODEL,
      });
      expect(refreshModelOptions).toHaveBeenCalledOnce();

      expect(
        settings.handleMessage({
          command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
          key: GlobalStateKey.PREFER_SHORT_MODEL_NAMES,
          value: true,
        }),
      ).toBe(true);
      yield* Effect.promise(() => flushAsyncWork());

      expect(
        yield* withProcessServices(
          testRuntime(),
          globalState.get(GlobalStateKey.PREFER_SHORT_MODEL_NAMES),
        ),
      ).toBe(true);
      expect(posted.at(-1)).toMatchObject({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
        preferShortModelNames: true,
      });
    }),
  );

  it('delegates domain startup and posts approval settings on readiness', async () => {
    const workspaceState = new FakeStateStore({
      [WorkspaceStateKey.CODEX_SANDBOX_MODE]: 'danger-full-access',
    });
    const config = new FakeScopedConfigProvider();
    config.seedWorkspace('texra.toolUse.requireBashApproval', false);
    const agentSettingsController = createStubDesktopAgentSettingsController();
    const postAgentStartupData = vi.fn(() => Effect.void);
    agentSettingsController.postStartupData = postAgentStartupData;
    const postToolingStartupData = vi.fn(() => Effect.void);
    const toolingSettingsController =
      createStubDesktopToolingSettingsController({
        postStartupData: postToolingStartupData,
      });
    const { settings, posted } = createCapturedSettingsFixture({
      agentSettingsController,
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
    ).toBe(true);
    await flushAsyncWork();

    expect(latexSnapshotCount(posted)).toBe(1);
    expect(postToolingStartupData).toHaveBeenCalledOnce();
    expect(postAgentStartupData).toHaveBeenCalledOnce();

    expect(findSnapshot(posted, 'approval')).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_SETTINGS_SNAPSHOT,
      snapshot: 'approval',
      values: {
        [BASH_APPROVAL_CONFIG_KEY]: false,
        [WorkspaceStateKey.CODEX_SANDBOX_MODE]: 'danger-full-access',
      },
    });
    // Without these the Git tab renders a permanently "Not set" token status
    // and an empty subscription list until the user mutates either one.
    expect(
      findPosted(posted, SETTINGS_VIEW_COMMANDS.UPDATE_GITHUB_TOKEN_STATUS),
    ).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_GITHUB_TOKEN_STATUS,
      status: 'none',
    });
    expect(
      findPosted(posted, SETTINGS_VIEW_COMMANDS.UPDATE_PR_SUBSCRIPTIONS),
    ).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_PR_SUBSCRIPTIONS,
      subscriptions: [],
    });
  });

  it('writes the bash-approval toggle to the workspace config scope, not global', async () => {
    const config = new FakeScopedConfigProvider();

    const { settings, posted } = createCapturedSettingsFixture({
      config,
      ui: { onError: () => undefined },
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
        key: BASH_APPROVAL_CONFIG_KEY,
        value: false,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(config.get('texra.toolUse.requireBashApproval')).toBe(false);
    // Security-adjacent scope pin: a per-workspace approval bypass must never
    // be written to the global config target (see issue #7085).
    expect(config.lastTargetFor('texra.toolUse.requireBashApproval')).toBe(
      'workspace',
    );
    expect(findSnapshot(posted, 'approval')).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_SETTINGS_SNAPSHOT,
      snapshot: 'approval',
      values: { [BASH_APPROVAL_CONFIG_KEY]: false },
    });
  });

  it('reports failed setting writes and restores the authoritative snapshot', async () => {
    const workspaceState = new FakeStateStore();
    // The store's own tagged refusal, which is what the IPC reports: the
    // write is an Effect the IPC composes, so the double fails with one.
    const failure = new StateWriteFailed({
      key: WorkspaceStateKey.LATEX_FORMATTER,
      message: 'workspace write failed',
      cause: new Error('workspace write failed'),
    });
    vi.spyOn(workspaceState, 'update').mockReturnValueOnce(
      Effect.fail(failure),
    );
    const { settings, onError, showErrorMessage, posted } =
      createFailureReportingFixture(workspaceState);

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
        key: WorkspaceStateKey.LATEX_FORMATTER,
        value: 'none',
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(onError).toHaveBeenCalledWith(failure);
    expect(showErrorMessage).toHaveBeenCalledWith(
      'Failed to update "LaTeX formatter": workspace write failed',
    );
    expect(latexSnapshotCount(posted)).toBe(1);
  });

  it('reports rejected setting values and restores the authoritative snapshot', async () => {
    const workspaceState = new FakeStateStore();
    const update = vi.spyOn(workspaceState, 'update');
    const { settings, onError, showErrorMessage, posted } =
      createFailureReportingFixture(workspaceState);

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
        key: WorkspaceStateKey.LATEXDIFF_MATH_MARKUP,
        value: 'bogus',
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(update).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Invalid value for "Math markup in diffs":'),
    );
    expect(latexSnapshotCount(posted)).toBe(1);
  });

  it('writes the agent-skills toggle and returns the skills settings', async () => {
    const config = new FakeScopedConfigProvider();

    const { settings, posted } = createCapturedSettingsFixture({
      config,
      ui: { onError: () => undefined },
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
        key: AGENT_SKILLS_CONFIG_KEY,
        value: false,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(config.get(AGENT_SKILLS_CONFIG_KEY)).toBe(false);
    expect(config.lastTargetFor(AGENT_SKILLS_CONFIG_KEY)).toBe('workspace');
    expect(findSnapshot(posted, 'skills')).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_SETTINGS_SNAPSHOT,
      snapshot: 'skills',
      values: {
        [AGENT_SKILLS_CONFIG_KEY]: false,
        [WorkspaceStateKey.DISABLED_SKILLS]: [],
        [WorkspaceStateKey.DISABLED_SKILL_SOURCES]: [],
        [GlobalStateKey.INSTALLED_PLUGINS]: [],
      },
    });
  });

  it.effect(
    'refreshes credentials before conditionally refreshing the agent catalog',
    () =>
      Effect.gen(function* () {
        const state = newStatePorts();
        const events: string[] = [];
        const refreshAuthDependentData = vi.fn(() =>
          Effect.sync(() => {
            events.push('credentials');
          }),
        );
        const credentialSettingsController =
          createStubDesktopCredentialSettingsController(state, {
            refreshAuthDependentData,
          });
        const agentSettingsController =
          createStubDesktopAgentSettingsController();
        agentSettingsController.refreshCatalogData = vi.fn(() =>
          Effect.sync(() => {
            events.push('agents');
          }),
        );
        const { settings } = createSettingsFixture({
          ...state,
          agentSettingsController,
          credentialSettingsController,
        });

        yield* withProcessServices(
          testRuntime(),
          settings.refreshAuthDependentData(),
        );

        expect(events).toEqual(['credentials', 'agents']);

        events.length = 0;
        yield* withProcessServices(
          testRuntime(),
          settings.refreshAuthDependentData({
            deferAgentCatalogRefresh: true,
          }),
        );

        expect(events).toEqual(['credentials']);
        expect(refreshAuthDependentData).toHaveBeenCalledTimes(2);
        expect(refreshAuthDependentData).toHaveBeenLastCalledWith();
        expect(
          agentSettingsController.refreshCatalogData,
        ).toHaveBeenCalledOnce();
      }),
  );

  it('requires UI confirmation before deleting memory', async () => {
    const confirmAction = vi.fn(() => Effect.succeed(false));
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
    // Missing the required `key` — the inbound schema rejects it, so the
    // dispatcher never claims the message.
    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
      }),
    ).toBe(false);
    expect(posted).toEqual([]);
  });
});
