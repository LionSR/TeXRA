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
import type { ModelOptionStores } from '@model/computeModelOptions';
import {
  StateWriteFailed,
  type ConfigProvider,
  type StateStore,
} from '@platform/interfaces';
import { withProcessServices } from '@platform/processRuntime';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { BASH_APPROVAL_CONFIG_KEY } from '@shared/schemas';
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
    }).pipe(Scope.provide(scope)),
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
});
