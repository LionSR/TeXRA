import { layer } from '@effect/vitest';
import { Effect, FiberSet, Result, Schema } from 'effect';
import { expect, vi } from 'vitest';
import { APPROVAL_POLICY_SETTING } from '@texra-ai/harness/schemas';
import type { DesktopSettingsIpcOptions } from '@desktop/main/desktopSettingsIpc';
import { fakeConfig, FakeStateStore } from '@test/support/FakePlatform';
import { FakeHost, SessionGraph, TestSession } from '@test/support/testKernel';
import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';
import {
  DEFAULT_LATEX_SETTINGS_STATUS,
  SettingsViewInboundMessageSchema,
} from '@texra/shared/settingsView/settingsViewMessages';
import type { ConfigProvider, ProcessServices } from '@texra-ai/harness/host';

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

const noOpEffect = (): Effect.Effect<void> => Effect.void;

/** Inert settings bindings; a test overrides the members it observes. */
function createStubSettingsBindings(): DesktopSettingsIpcOptions['bindings'] {
  return {
    post: noOpEffect,
    dialogs: {
      notify: noOpEffect,
      input: () => Effect.succeed(undefined),
      confirm: () => Effect.succeed(true),
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
  };
}

/**
 * The settings IPC over a session whose roots carry `config` and stores of
 * their own, for the test's scope: one root holds one session, and the IPC
 * subscribes to the process app-signal bus, so both end with the test.
 */
const createSettingsFixture = (config: ConfigProvider) =>
  Effect.gen(function* () {
    // The paper's three setting slots reach the body through its session's
    // roots, as the desktop passes them.
    const host = yield* FakeHost;
    const session = yield* TestSession.open({
      ...host.roots,
      storage: host.path('workspace/settings-ipc/storage'),
      config,
      workspaceState: new FakeStateStore(),
      repoState: new FakeStateStore(),
      globalState: new FakeStateStore(),
    });
    const runtime = yield* SessionGraph.runtime;
    // What the IPC spawns runs in the case's scope, which interrupts it on
    // close, instead of on the runtime where nothing joins it.
    const spawn = yield* FiberSet.makeRuntime<ProcessServices>().pipe(
      Effect.provide(yield* runtime.contextEffect),
    );
    const { createDesktopSettingsIpc } = yield* Effect.promise(
      () => import('@desktop/main/desktopSettingsIpc'),
    );
    const ipc = yield* createDesktopSettingsIpc({
      spawn: (program) => {
        spawn(program);
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
          spawn(ipc.route(message));
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
              key: APPROVAL_POLICY_SETTING.key,
              value: 'yolo',
            }),
          ).toBe(true);
          yield* Effect.promise(flushAsyncWork);

          expect(config.get(APPROVAL_POLICY_SETTING.key)).toBe('yolo');
          // Security-adjacent scope pin: a per-workspace approval bypass must
          // never be written to the global config target (see issue #7085),
          // nor to the project file a cloned repository controls.
          expect(update).toHaveBeenCalledWith(
            APPROVAL_POLICY_SETTING.key,
            'yolo',
            'local',
          );
        }),
    );
  },
);
