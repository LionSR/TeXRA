import { afterEach, describe, expect, it, vi } from 'vitest';

import { LatexToolingController } from '@controllers/settingsView/LatexToolingController';
import { LatexConfigPersistenceController } from '@controllers/settingsView/LatexConfigPersistenceController';
import { DefaultDesktopToolingSettingsController } from '@desktop/main/desktopToolingSettingsController';
import { appSignals } from '@eventBus/AppSignals';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { ToolDashboardItem } from '@shared/schemas';
import { HOMEBREW_INSTALL_COMMAND } from '@shared/constants/latexToolchain';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { assertSupported, isUnsupported } from '@shared/utils/dispatcher';
import { FakeStateStore } from '@test/support/FakePlatform';
import type { ExternalToolCheckResult } from '@tools/toolAvailability';

import { commandOf } from './desktopSettingsTestSupport';

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
  toggleable: true,
  enabled: true,
};

type ControllerOptions = ConstructorParameters<
  typeof DefaultDesktopToolingSettingsController
>[0];

const liveControllers: DefaultDesktopToolingSettingsController[] = [];

/** Dashboard members not listed fall back to the fixture defaults below. */
type FixtureOverrides = Partial<Omit<ControllerOptions, 'dashboard'>> & {
  readonly dashboard?: Partial<ControllerOptions['dashboard']>;
};

function createFixture(overrides: FixtureOverrides = {}) {
  const posted: unknown[] = [];
  const reportedErrors: unknown[] = [];
  const commands: string[] = [];
  const openedUrls: string[] = [];
  const globalState = overrides.globalState ?? new FakeStateStore();
  const workspaceState = overrides.workspaceState ?? new FakeStateStore();
  const dashboard: ControllerOptions['dashboard'] = {
    buildItems: async () => [DASHBOARD_ITEM],
    getCachedCheckResults: async () => [],
    // The real `refreshToolAvailability` always emits once the probes land,
    // and that emit is what repaints the dashboard, so a fake that stays
    // silent would leave the controller with nothing to react to.
    refreshAvailability: async () => {
      appSignals.emit('toolAvailabilityChanged', undefined);
    },
    planTerminalAction: async (toolId, kind) => ({
      kind: 'terminal',
      name: toolId,
      command: `${kind}:${toolId}`,
    }),
    ...overrides.dashboard,
  };
  const controller = new DefaultDesktopToolingSettingsController({
    onError: (error) => reportedErrors.push(error),
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
    latexConfigPersistenceController: new LatexConfigPersistenceController(),
    ...overrides,
    dashboard,
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
  afterEach(() => {
    for (const controller of liveControllers.splice(0)) controller.dispose();
  });

  it('posts cached startup data before refreshing external tools', async () => {
    let finishRefresh: (() => void) | undefined;
    const refreshPending = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    const buildInputs: (ExternalToolCheckResult[] | undefined)[] = [];
    const { controller, posted } = createFixture({
      dashboard: {
        buildItems: async (results) => {
          buildInputs.push(results);
          return [DASHBOARD_ITEM];
        },
        getCachedCheckResults: async () => undefined,
        refreshAvailability: async () => {
          await refreshPending;
          appSignals.emit('toolAvailabilityChanged', undefined);
        },
      },
    });

    controller.postLatexConfigValues();
    await controller.postStartupData();

    expect(posted.map(commandOf)).toEqual([
      SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_CONFIG_VALUES,
      SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
      SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_SETTINGS_STATUS,
    ]);
    // A cold probe cache stays `undefined` so the dashboard build runs the
    // probes; coercing it to `[]` would render "zero external tools".
    expect(buildInputs).toEqual([undefined]);

    finishRefresh?.();
    await vi.waitFor(() => {
      expect(posted.map(commandOf)).toEqual([
        SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_CONFIG_VALUES,
        SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
        SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_SETTINGS_STATUS,
        SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
      ]);
    });
  });

  it('reports a background tool refresh failure without blocking startup', async () => {
    const refreshError = new Error('tool probe failed');
    const { controller, reportedErrors } = createFixture({
      dashboard: {
        refreshAvailability: async () => {
          throw refreshError;
        },
      },
    });

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
    const { controller } = createFixture({
      globalState,
      renderer: {
        postToRenderer: () => events.push('renderer:post'),
      },
      dashboard: {
        buildItems: async (results) => {
          expect(results).toBe(cachedResults);
          events.push('dashboard:build');
          return [DASHBOARD_ITEM];
        },
        getCachedCheckResults: async () => {
          events.push('dashboard:cached');
          return cachedResults;
        },
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

  it('keeps a cold probe cache uncoerced when toggling a tool', async () => {
    const buildInputs: (ExternalToolCheckResult[] | undefined)[] = [];
    const { controller } = createFixture({
      dashboard: {
        buildItems: async (results) => {
          buildInputs.push(results);
          return [DASHBOARD_ITEM];
        },
        getCachedCheckResults: async () => undefined,
      },
    });

    await assertSupported(controller.toolHandlers.toggleTool)({
      command: SETTINGS_VIEW_COMMANDS.TOGGLE_TOOL,
      toolId: 'zotero',
      enabled: false,
    });

    expect(buildInputs).toEqual([undefined]);
  });

  it('completes a fresh availability check before rebuilding the dashboard', async () => {
    const events: string[] = [];
    const { controller } = createFixture({
      renderer: {
        postToRenderer: () => events.push('renderer:post'),
      },
      dashboard: {
        buildItems: async () => {
          events.push('dashboard:build');
          return [DASHBOARD_ITEM];
        },
        getCachedCheckResults: async () => {
          events.push('dashboard:cached');
          return [];
        },
        refreshAvailability: async () => {
          events.push('dashboard:refresh');
          appSignals.emit('toolAvailabilityChanged', undefined);
        },
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
    const planTerminalAction = vi
      .fn<ControllerOptions['dashboard']['planTerminalAction']>()
      .mockResolvedValueOnce({
        kind: 'terminal',
        name: 'TeXRA: OpenAI Codex CLI',
        command: 'npm install codex',
      })
      .mockResolvedValueOnce({ kind: 'none', reason: 'missingCommand' });
    const { controller, commands, reportedErrors } = createFixture({
      dashboard: {
        buildItems: async () => [],
        planTerminalAction,
      },
    });

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

    expect(planTerminalAction).toHaveBeenNthCalledWith(1, 'codex', 'install');
    expect(planTerminalAction).toHaveBeenNthCalledWith(2, 'codex', 'auth');
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

  it('routes install URLs through explicit navigation', async () => {
    const { controller, openedUrls } = createFixture();

    await assertSupported(controller.toolHandlers.openToolInstallUrl)({
      command: SETTINGS_VIEW_COMMANDS.OPEN_TOOL_INSTALL_URL,
      url: 'https://example.com/install',
    });

    expect(openedUrls).toEqual(['https://example.com/install']);
  });

  it('declares extension installs unsupported and strips their dashboard affordance', async () => {
    const { controller, posted } = createFixture({
      dashboard: {
        buildItems: async () => [
          { ...DASHBOARD_ITEM, installExtensionId: 'leanprover.lean4' },
        ],
      },
    });

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
