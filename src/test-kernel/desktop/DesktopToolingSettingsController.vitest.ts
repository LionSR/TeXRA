import { it } from '@effect/vitest';
import { Deferred, Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { LatexToolingController } from '@controllers/settingsView/LatexToolingController';
import type { ToolTerminalAction } from '@controllers/settingsView/ToolDashboardData';
import { DefaultDesktopToolingSettingsController } from '@desktop/main/desktopToolingSettingsController';
import { emitAppSignal } from '@eventBus/AppSignals';
import { withProcessServices } from '@platform/processRuntime';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type {
  ToolCommandKind,
  ToolDashboardItem,
} from '@shared/settingsView/settingsViewMessages';
import { HOMEBREW_INSTALL_COMMAND } from '@shared/constants/latexToolchain';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { assertSupported, isUnsupported } from '@shared/utils/dispatcher';
import { testRuntime } from '@test/support/testProcessRuntime';
import { createDeferred } from '@test/support/asyncTestUtils';
import { FakeConfigProvider, FakeStateStore } from '@test/support/FakePlatform';
import type { ToolProbeInputs } from '@tools/externalToolDefs';
import {
  refreshToolAvailability,
  type ExternalToolCheckResult,
} from '@tools/toolAvailability';

import { commandOf } from './desktopSettingsTestSupport';

/**
 * The controller calls the host-neutral dashboard and availability functions
 * directly, so the seam the fixtures drive is those modules — the doubles
 * keep the real call shapes, and the probes never run.
 */
const toolData = vi.hoisted(() => ({
  buildItems:
    vi.fn<
      (
        host: string,
        cached?: ExternalToolCheckResult[],
      ) => Promise<ToolDashboardItem[]>
    >(),
  lastCheckResults: vi.fn<() => ExternalToolCheckResult[] | null>(),
  refreshAvailability: vi.fn<() => Promise<void>>(),
  planTerminalAction:
    vi.fn<
      (input: {
        toolId: string;
        commandKind: ToolCommandKind;
      }) => ToolTerminalAction
    >(),
}));

vi.mock(
  '@controllers/settingsView/ToolDashboardData',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@controllers/settingsView/ToolDashboardData')
    >()),
    buildToolDashboardItems: (
      host: string,
      _probeInputs: ToolProbeInputs,
      cached?: ExternalToolCheckResult[],
    ) => Effect.promise(() => toolData.buildItems(host, cached)),
    planToolTerminalAction: toolData.planTerminalAction,
  }),
);

vi.mock('@tools/toolAvailability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tools/toolAvailability')>()),
  getLastCheckResults: () => toolData.lastCheckResults(),
  refreshToolAvailability: (_probeInputs: ToolProbeInputs) =>
    Effect.tryPromise({
      try: () => toolData.refreshAvailability(),
      catch: (cause) => cause as Error,
    }),
}));

/**
 * Wraps `store.update` with a synchronous hook fired before the write, so a
 * test can interleave state persistence with other async event sources in a
 * single ordered `events` log without reaching into the fake's internals.
 */
function spyOnUpdate(
  store: FakeStateStore,
  onUpdate: (key: string) => void,
): FakeStateStore {
  const originalUpdate = store.update.bind(store);
  vi.spyOn(store, 'update').mockImplementation((key, value) => {
    onUpdate(key);
    return originalUpdate(key, value);
  });
  return store;
}

const DASHBOARD_ITEM: ToolDashboardItem = {
  id: 'zotero',
  name: 'Zotero Integration',
  category: 'academic',
  description: 'Citation tools',
  tools: [],
  status: 'available',
  requiresSetup: true,
  installActions: [],
  toggleable: true,
  enabled: true,
};

type ControllerOptions = ConstructorParameters<
  typeof DefaultDesktopToolingSettingsController
>[0];

const liveControllers: DefaultDesktopToolingSettingsController[] = [];

/** Restores the doubles a test has not replaced. The refresh double emits as
 *  the real `refreshToolAvailability` does once its probes land: that emit is
 *  what repaints the dashboard, so a silent double would leave the controller
 *  with nothing to react to. */
function installDefaultToolDataDoubles(): void {
  toolData.buildItems.mockImplementation(async () => [DASHBOARD_ITEM]);
  toolData.lastCheckResults.mockImplementation(() => []);
  toolData.refreshAvailability.mockImplementation(async () => {
    emitAppSignal('toolAvailabilityChanged', undefined);
  });
  toolData.planTerminalAction.mockImplementation(({ toolId, commandKind }) => ({
    kind: 'terminal',
    name: toolId,
    command: `${commandKind}:${toolId}`,
  }));
}

function createFixture(
  overrides: Partial<ControllerOptions> = {},
  hooks: {
    onPost?: (message: unknown, posted: unknown[]) => void;
    onErrorReport?: (error: unknown, reportedErrors: unknown[]) => void;
  } = {},
) {
  const posted: unknown[] = [];
  const reportedErrors: unknown[] = [];
  const commands: string[] = [];
  const globalState = overrides.globalState ?? new FakeStateStore();
  const workspaceState = overrides.workspaceState ?? new FakeStateStore();
  const controller = new DefaultDesktopToolingSettingsController({
    onError: (error) => {
      reportedErrors.push(error);
      hooks.onErrorReport?.(error, reportedErrors);
    },
    config: new FakeConfigProvider(),
    globalState,
    workspaceState,
    workspaceRoot: undefined,
    renderer: {
      postToRenderer: (message) => {
        posted.push(message);
        hooks.onPost?.(message, posted);
      },
    },
    commands: {
      run: async (command) => {
        commands.push(command);
      },
    },
    latexToolingController: new LatexToolingController({
      checkToolInstalled: () => Effect.succeed(false),
      findPath: () => null,
      detectPackageManager: () => null,
      getPlatform: () => 'linux',
      isLatexWorkshopInstalled: () => false,
      getRecommendedStatus: () => ({
        outDir: true,
        autoRevealExclude: true,
      }),
    }),
    ...overrides,
    // The controller settles every write on the runtime it is handed; the
    // spread above makes any overridden member possibly undefined, so the
    // default is restated here rather than left to the fixture's shape.
    runtime: overrides.runtime ?? testRuntime(),
  });
  // The controller subscribes to a process-global bus, so a fixture left
  // undisposed would keep reacting to later tests' emits.
  liveControllers.push(controller);

  return {
    controller,
    commands,
    globalState,
    posted,
    reportedErrors,
    workspaceState,
  };
}

describe('DefaultDesktopToolingSettingsController', () => {
  beforeEach(installDefaultToolDataDoubles);

  afterEach(() => {
    for (const controller of liveControllers.splice(0)) controller.dispose();
  });

  it.live('posts cached startup data before refreshing external tools', () =>
    Effect.gen(function* () {
      let finishRefresh: (() => void) | undefined;
      const refreshPending = new Promise<void>((resolve) => {
        finishRefresh = resolve;
      });
      const buildInputs: (ExternalToolCheckResult[] | undefined)[] = [];
      toolData.buildItems.mockImplementation(async (_host, results) => {
        buildInputs.push(results);
        return [DASHBOARD_ITEM];
      });
      toolData.lastCheckResults.mockReturnValue(null);
      toolData.refreshAvailability.mockImplementation(async () => {
        await refreshPending;
        emitAppSignal('toolAvailabilityChanged', undefined);
      });
      const repainted = Deferred.makeUnsafe<void>();
      const { controller, posted } = createFixture(
        {},
        {
          onPost: (_message, posted) => {
            if (posted.length === 4)
              Deferred.doneUnsafe(repainted, Effect.void);
          },
        },
      );

      yield* controller.postLatexConfigValues();
      yield* withProcessServices(testRuntime(), controller.postStartupData());

      const startup = posted.map(commandOf);
      expect(startup[0]).toBe(SETTINGS_VIEW_COMMANDS.UPDATE_SETTINGS_SNAPSHOT);
      // `postStartupData` fans the dashboard and LaTeX reads out with
      // `Effect.all`, so which of the two posts first is not a contract; that
      // both land before the refresh repaint below is.
      expect([...startup.slice(1)].sort()).toEqual(
        [
          SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
          SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_SETTINGS_STATUS,
        ].sort(),
      );
      // A cold probe cache stays `undefined` so the dashboard build runs the
      // probes; coercing it to `[]` would render "zero external tools".
      expect(buildInputs).toEqual([undefined]);

      finishRefresh?.();
      yield* Deferred.await(repainted);
      expect(posted.map(commandOf)).toHaveLength(4);
      expect(posted.map(commandOf).at(-1)).toBe(
        SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
      );
    }),
  );

  it.live(
    'reports a background tool refresh failure without blocking startup',
    () =>
      Effect.gen(function* () {
        const refreshError = new Error('tool probe failed');
        toolData.refreshAvailability.mockRejectedValue(refreshError);
        const errorReported = Deferred.makeUnsafe<void>();
        const { controller, reportedErrors } = createFixture(
          {},
          {
            onErrorReport: (_error, reportedErrors) => {
              if (reportedErrors.length === 1) {
                Deferred.doneUnsafe(errorReported, Effect.void);
              }
            },
          },
        );

        yield* withProcessServices(testRuntime(), controller.postStartupData());

        yield* Deferred.await(errorReported);
        expect(reportedErrors).toEqual([refreshError]);
      }),
  );

  it.effect(
    'persists a toggle before refreshing caches and posting cached data',
    () =>
      Effect.gen(function* () {
        const events: string[] = [];
        const cachedResults: ExternalToolCheckResult[] = [];
        const globalState = spyOnUpdate(new FakeStateStore(), () =>
          events.push('state:update'),
        );
        toolData.buildItems.mockImplementation(async (_host, results) => {
          expect(results).toBe(cachedResults);
          events.push('dashboard:build');
          return [DASHBOARD_ITEM];
        });
        toolData.lastCheckResults.mockImplementation(() => {
          events.push('dashboard:cached');
          return cachedResults;
        });
        const posted = createDeferred();
        const { controller } = createFixture({
          globalState,
          renderer: {
            postToRenderer: () => {
              events.push('renderer:post');
              posted.resolve();
            },
          },
        });

        yield* withProcessServices(
          testRuntime(),
          assertSupported(controller.toolHandlers.toggleTool)({
            command: SETTINGS_VIEW_COMMANDS.TOGGLE_TOOL,
            toolId: 'zotero',
            enabled: false,
          }),
        );

        expect(
          yield* withProcessServices(
            testRuntime(),
            globalState.get(GlobalStateKey.DISABLED_TOOLS),
          ),
        ).toEqual(['zotero']);
        // The repaint the toggle's re-probe triggers runs on the subscriber's own
        // fiber, so the order below settles a turn after the toggle resolves.
        yield* Effect.promise(() => posted.promise);
        expect(events).toEqual([
          'state:update',
          'dashboard:cached',
          'dashboard:build',
          'renderer:post',
        ]);
      }),
  );

  it.effect(
    'completes a fresh availability check before rebuilding the dashboard',
    () =>
      Effect.gen(function* () {
        const events: string[] = [];
        toolData.buildItems.mockImplementation(async () => {
          events.push('dashboard:build');
          return [DASHBOARD_ITEM];
        });
        toolData.lastCheckResults.mockImplementation(() => {
          events.push('dashboard:cached');
          return [];
        });
        toolData.refreshAvailability.mockImplementation(async () => {
          events.push('dashboard:refresh');
          emitAppSignal('toolAvailabilityChanged', undefined);
        });
        const posted = createDeferred();
        createFixture({
          renderer: {
            postToRenderer: () => {
              events.push('renderer:post');
              posted.resolve();
            },
          },
        });

        yield* withProcessServices(
          testRuntime(),
          refreshToolAvailability({
            workspaceRoot: undefined,
            config: new FakeConfigProvider(),
          }),
        );
        yield* Effect.promise(() => posted.promise);
        expect(events).toContain('renderer:post');

        expect(events).toEqual([
          'dashboard:refresh',
          'dashboard:cached',
          'dashboard:build',
          'renderer:post',
        ]);
      }),
  );

  it.effect(
    'runs planned tool commands and fails when a plan produced none',
    () =>
      Effect.gen(function* () {
        const plans: ToolTerminalAction[] = [
          {
            kind: 'terminal',
            name: 'TeXRA: OpenAI Codex CLI',
            command: 'npm install codex',
          },
          { kind: 'none', reason: 'missingCommand' },
        ];
        toolData.buildItems.mockResolvedValue([]);
        toolData.planTerminalAction.mockImplementation(
          () => plans.shift() as ToolTerminalAction,
        );
        const { controller, commands } = createFixture();

        yield* withProcessServices(
          testRuntime(),
          assertSupported(controller.toolHandlers.runToolCommand)({
            command: SETTINGS_VIEW_COMMANDS.RUN_TOOL_COMMAND,
            toolId: 'codex',
            kind: 'install',
          }),
        );
        const error = yield* Effect.flip(
          withProcessServices(
            testRuntime(),
            assertSupported(controller.toolHandlers.runToolCommand)({
              command: SETTINGS_VIEW_COMMANDS.RUN_TOOL_COMMAND,
              toolId: 'codex',
              kind: 'auth',
            }),
          ),
        );

        expect(toolData.planTerminalAction).toHaveBeenNthCalledWith(1, {
          toolId: 'codex',
          commandKind: 'install',
        });
        expect(toolData.planTerminalAction).toHaveBeenNthCalledWith(2, {
          toolId: 'codex',
          commandKind: 'auth',
        });
        expect(commands).toEqual(['npm install codex']);
        expect(error.message).toBe(
          'No auth command for tool "codex" (missingCommand)',
        );
      }),
  );

  it.effect('runs only allowlisted LaTeX installation commands', () =>
    Effect.gen(function* () {
      const { controller, commands } = createFixture();

      yield* withProcessServices(
        testRuntime(),
        assertSupported(controller.latexHandlers.runInstallCommand)({
          command: SETTINGS_VIEW_COMMANDS.RUN_INSTALL_COMMAND,
          installCommand: HOMEBREW_INSTALL_COMMAND,
        }),
      );
      const error = yield* Effect.flip(
        withProcessServices(
          testRuntime(),
          assertSupported(controller.latexHandlers.runInstallCommand)({
            command: SETTINGS_VIEW_COMMANDS.RUN_INSTALL_COMMAND,
            installCommand: 'echo not-allowlisted',
          }),
        ),
      );
      expect(error.message).toBe(
        'Rejected unknown install command: echo not-allowlisted',
      );

      expect(commands).toEqual([HOMEBREW_INSTALL_COMMAND]);
    }),
  );

  it.effect(
    'declares extension installs unsupported and strips their dashboard affordance',
    () =>
      Effect.gen(function* () {
        toolData.buildItems.mockResolvedValue([
          {
            ...DASHBOARD_ITEM,
            installActions: [
              { kind: 'extension', extensionId: 'leanprover.lean4' },
            ],
          },
        ]);
        const repainted = createDeferred();
        const { controller, posted } = createFixture(
          {},
          {
            onPost: (_message, posted) => {
              const last = posted.at(-1) as { command?: string } | undefined;
              if (
                last?.command === SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD
              ) {
                repainted.resolve();
              }
            },
          },
        );

        expect(
          isUnsupported(controller.toolHandlers.installToolExtension),
        ).toBe(true);
        expect(
          isUnsupported(controller.latexHandlers.installLatexWorkshop),
        ).toBe(true);

        yield* withProcessServices(
          testRuntime(),
          refreshToolAvailability({
            workspaceRoot: undefined,
            config: new FakeConfigProvider(),
          }),
        );

        yield* Effect.promise(() => repainted.promise);
        expect(posted.at(-1)).toEqual({
          command: SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
          items: [DASHBOARD_ITEM],
        });
      }),
  );
});
