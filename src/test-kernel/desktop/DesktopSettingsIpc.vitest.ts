import '@test/support/defaultSessionTestSetup';

import { it } from '@effect/vitest';
import { Effect, Exit, Result, Schema, Scope } from 'effect';
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  onTestFinished,
  vi,
} from 'vitest';
import {
  StateWriteFailed,
  type ConfigProvider,
  type StateStore,
} from '@platform/interfaces';
import { withProcessServices } from '@platform/processRuntime';
import { DEFAULT_HELPER_MODEL } from '@shared/constants/defaultModels';
import {
  BASH_APPROVAL_CONFIG_KEY,
  AGENT_SKILLS_CONFIG_KEY,
} from '@shared/schemas';
import type { ModelOptionData } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { closeSessionOf } from '@test/support/sessionEnd';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { testRuntime } from '@test/support/testProcessRuntime';
import {
  fakeConfig,
  FakeSecrets,
  FakeStateStore,
} from '@test/support/FakePlatform';
import { createTestSession } from '@test/support/sessionTestUtils';
import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';
import { TexraStateKey } from '@texra/shared/settingsView/texraSettings';
import {
  DEFAULT_LATEX_SETTINGS_STATUS,
  SettingsViewInboundMessageSchema,
  type DerivedSettingsSnapshot,
} from '@texra/shared/settingsView/settingsViewMessages';
import { DocumentsStateKey } from '@texra/shared/settingsView/documentsSettings';

import {
  commandOf,
  createStubSettingsBindings,
} from './desktopSettingsTestSupport';
import type { ModelOptionStores } from '@texra-ai/harness';

const readModelOptions = vi.hoisted(() =>
  vi.fn((_stores: ModelOptionStores, models: readonly string[] = []) =>
    Effect.succeed(models.map((model) => ({ value: model, label: model }))),
  ),
);

// The LaTeX page spawns the LaTeX probes; a fixed status keeps the suite off
// the machine's tools, as the harness's unprobed tool availability does for
// the Tools page.
vi.mock(
  '@texra/controllers/settingsView/LatexToolingController',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@texra/controllers/settingsView/LatexToolingController')
    >()),
    detectLatexSettingsStatus: () =>
      Effect.succeed(DEFAULT_LATEX_SETTINGS_STATUS),
  }),
);

vi.mock('@model/computeModelOptions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@model/computeModelOptions')>()),
  readModelOptions,
  // The mocked read resolves the rows this fixture wants; the pure finisher
  // hands them back.
}));
// The availability read is stubbed to rows already.
vi.mock('@texra/model/modelOptions', () => ({
  modelOptionsFrom: (rows: readonly ModelOptionData[]) => rows,
}));

type DesktopSettingsIpcModule =
  typeof import('@desktop/main/desktopSettingsIpc');

type DesktopSettingsIpcOptions = Parameters<
  DesktopSettingsIpcModule['createDesktopSettingsIpc']
>[0];
type Bindings = DesktopSettingsIpcOptions['bindings'];
type RendererMessage = unknown;

interface SettingsFixtureOverrides {
  globalState?: StateStore;
  workspaceState?: StateStore;
  repoState?: StateStore;
  config?: ConfigProvider;
  bindings?: Partial<Bindings>;
  postToRenderer?: (message: RendererMessage) => void;
}

let createDesktopSettingsIpc!: DesktopSettingsIpcModule['createDesktopSettingsIpc'];

const liveScopes: Scope.Closeable[] = [];

async function createSettingsFixture(overrides: SettingsFixtureOverrides = {}) {
  const {
    globalState = new FakeStateStore(),
    workspaceState = new FakeStateStore(),
    repoState = new FakeStateStore(),
    config = fakeConfig(),
    postToRenderer = () => undefined,
  } = overrides;
  // The paper's three setting slots reach the body through its session's
  // roots, as the desktop passes them.
  const session = await Effect.runPromise(
    createTestSession({
      roots: {
        ...testWorkspaceRoots(),
        storage: '/workspace/settings-ipc/storage',
        config,
        workspaceState,
        repoState,
        globalState,
      },
    }),
  );
  // One root holds one session: released at test end, or the next fixture
  // over this root would get this test's session and its workspace state.
  onTestFinished(() => Effect.runPromise(closeSessionOf(session)));
  // The IPC subscribes to the process app-signal bus, so a fixture whose
  // scope stayed open would keep reacting to later tests' emits.
  const scope = Scope.makeUnsafe();
  liveScopes.push(scope);
  const settings = testRuntime().runSync(
    createDesktopSettingsIpc({
      spawn: (program) => {
        testRuntime().runFork(program);
      },
      bindings: createStubSettingsBindings({
        post: (message) =>
          Effect.flatMap(message, (built) =>
            Effect.sync(() => postToRenderer(built)),
          ),
        ...overrides.bindings,
      }),
      signInPresentation: {
        openSubscriptionSignInUrl: () => Effect.void,
        presentSubscriptionSignInUrl: () => Effect.void,
        presentSubscriptionDeviceCode: () => Effect.void,
      },
      secrets: new FakeSecrets(),
      resourcesPath: '/resources',
      roots: session.roots,
    }).pipe(
      // Runs an owned command's program the way the window's router does.
      Effect.map((ipc) => ({
        ...ipc,
        // Whether the shared inbound schema takes the message; a message it
        // rejects runs a warning and nothing else.
        handleMessage(message: Parameters<typeof ipc.route>[0]) {
          testRuntime().runFork(ipc.route(message));
          return Result.isSuccess(
            Schema.decodeUnknownResult(SettingsViewInboundMessageSchema)(
              message,
            ),
          );
        },
      })),
      Scope.provide(scope),
    ),
  );
  return { globalState, session, settings, workspaceState };
}

async function createCapturedSettingsFixture(
  overrides: Omit<SettingsFixtureOverrides, 'postToRenderer'> = {},
) {
  const posted: RendererMessage[] = [];
  const fixture = await createSettingsFixture({
    ...overrides,
    postToRenderer: (message) => posted.push(message),
  });
  return { ...fixture, posted };
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

async function createFailureReportingFixture(workspaceState: FakeStateStore) {
  const showErrorMessage = vi.fn(() => Effect.void);
  const { settings, posted } = await createCapturedSettingsFixture({
    workspaceState,
    bindings: {
      notify: { showInfoMessage: () => Effect.void, showErrorMessage },
    },
  });
  return { settings, showErrorMessage, posted };
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) =>
    setImmediate(() => setImmediate(() => resolve())),
  );
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

  it.live('persists model settings through global state', () =>
    Effect.gen(function* () {
      const workspaceState = new FakeStateStore();
      const globalState = new FakeStateStore({
        [GlobalStateKey.MODEL_SELECTION]: {
          enabledExtras: ['openai/gpt-5.5-2026-04-23'],
          disabledDefaults: [],
        },
        [GlobalStateKey.HELPER_MODEL]: 'openai/gpt-5.5-2026-04-23',
      });

      const showErrorMessage = vi.fn(() => Effect.void);
      const refreshCatalogs = vi.fn(() => Effect.void);
      const { settings, posted } = yield* Effect.promise(() =>
        createCapturedSettingsFixture({
          workspaceState,
          globalState,
          bindings: {
            refreshCatalogs,
            notify: { showInfoMessage: () => Effect.void, showErrorMessage },
          },
        }),
      );

      expect(
        settings.handleMessage({
          command: SETTINGS_VIEW_COMMANDS.SET_MODEL_ENABLED,
          modelName: 'openai/gpt-5.5-2026-04-23',
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
      expect(showErrorMessage).not.toHaveBeenCalled();
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
      expect(refreshCatalogs).toHaveBeenCalledOnce();

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

  it('writes the bash-approval toggle to the local config scope, not global or the project file', async () => {
    const config = fakeConfig();
    const update = vi.spyOn(config, 'update');

    const { settings, posted } = await createCapturedSettingsFixture({
      config,
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
    // be written to the global config target (see issue #7085), nor to the
    // project file a cloned repository controls.
    expect(update).toHaveBeenCalledWith(
      'texra.toolUse.requireBashApproval',
      false,
      'local',
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
      key: TexraStateKey.LATEX_FORMATTER,
      message: 'workspace write failed',
      cause: new Error('workspace write failed'),
    });
    vi.spyOn(workspaceState, 'update').mockReturnValueOnce(
      Effect.fail(failure),
    );
    const { settings, showErrorMessage, posted } =
      await createFailureReportingFixture(workspaceState);

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
        key: TexraStateKey.LATEX_FORMATTER,
        value: 'none',
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(showErrorMessage).toHaveBeenCalledWith(
      'Failed to update “LaTeX formatter”: workspace write failed',
    );
    expect(latexSnapshotCount(posted)).toBe(1);
  });

  it('reports rejected setting values and restores the authoritative snapshot', async () => {
    const workspaceState = new FakeStateStore();
    const update = vi.spyOn(workspaceState, 'update');
    const { settings, showErrorMessage, posted } =
      await createFailureReportingFixture(workspaceState);

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
        key: DocumentsStateKey.LATEXDIFF_MATH_MARKUP,
        value: 'bogus',
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(update).not.toHaveBeenCalled();
    expect(showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Invalid value for “Math markup in diffs”:'),
    );
    expect(latexSnapshotCount(posted)).toBe(1);
  });

  it('keeps a workspace-scoped row unwritten while no folder is open', async () => {
    const config = fakeConfig();
    const update = vi.spyOn(config, 'update');
    const showInfoMessage = vi.fn(() => Effect.void);
    const { settings, posted } = await createCapturedSettingsFixture({
      config,
      bindings: {
        requiresOpenWorkspace: () => true,
        notify: { showInfoMessage, showErrorMessage: () => Effect.void },
      },
    });

    settings.handleMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
      key: AGENT_SKILLS_CONFIG_KEY,
      value: false,
    });
    await flushAsyncWork();

    expect(update).not.toHaveBeenCalled();
    expect(showInfoMessage).toHaveBeenCalledWith(
      'Open a workspace folder before changing the “Enable skills for agents” setting.',
    );
    // The switch is restored from the authoritative snapshot.
    expect(findSnapshot(posted, 'skills')).toBeDefined();
  });

  it('requires UI confirmation before deleting memory', async () => {
    const confirm = vi.fn(() => Effect.succeed(false));
    const { settings, posted } = await createCapturedSettingsFixture({
      bindings: {
        prompt: { ...createStubSettingsBindings().prompt, confirm },
      },
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.DELETE_MEMORY,
        storagePath: 'memory/example.md',
        displayPath: 'example.md',
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(confirm).toHaveBeenCalledWith('Delete "example.md"?', {
      modal: true,
      confirmLabel: 'Delete',
    });
    expect(posted).toEqual([]);
  });
});
