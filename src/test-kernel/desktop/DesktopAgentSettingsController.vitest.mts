import { describe, expect, it, vi } from 'vitest';

import type { AgentEntry } from '@agent/index/agentRegistry';
import { DefaultDesktopAgentSettingsController } from '@desktop/main/desktopAgentSettingsController';
import { MAIN_VIEW_COMMANDS, SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { isUnsupported } from '@shared/utils/dispatcher';

import type { AgentCategory, AgentSource } from '@shared/schemas/agent';
import type { StateStore } from '@platform/interfaces';

class MemoryStateStore implements StateStore {
  readonly values = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, value);
    }
  }
}

type AgentCatalog = Record<AgentCategory, AgentEntry[]>;

interface ControllerFixtureOptions {
  readonly workspaceState?: MemoryStateStore;
  readonly globalState?: MemoryStateStore;
  readonly catalog?: AgentCatalog;
  readonly visibleCatalog?: AgentCatalog;
  readonly loadAgents?: (options?: {
    includeRemote?: boolean;
  }) => Promise<void>;
  readonly refreshAgents?: (options?: {
    includeRemote?: boolean;
  }) => Promise<void>;
  readonly promptText?: () => Promise<string | undefined>;
  readonly chooseTeamAvailability?: () => Promise<
    'cancel' | 'continue' | 'sign-in'
  >;
  readonly canAccessRemoteCatalog?: () => Promise<boolean>;
  readonly signInForRemoteCatalog?: () => Promise<boolean>;
  readonly getCustomAgentDirectory?: () => Promise<string>;
}

function createControllerFixture(options: ControllerFixtureOptions = {}) {
  const workspaceState = options.workspaceState ?? new MemoryStateStore();
  const globalState = options.globalState ?? new MemoryStateStore();
  const posted: unknown[] = [];
  const opened: string[] = [];
  const revealed: string[] = [];
  const infoMessages: string[] = [];
  const errorMessages: string[] = [];
  const emptyCatalog: AgentCatalog = { workflow: [], toolUse: [] };
  const catalog = options.catalog ?? emptyCatalog;
  const visibleCatalog = options.visibleCatalog ?? catalog;
  const controller = new DefaultDesktopAgentSettingsController({
    workspaceState,
    globalState,
    registry: {
      loadAgents: options.loadAgents ?? (async () => undefined),
      refreshAgents: options.refreshAgents ?? (async () => undefined),
      loadAgentOptionsData: async () => ({
        workflow: catalog.workflow.map((entry) => ({
          value: `${entry.source}:${entry.name}`,
          label: entry.name,
        })),
        toolUse: catalog.toolUse.map((entry) => ({
          value: `${entry.source}:${entry.name}`,
          label: entry.name,
        })),
      }),
      getAgents: (category) => catalog[category],
      getVisibleAgents: (category) => visibleCatalog[category],
    },
    directory: {
      getCustomAgentDirectory:
        options.getCustomAgentDirectory ?? (async () => '/agents/custom'),
      getSourceDirectory: async (source) => `/agents/${source}`,
      selectCustomAgentDirectory: async () => undefined,
      openPath: async (filePath) => {
        opened.push(filePath);
      },
      revealPath: async (filePath) => {
        revealed.push(filePath);
      },
    },
    renderer: { postToRenderer: (message) => posted.push(message) },
    prompts: {
      promptText: options.promptText ?? (async () => undefined),
      chooseTeamAvailability:
        options.chooseTeamAvailability ?? (async () => 'cancel'),
    },
    remoteCatalog: {
      canAccess: options.canAccessRemoteCatalog ?? (async () => false),
      signIn: options.signInForRemoteCatalog ?? (async () => false),
    },
    notifications: {
      showInfoMessage: async (message) => {
        infoMessages.push(message);
      },
      showErrorMessage: async (message) => {
        errorMessages.push(message);
      },
    },
  });
  return {
    controller,
    errorMessages,
    globalState,
    infoMessages,
    opened,
    posted,
    revealed,
    workspaceState,
  };
}

function messageCommand(message: unknown): string | undefined {
  return (message as { command?: string }).command;
}

function requireAction(action: unknown): (...args: never[]) => unknown {
  if (typeof action !== 'function') {
    throw new Error('Expected a supported desktop agent settings action.');
  }
  return action as (...args: never[]) => unknown;
}

function physicistCatalog(): AgentCatalog {
  const workflow = ['correct', 'polish'].map((name): AgentEntry => ({
    source: 'builtInWorkflow',
    name,
    path: `/agents/${name}.yaml`,
    category: 'workflow',
  }));
  const toolUse = [
    ['orchestrator', 'builtInToolUse'],
    ['research', 'custom'],
    ['numerics', 'builtInToolUse'],
    ['review', 'builtInToolUse'],
    ['presenter', 'builtInToolUse'],
    ['latexFixer', 'builtInToolUse'],
  ].map(([name, source]): AgentEntry => ({
    source: source as AgentSource,
    name,
    path: `/agents/${name}.yaml`,
    category: 'toolUse',
    ...(name === 'orchestrator' ? { tools: ['delegate_agent'] } : {}),
  }));
  return { workflow, toolUse };
}

describe('DefaultDesktopAgentSettingsController', () => {
  it('declares unavailable desktop agent commands explicitly', () => {
    const { actions } = createControllerFixture().controller;

    expect(
      [
        actions.create,
        actions.customize,
        actions.deleteCustom,
        actions.viewRemotePrompt,
      ].every(isUnsupported),
    ).toBe(true);
  });

  it('posts startup agent data to the settings renderer', async () => {
    const loadAgents = vi.fn(async () => undefined);
    const { controller, posted } = createControllerFixture({
      catalog: physicistCatalog(),
      loadAgents,
    });

    await controller.postStartupData();

    expect(loadAgents).toHaveBeenCalledOnce();
    expect(posted.map(messageCommand)).toEqual(
      expect.arrayContaining([
        SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_MODE_PRESETS,
        SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION,
        SETTINGS_VIEW_COMMANDS.UPDATE_CUSTOM_AGENT_DIR,
      ]),
    );
  });

  it('updates source-qualified visibility state and both renderer surfaces', async () => {
    const { controller, posted, workspaceState } = createControllerFixture({
      catalog: physicistCatalog(),
    });
    const setEnabled = requireAction(controller.actions.setEnabled) as (input: {
      category: AgentCategory;
      source: AgentSource;
      name: string;
      enabled: boolean;
    }) => Promise<void>;

    await setEnabled({
      category: 'workflow',
      source: 'builtInWorkflow',
      name: 'polish',
      enabled: false,
    });

    expect(workspaceState.values.get(WorkspaceStateKey.ENABLED_AGENTS)).toEqual(
      expect.not.arrayContaining(['builtInWorkflow:polish', 'polish']),
    );
    expect(posted.map(messageCommand)).toEqual(
      expect.arrayContaining([
        SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION,
        MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
      ]),
    );
  });

  it('applies source-qualified teams and selects the tool-use root', async () => {
    const { controller, infoMessages, posted, workspaceState } =
      createControllerFixture({
        catalog: physicistCatalog(),
        chooseTeamAvailability: async () => 'continue',
      });
    const applyPreset = requireAction(controller.actions.applyModePreset) as (
      presetId: string,
    ) => Promise<void>;

    await applyPreset('physicist');

    expect(workspaceState.values.get(WorkspaceStateKey.ENABLED_AGENTS)).toEqual(
      expect.arrayContaining([
        'builtInWorkflow:correct',
        'builtInWorkflow:polish',
      ]),
    );
    expect(
      workspaceState.values.get(WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS),
    ).toEqual(
      expect.arrayContaining([
        'builtInToolUse:orchestrator',
        'custom:research',
      ]),
    );
    expect(
      posted.find(
        (message) =>
          messageCommand(message) === MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
      ),
    ).toMatchObject({
      command: MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
      selectedToolUseAgent: 'orchestrator',
    });
    expect(
      posted.some(
        (message) =>
          messageCommand(message) ===
          SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION,
      ),
    ).toBe(true);
    expect(infoMessages).toEqual(['Applied "Physicist" team']);
  });

  it('signs in before one forced remote refresh and commits the team once', async () => {
    const workspaceState = new MemoryStateStore();
    workspaceState.values.set(WorkspaceStateKey.CUSTOM_AGENT_PRESETS, [
      {
        id: 'remote-team',
        name: 'Remote team',
        description: 'Uses a hosted root',
        icon: 'tools',
        workflowAgents: [],
        toolUseAgents: ['orchestrator'],
        texraHostedAgents: ['orchestrator'],
      },
    ]);
    const catalog: AgentCatalog = { workflow: [], toolUse: [] };
    const order: string[] = [];
    const refreshAgents = vi.fn(async () => {
      order.push('refresh');
      catalog.toolUse = [
        {
          source: 'remote',
          name: 'orchestrator',
          path: '/remote/orchestrator.yaml',
          category: 'toolUse',
          tools: ['delegate_agent'],
        },
      ];
    });
    const update = vi.spyOn(workspaceState, 'update');
    const { controller } = createControllerFixture({
      workspaceState,
      catalog,
      canAccessRemoteCatalog: async () => false,
      chooseTeamAvailability: async () => 'sign-in',
      signInForRemoteCatalog: async () => {
        order.push('sign-in');
        return true;
      },
      refreshAgents,
    });
    update.mockClear();
    const applyPreset = requireAction(controller.actions.applyModePreset) as (
      presetId: string,
    ) => Promise<void>;

    await applyPreset('remote-team');

    expect(order).toEqual(['sign-in', 'refresh']);
    expect(refreshAgents).toHaveBeenCalledOnce();
    expect(refreshAgents).toHaveBeenCalledWith({ includeRemote: true });
    expect(
      update.mock.calls.filter(
        ([key]) => key === WorkspaceStateKey.ENABLED_AGENTS,
      ),
    ).toHaveLength(1);
    expect(
      update.mock.calls.filter(
        ([key]) => key === WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
      ),
    ).toHaveLength(1);
    expect(
      workspaceState.values.get(WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS),
    ).toEqual(['remote:orchestrator']);
  });

  it('does not write roster state when team preflight is cancelled', async () => {
    const workspaceState = new MemoryStateStore();
    workspaceState.values.set(WorkspaceStateKey.CUSTOM_AGENT_PRESETS, [
      {
        id: 'remote-team',
        name: 'Remote team',
        description: 'Uses a hosted root',
        icon: 'tools',
        workflowAgents: [],
        toolUseAgents: ['orchestrator'],
        texraHostedAgents: ['orchestrator'],
      },
    ]);
    const update = vi.spyOn(workspaceState, 'update');
    const refreshAgents = vi.fn(async () => undefined);
    const { controller } = createControllerFixture({
      workspaceState,
      chooseTeamAvailability: async () => 'cancel',
      refreshAgents,
    });
    update.mockClear();
    const applyPreset = requireAction(controller.actions.applyModePreset) as (
      presetId: string,
    ) => Promise<void>;

    await applyPreset('remote-team');

    expect(refreshAgents).not.toHaveBeenCalled();
    expect(
      update.mock.calls.some(
        ([key]) =>
          key === WorkspaceStateKey.ENABLED_AGENTS ||
          key === WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
      ),
    ).toBe(false);
  });

  it('saves visible agents as a custom team', async () => {
    const catalog = physicistCatalog();
    const visibleCatalog: AgentCatalog = {
      workflow: [catalog.workflow[0]],
      toolUse: [catalog.toolUse[3]],
    };
    const { controller, infoMessages, posted, workspaceState } =
      createControllerFixture({
        catalog,
        visibleCatalog,
        promptText: async () => '  Paper Team  ',
      });
    const savePreset = requireAction(
      controller.actions.saveModePreset,
    ) as () => Promise<void>;

    await savePreset();

    expect(
      workspaceState.values.get(WorkspaceStateKey.CUSTOM_AGENT_PRESETS),
    ).toEqual([
      expect.objectContaining({
        name: 'Paper Team',
        workflowAgents: ['correct'],
        toolUseAgents: ['review'],
      }),
    ]);
    expect(infoMessages).toEqual(['Saved team "Paper Team"']);
    expect(posted.at(-1)).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_MODE_PRESETS,
      customPresets: [expect.objectContaining({ name: 'Paper Team' })],
    });
  });

  it('opens the custom agent directory through the required directory port', async () => {
    const { controller, opened } = createControllerFixture({
      getCustomAgentDirectory: async () => '/agents/custom',
    });
    const openFolder = requireAction(
      controller.actions.openFolder,
    ) as () => Promise<void>;

    await openFolder();

    expect(opened).toEqual(['/agents/custom']);
  });

  it('reports unknown presets without writing roster state', async () => {
    const { controller, errorMessages, workspaceState } =
      createControllerFixture();
    const applyPreset = requireAction(controller.actions.applyModePreset) as (
      presetId: string,
    ) => Promise<void>;

    await applyPreset('missing-team');

    expect(errorMessages).toEqual(['Unknown team: missing-team']);
    expect(workspaceState.values.has(WorkspaceStateKey.ENABLED_AGENTS)).toBe(
      false,
    );
    expect(
      workspaceState.values.has(WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS),
    ).toBe(false);
  });
});
