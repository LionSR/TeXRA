import { layer } from '@effect/vitest';
import { Effect, Result, Schema } from 'effect';
import { beforeAll, expect, vi } from 'vitest';
import { APPROVAL_POLICY_CONFIG_KEY } from '@texra-ai/harness/schemas';
import type { DesktopSettingsIpcOptions } from '@desktop/main/desktopSettingsIpc';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { fakeConfig, FakeStateStore } from '@test/support/FakePlatform';
import { SessionGraph, TestSession } from '@test/support/testKernel';
import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';
import {
  DEFAULT_LATEX_SETTINGS_STATUS,
  SettingsViewInboundMessageSchema,
} from '@texra/shared/settingsView/settingsViewMessages';
import type { ConfigProvider } from '@texra-ai/harness/host';

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
    runInTerminal: noOpEffect,
    latexEditorStatus: () => ({
      outDir: true,
      autoRevealExclude: true,
      latexWorkshopInstalled: false,
    }),
  };
}

let createDesktopSettingsIpc!: DesktopSettingsIpcModule['createDesktopSettingsIpc'];

/**
 * The settings IPC over a session whose roots carry `config` and stores of
 * their own, for the test's scope: one root holds one session, and the IPC
 * subscribes to the process app-signal bus, so both end with the test.
 */
const createSettingsFixture = (config: ConfigProvider) =>
  Effect.gen(function* () {
    // The paper's three setting slots reach the body through its session's
    // roots, as the desktop passes them.
    const session = yield* TestSession.open({
      ...testWorkspaceRoots(),
      storage: '/workspace/settings-ipc/storage',
      config,
      workspaceState: new FakeStateStore(),
      repoState: new FakeStateStore(),
      globalState: new FakeStateStore(),
    });
    const runtime = yield* SessionGraph.runtime;
    const ipc = yield* createDesktopSettingsIpc({
      spawn: (program) => {
        runtime.runFork(program);
      },
      bindings: createStubSettingsBindings(),
      signInPresentation: {
        openSubscriptionSignInUrl: () => Effect.void,
        presentSubscriptionSignInUrl: () => Effect.void,
        presentSubscriptionDeviceCode: () => Effect.void,
      },
      resourcesPath: '/resources',
      roots: session.roots,
    });
    return {
      settings: {
        ...ipc,
        // Whether the shared inbound schema takes the message; a message it
        // rejects runs a warning and nothing else. Runs an owned command's
        // program the way the window's router does.
        handleMessage(message: Parameters<typeof ipc.route>[0]) {
          runtime.runFork(ipc.route(message));
          return Result.isSuccess(
            Schema.decodeUnknownResult(SettingsViewInboundMessageSchema)(
              message,
            ),
          );
        },
      },
    };
  });

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) =>
    setImmediate(() => setImmediate(() => resolve())),
  );
}

// Live clock: the IPC's programs settle on real event-loop turns.
layer(SessionGraph.hosted, { excludeTestServices: true })(
  'desktop settings IPC',
  (it) => {
    beforeAll(async () => {
      ({ createDesktopSettingsIpc } =
        await import('@desktop/main/desktopSettingsIpc'));
    });

    it.effect(
      'writes the approval policy to the local config scope, not global or the project file',
      () =>
        Effect.gen(function* () {
          const config = fakeConfig();
          const update = vi.spyOn(config, 'update');

          const { settings } = yield* createSettingsFixture(config);

          expect(
            settings.handleMessage({
              command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
              key: APPROVAL_POLICY_CONFIG_KEY,
              value: 'yolo',
            }),
          ).toBe(true);
          yield* Effect.promise(flushAsyncWork);

          expect(config.get(APPROVAL_POLICY_CONFIG_KEY)).toBe('yolo');
          // Security-adjacent scope pin: a per-workspace approval bypass must
          // never be written to the global config target (see issue #7085),
          // nor to the project file a cloned repository controls.
          expect(update).toHaveBeenCalledWith(
            APPROVAL_POLICY_CONFIG_KEY,
            'yolo',
            'local',
          );
        }),
    );
  },
);
