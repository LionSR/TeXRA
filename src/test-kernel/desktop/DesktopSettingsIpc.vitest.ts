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
import type { DesktopSettingsIpcOptions } from '@desktop/main/desktopSettingsIpc';
import { type ConfigProvider } from '@platform/interfaces';
import { BASH_APPROVAL_CONFIG_KEY } from '@shared/schemas';
import type { ModelOptionData } from '@shared/schemas';
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
import {
  DEFAULT_LATEX_SETTINGS_STATUS,
  SettingsViewInboundMessageSchema,
} from '@texra/shared/settingsView/settingsViewMessages';

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

const noOpEffect = (): Effect.Effect<void> => Effect.void;

/** Inert settings bindings; a test overrides the members it observes. */
function createStubSettingsBindings(): DesktopSettingsIpcOptions['bindings'] {
  return {
    post: noOpEffect,
    notify: { showInfoMessage: noOpEffect, showErrorMessage: noOpEffect },
    prompt: {
      input: () => Effect.succeed(undefined),
      confirm: () => Effect.succeed(true),
      info: () => Effect.succeed(undefined),
      warning: () => Effect.succeed(undefined),
    },
    externalOpener: { openExternal: noOpEffect },
    openPath: noOpEffect,
    revealPath: noOpEffect,
    showReadOnlyYaml: noOpEffect,
    pickFolder: () => Effect.succeed(undefined),
    refreshCatalogs: noOpEffect,
    refreshCredentialStatus: Effect.void,
    revealRun: () => Effect.succeed('revealed'),
    runLabel: () => undefined,
    stateSettingApplied: noOpEffect,
    runInTerminal: noOpEffect,
    latexEditorStatus: () => ({
      outDir: true,
      autoRevealExclude: true,
      latexWorkshopInstalled: false,
    }),
  };
}

let createDesktopSettingsIpc!: DesktopSettingsIpcModule['createDesktopSettingsIpc'];

const liveScopes: Scope.Closeable[] = [];

async function createSettingsFixture(config: ConfigProvider) {
  // The paper's three setting slots reach the body through its session's
  // roots, as the desktop passes them.
  const session = await Effect.runPromise(
    createTestSession({
      roots: {
        ...testWorkspaceRoots(),
        storage: '/workspace/settings-ipc/storage',
        config,
        workspaceState: new FakeStateStore(),
        repoState: new FakeStateStore(),
        globalState: new FakeStateStore(),
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
      bindings: createStubSettingsBindings(),
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
  return { settings };
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

  it('writes the bash-approval toggle to the local config scope, not global or the project file', async () => {
    const config = fakeConfig();
    const update = vi.spyOn(config, 'update');

    const { settings } = await createSettingsFixture(config);

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
  });
});
