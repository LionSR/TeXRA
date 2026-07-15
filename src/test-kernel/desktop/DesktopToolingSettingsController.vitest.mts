// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - settings controllers
import { LatexConfigPersistenceController } from '@controllers/settingsView/LatexConfigPersistenceController';
import { LatexToolingController } from '@controllers/settingsView/LatexToolingController';
import { DefaultDesktopToolingSettingsController } from '@desktop/main/desktopToolingSettingsController';

// Local imports - shared settings
import {
  HOMEBREW_INSTALL_COMMAND,
  LATEX_WORKSHOP_EXT_ID,
} from '@shared/constants/latex';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import { assertSupported } from '@shared/utils/dispatcher';

// Local imports - platform and tool types
import type { StateStore } from '@platform/interfaces';
import type { ToolDashboardItem } from '@shared/schemas/settingsViewMessages';
import type { ExternalToolCheckResult } from '@tools/toolAvailability';

class MemoryStateStore implements StateStore {
  readonly values = new Map<string, unknown>();

  constructor(private readonly onUpdate?: (key: string) => void) {}

  get<T>(key: string, defaultValue?: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.onUpdate?.(key);
    if (value === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, value);
    }
  }
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

function createFixture(overrides: Partial<ControllerOptions> = {}) {
  const posted: unknown[] = [];
  const commands: string[] = [];
  const openedUrls: string[] = [];
  const presentedExtensions: string[] = [];
  const globalState = overrides.globalState ?? new MemoryStateStore();
  const workspaceState = overrides.workspaceState ?? new MemoryStateStore();
  const dashboard: ControllerOptions['dashboard'] = {
    buildItems: async () => [DASHBOARD_ITEM],
    getCachedCheckResults: async () => [],
    refreshAvailability: async () => undefined,
    refreshDisabledCache: async () => undefined,
    findCommand: async (toolId, kind) => `${kind}:${toolId}`,
    ...overrides.dashboard,
  };
  const controller = new DefaultDesktopToolingSettingsController({
    globalState,
    workspaceState,
    renderer: {
      postToRenderer: (message) => posted.push(message),
    },
    navigation: {
      openExternal: async (url) => {
        openedUrls.push(url);
      },
      presentExtensionInstall: async (extensionId) => {
        presentedExtensions.push(extensionId);
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

  return {
    controller,
    commands,
    globalState,
    openedUrls,
    posted,
    presentedExtensions,
    workspaceState,
  };
}

function commandOf(message: unknown): string | undefined {
  return (message as { command?: string }).command;
}

describe('DefaultDesktopToolingSettingsController', () => {
  it('posts the initial dashboard and LaTeX status', async () => {
    const { controller, posted } = createFixture();

    controller.postLatexConfigValues();
    await controller.postStartupData();

    expect(posted.map(commandOf)).toEqual([
      SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_CONFIG_VALUES,
      SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
      SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_SETTINGS_STATUS,
    ]);
  });

  it('persists a toggle before refreshing caches and posting cached data', async () => {
    const events: string[] = [];
    const cachedResults: ExternalToolCheckResult[] = [];
    const globalState = new MemoryStateStore(() => events.push('state:update'));
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
        refreshAvailability: async () => undefined,
        refreshDisabledCache: async () => {
          events.push('dashboard:disabled');
        },
        findCommand: async () => undefined,
      },
    });

    await assertSupported(controller.toolsActions.toggle)('zotero', false);

    expect(globalState.values.get(GlobalStateKey.DISABLED_TOOLS)).toEqual([
      'zotero',
    ]);
    expect(events).toEqual([
      'state:update',
      'dashboard:disabled',
      'dashboard:cached',
      'dashboard:build',
      'renderer:post',
    ]);
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
        },
        refreshDisabledCache: async () => undefined,
        findCommand: async () => undefined,
      },
    });

    await assertSupported(controller.toolsActions.recheckStatus)();

    expect(events).toEqual([
      'dashboard:refresh',
      'dashboard:cached',
      'dashboard:build',
      'renderer:post',
    ]);
  });

  it('resolves tool commands before execution and rejects missing commands', async () => {
    const findCommand = vi
      .fn<ControllerOptions['dashboard']['findCommand']>()
      .mockResolvedValueOnce('npm install codex')
      .mockResolvedValueOnce(undefined);
    const { controller, commands } = createFixture({
      dashboard: {
        buildItems: async () => [],
        getCachedCheckResults: async () => [],
        refreshAvailability: async () => undefined,
        refreshDisabledCache: async () => undefined,
        findCommand,
      },
    });

    await assertSupported(controller.toolsActions.runCommand)({
      toolId: 'codex',
      kind: 'install',
    });
    await expect(
      assertSupported(controller.toolsActions.runCommand)({
        toolId: 'codex',
        kind: 'auth',
      }),
    ).rejects.toThrow('No auth command is configured for tool "codex".');

    expect(findCommand).toHaveBeenNthCalledWith(1, 'codex', 'install');
    expect(findCommand).toHaveBeenNthCalledWith(2, 'codex', 'auth');
    expect(commands).toEqual(['npm install codex']);
  });

  it('validates LaTeX writes before persistence and reposts after the write', async () => {
    const events: string[] = [];
    const workspaceState = new MemoryStateStore(() =>
      events.push('state:update'),
    );
    const { controller, posted } = createFixture({
      workspaceState,
      renderer: {
        postToRenderer: (message) => {
          posted.push(message);
          events.push('renderer:post');
        },
      },
    });

    await assertSupported(controller.latexActions.setConfigValue)({
      field: 'latexFormatter',
      value: 'none',
    });

    expect(workspaceState.values.get(WorkspaceStateKey.LATEX_FORMATTER)).toBe(
      'none',
    );
    expect(events).toEqual(['state:update', 'renderer:post']);
    expect(posted.at(-1)).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_CONFIG_VALUES,
      values: { latexFormatter: 'none' },
    });

    await expect(
      assertSupported(controller.latexActions.setConfigValue)({
        field: 'latexdiffTimeoutMs',
        value: 100,
      }),
    ).rejects.toThrow('Invalid LaTeX config value for latexdiffTimeoutMs');
    expect(
      workspaceState.values.has(WorkspaceStateKey.LATEXDIFF_TIMEOUT_MS),
    ).toBe(false);
    expect(events).toEqual(['state:update', 'renderer:post']);
  });

  it('runs only allowlisted LaTeX installation commands', async () => {
    const { controller, commands } = createFixture();

    await assertSupported(controller.latexActions.runInstallCommand)(
      HOMEBREW_INSTALL_COMMAND,
    );
    await expect(
      assertSupported(controller.latexActions.runInstallCommand)(
        'echo not-allowlisted',
      ),
    ).rejects.toThrow('Rejected unknown install command: echo not-allowlisted');

    expect(commands).toEqual([HOMEBREW_INSTALL_COMMAND]);
  });

  it('routes URLs and extension references through explicit navigation', async () => {
    const { controller, openedUrls, presentedExtensions } = createFixture();

    await assertSupported(controller.toolsActions.openInstallUrl)(
      'https://example.com/install',
    );
    await assertSupported(controller.toolsActions.installExtension)(
      'publisher.extension',
    );
    await assertSupported(controller.latexActions.installLatexWorkshop)();

    expect(openedUrls).toEqual(['https://example.com/install']);
    expect(presentedExtensions).toEqual([
      'publisher.extension',
      LATEX_WORKSHOP_EXT_ID,
    ]);
  });
});
