import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LatexToolingController } from '@controllers/settingsView/LatexToolingController';
import type { ToolTerminalAction } from '@controllers/settingsView/ToolDashboardData';
import { DefaultDesktopToolingSettingsController } from '@desktop/main/desktopToolingSettingsController';
import { appSignals } from '@eventBus/AppSignals';
import { effectRuntime } from '@platform/processRuntime';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { ToolCommandKind, ToolDashboardItem } from '@shared/schemas';
import { HOMEBREW_INSTALL_COMMAND } from '@shared/constants/latexToolchain';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { assertSupported, isUnsupported } from '@shared/utils/dispatcher';
import { FakeConfigProvider, FakeStateStore } from '@test/support/FakePlatform';
import type { ExternalToolCheckResult } from '@tools/toolAvailability';

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
      cached?: ExternalToolCheckResult[],
    ) => Effect.promise(() => toolData.buildItems(host, cached)),
    planToolTerminalAction: toolData.planTerminalAction,
  }),
);

vi.mock('@tools/toolAvailability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tools/toolAvailability')>()),
  getLastCheckResults: () => toolData.lastCheckResults(),
  refreshToolAvailability: () =>
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
    appSignals.emit('toolAvailabilityChanged', undefined);
  });
  toolData.planTerminalAction.mockImplementation(({ toolId, commandKind }) => ({
    kind: 'terminal',
    name: toolId,
    command: `${commandKind}:${toolId}`,
  }));
}

function createFixture(overrides: Partial<ControllerOptions> = {}) {
  const posted: unknown[] = [];
  const reportedErrors: unknown[] = [];
  const commands: string[] = [];
  const openedUrls: string[] = [];
  const globalState = overrides.globalState ?? new FakeStateStore();
  const workspaceState = overrides.workspaceState ?? new FakeStateStore();
  const controller = new DefaultDesktopToolingSettingsController({
    onError: (error) => reportedErrors.push(error),
    config: new FakeConfigProvider(),
    globalState,
    workspaceState,
    renderer: {
      postToRenderer: (message) => posted.push(message),
    },
    navigation: {
      openExternal: async (url) => {
        openedUrls.push(url);
      },
    },
    commands: {
      run: async (command) => {
        commands.push(command);
      },
    },
    latexToolingController: new LatexToolingController({
      checkToolInstalled: async () => false,
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
    runtime: overrides.runtime ?? effectRuntime(),
  });
  // The controller subscribes to a process-global bus, so a fixture left
  // undisposed would keep reacting to later tests' emits.
  liveControllers.push(controller);

  return {
    controller,
    commands,
    globalState,
    openedUrls,
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

  it('posts cached startup data before refreshing external tools', async () => {
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
      appSignals.emit('toolAvailabilityChanged', undefined);
    });
    const { controller, posted } = createFixture();

    controller.postLatexConfigValues();
    await controller.postStartupData();

    expect(posted.map(commandOf)).toEqual([
      SETTINGS_VIEW_COMMANDS.UPDATE_SETTINGS_SNAPSHOT,
      SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
      SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_SETTINGS_STATUS,
    ]);
    // A cold probe cache stays `undefined` so the dashboard build runs the
    // probes; coercing it to `[]` would render "zero external tools".
    expect(buildInputs).toEqual([undefined]);

    finishRefresh?.();
    await vi.waitFor(() => {
      expect(posted.map(commandOf)).toEqual([
        SETTINGS_VIEW_COMMANDS.UPDATE_SETTINGS_SNAPSHOT,
        SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
        SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_SETTINGS_STATUS,
        SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
      ]);
    });
  });

  it('reports a background tool refresh failure without blocking startup', async () => {
    const refreshError = new Error('tool probe failed');
    toolData.refreshAvailability.mockRejectedValue(refreshError);
    const { controller, reportedErrors } = createFixture();

    await controller.postStartupData();

    await vi.waitFor(() => {
      expect(reportedErrors).toEqual([refreshError]);
    });
  });

  it('persists a toggle before refreshing caches and posting cached data', async () => {
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
    const { controller } = createFixture({
      globalState,
      renderer: {
        postToRenderer: () => events.push('renderer:post'),
      },
    });

    await assertSupported(controller.toolHandlers.toggleTool)({
      command: SETTINGS_VIEW_COMMANDS.TOGGLE_TOOL,
      toolId: 'zotero',
      enabled: false,
    });

    expect(globalState.get(GlobalStateKey.DISABLED_TOOLS)).toEqual(['zotero']);
    expect(events).toEqual([
      'state:update',
      'dashboard:cached',
      'dashboard:build',
      'renderer:post',
    ]);
  });

  it('completes a fresh availability check before rebuilding the dashboard', async () => {
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
      appSignals.emit('toolAvailabilityChanged', undefined);
    });
    const { controller } = createFixture({
      renderer: {
        postToRenderer: () => events.push('renderer:post'),
      },
    });

    await assertSupported(controller.toolHandlers.recheckToolStatus)({
      command: SETTINGS_VIEW_COMMANDS.RECHECK_TOOL_STATUS,
    });
    await vi.waitFor(() => {
      expect(events).toContain('renderer:post');
    });

    expect(events).toEqual([
      'dashboard:refresh',
      'dashboard:cached',
      'dashboard:build',
      'renderer:post',
    ]);
  });

  it('runs planned tool commands and reports why a plan produced none', async () => {
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
    const { controller, commands, reportedErrors } = createFixture();

    await assertSupported(controller.toolHandlers.runToolCommand)({
      command: SETTINGS_VIEW_COMMANDS.RUN_TOOL_COMMAND,
      toolId: 'codex',
      kind: 'install',
    });
    await assertSupported(controller.toolHandlers.runToolCommand)({
      command: SETTINGS_VIEW_COMMANDS.RUN_TOOL_COMMAND,
      toolId: 'codex',
      kind: 'auth',
    });

    expect(toolData.planTerminalAction).toHaveBeenNthCalledWith(1, {
      toolId: 'codex',
      commandKind: 'install',
    });
    expect(toolData.planTerminalAction).toHaveBeenNthCalledWith(2, {
      toolId: 'codex',
      commandKind: 'auth',
    });
    expect(commands).toEqual(['npm install codex']);
    expect(reportedErrors.map((error) => (error as Error).message)).toEqual([
      'No auth command for tool "codex" (missingCommand)',
    ]);
  });

  it('runs only allowlisted LaTeX installation commands', async () => {
    const { controller, commands } = createFixture();

    await assertSupported(controller.latexHandlers.runInstallCommand)({
      command: SETTINGS_VIEW_COMMANDS.RUN_INSTALL_COMMAND,
      installCommand: HOMEBREW_INSTALL_COMMAND,
    });
    await expect(
      assertSupported(controller.latexHandlers.runInstallCommand)({
        command: SETTINGS_VIEW_COMMANDS.RUN_INSTALL_COMMAND,
        installCommand: 'echo not-allowlisted',
      }),
    ).rejects.toThrow('Rejected unknown install command: echo not-allowlisted');

    expect(commands).toEqual([HOMEBREW_INSTALL_COMMAND]);
  });

  it('declares extension installs unsupported and strips their dashboard affordance', async () => {
    toolData.buildItems.mockResolvedValue([
      {
        ...DASHBOARD_ITEM,
        installActions: [
          { kind: 'extension', extensionId: 'leanprover.lean4' },
        ],
      },
    ]);
    const { controller, posted } = createFixture();

    expect(isUnsupported(controller.toolHandlers.installToolExtension)).toBe(
      true,
    );
    expect(isUnsupported(controller.latexHandlers.installLatexWorkshop)).toBe(
      true,
    );

    await assertSupported(controller.toolHandlers.recheckToolStatus)({
      command: SETTINGS_VIEW_COMMANDS.RECHECK_TOOL_STATUS,
    });

    await vi.waitFor(() => {
      expect(posted.at(-1)).toEqual({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
        items: [DASHBOARD_ITEM],
      });
    });
  });
});
