import { it } from '@effect/vitest';
import { Deferred, Effect, Exit, Scope } from 'effect';
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
import { isUnsupported } from '@shared/utils/dispatcher';
import { testRuntime } from '@test/support/testProcessRuntime';
import { createDeferred } from '@test/support/asyncTestUtils';
import { FakeConfigProvider, FakeStateStore } from '@test/support/FakePlatform';
import type { ToolProbeInputs } from '@tools/toolProbes';
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

const liveScopes: Scope.Closeable[] = [];

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
  const controller = new DefaultDesktopToolingSettingsController({
    onError: (error) => {
      reportedErrors.push(error);
      hooks.onErrorReport?.(error, reportedErrors);
    },
    config: new FakeConfigProvider(),
    globalState,
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
      findPath: () => Effect.succeed(null),
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
  // The controller follows a process-global bus, so a fixture whose scope
  // stayed open would keep reacting to later tests' emits.
  const scope = Scope.makeUnsafe();
  liveScopes.push(scope);
  testRuntime().runSync(
    Effect.forkIn(controller.followToolAvailability, scope, {
      startImmediately: true,
    }),
  );

  return {
    controller,
    commands,
    globalState,
    posted,
    reportedErrors,
  };
}

describe('DefaultDesktopToolingSettingsController', () => {
  beforeEach(installDefaultToolDataDoubles);

  afterEach(() => {
    for (const scope of liveScopes.splice(0))
      testRuntime().runFork(Scope.close(scope, Exit.void));
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
            if (posted.length === 3)
              Deferred.doneUnsafe(repainted, Effect.void);
          },
        },
      );

      yield* withProcessServices(testRuntime(), controller.postStartupData());

      // `postStartupData` fans the dashboard and LaTeX reads out with
      // `Effect.all`, so which of the two posts first is not a contract; that
      // both land before the refresh repaint below is.
      expect(posted.map(commandOf).sort()).toEqual(
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
      expect(posted.map(commandOf)).toHaveLength(3);
      expect(posted.map(commandOf).at(-1)).toBe(
        SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
      );
    }),
  );

  it.effect('runs only allowlisted LaTeX installation commands', () =>
    Effect.gen(function* () {
      const { controller, commands } = createFixture();
      const runInstallCommand = controller.latexHandlers.runInstallCommand;
      if (isUnsupported(runInstallCommand)) {
        throw new Error(runInstallCommand.unsupported);
      }

      yield* withProcessServices(
        testRuntime(),
        runInstallCommand({
          command: SETTINGS_VIEW_COMMANDS.RUN_INSTALL_COMMAND,
          installCommand: HOMEBREW_INSTALL_COMMAND,
        }),
      );
      const error = yield* Effect.flip(
        withProcessServices(
          testRuntime(),
          runInstallCommand({
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
