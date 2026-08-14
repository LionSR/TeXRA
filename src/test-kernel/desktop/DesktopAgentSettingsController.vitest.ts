import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { AgentEntry } from '@agent/index/agentEntry';
import { DefaultDesktopAgentSettingsController } from '@desktop/main/desktopAgentSettingsController';
import { MAIN_VIEW_COMMANDS, SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { TeamOptionDataSchema } from '@shared/schemas/mainView/state';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { assertSupported, isUnsupported } from '@shared/utils/dispatcher';

import type { AgentCategory, AgentSource } from '@shared/schemas/agent';
import { FakeStateStore } from '@test/support/FakePlatform';

import { commandOf } from './desktopSettingsTestSupport';

type AgentCatalog = Record<AgentCategory, AgentEntry[]>;

interface ControllerFixtureOptions {
  readonly workspaceState?: FakeStateStore;
  readonly globalState?: FakeStateStore;
  readonly catalog?: AgentCatalog;
  readonly visibleCatalog?: AgentCatalog;
  readonly loadAgents?: (options?: {
    includeRemote?: boolean;
  }) => Promise<void>;
  readonly refreshAgents?: (options?: {
    includeRemote?: boolean;
  }) => Promise<void>;
  readonly promptText?: () => Promise<string | undefined>;
  readonly confirm?: () => Promise<boolean>;
  readonly chooseTeamAvailability?: () => Promise<
    'cancel' | 'continue' | 'sign-in'
  >;
  readonly canAccessRemoteCatalog?: () => Promise<boolean>;
  readonly signInForRemoteCatalog?: () => Promise<boolean>;
  readonly getCustomAgentDirectory?: () => Promise<string>;
  readonly selectCustomAgentDirectory?: () => Promise<string | undefined>;
}

function createControllerFixture(options: ControllerFixtureOptions = {}) {
  const workspaceState = options.workspaceState ?? new FakeStateStore();
  const globalState = options.globalState ?? new FakeStateStore();
  const posted: unknown[] = [];
  const opened: string[] = [];
  const revealed: string[] = [];
  const infoMessages: string[] = [];
  const errorMessages: string[] = [];
  const confirmed: string[] = [];
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
      selectCustomAgentDirectory:
        options.selectCustomAgentDirectory ?? (async () => undefined),
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
      confirm: async (input) => {
        confirmed.push(input.message);
        return (await options.confirm?.()) ?? true;
      },
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
    resourcesPath: '/test/resources',
  });
  return {
    confirmed,
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

type Controller = DefaultDesktopAgentSettingsController;

function applyAgentPreset(
  controller: Controller,
  presetId: string,
): Promise<void> | void {
  return assertSupported(controller.handlers.applyAgentModePreset)({
    command: SETTINGS_VIEW_COMMANDS.APPLY_AGENT_MODE_PRESET,
    presetId,
  });
}

function deleteAgentPreset(
  controller: Controller,
  presetId: string,
): Promise<void> | void {
  return assertSupported(controller.handlers.deleteAgentModePreset)({
    command: SETTINGS_VIEW_COMMANDS.DELETE_AGENT_MODE_PRESET,
    presetId,
  });
}

function postedCommands(posted: unknown[]): Array<string | undefined> {
  return posted.map(commandOf);
}

function customTeamState(preset: Record<string, unknown>): FakeStateStore {
  return new FakeStateStore({
    [WorkspaceStateKey.CUSTOM_AGENT_PRESETS]: [preset],
  });
}

function remoteTeamPreset(): Record<string, unknown> {
  return {
    id: 'remote-team',
    name: 'Remote team',
    description: 'Uses a hosted root',
    icon: 'screwdriver-wrench',
    agents: { workflow: [], toolUse: ['orchestrator'] },
    texraHostedAgents: ['orchestrator'],
  };
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
  it('implements the custom-agent management commands', () => {
    const { handlers } = createControllerFixture().controller;

    // The desktop owns the custom-agent create/copy/delete flows and the
    // remote prompt viewer, so none of them may be an `unsupported(...)`
    // placeholder.
    expect(
      [
        handlers.createAgent,
        handlers.customizeAgent,
        handlers.deleteCustomAgent,
        handlers.viewRemoteAgentPrompt,
      ].some(isUnsupported),
    ).toBe(false);
  });

  it('posts startup agent data to the settings renderer', async () => {
    const loadAgents = vi.fn(async () => undefined);
    const { controller, posted } = createControllerFixture({
      catalog: physicistCatalog(),
      loadAgents,
    });

    await controller.postStartupData();

    expect(loadAgents).toHaveBeenCalledOnce();
    expect(postedCommands(posted)).toEqual(
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
    const setEnabled = assertSupported(controller.handlers.setAgentEnabled);

    await setEnabled({
      category: 'workflow',
      command: SETTINGS_VIEW_COMMANDS.SET_AGENT_ENABLED,
      agentSource: 'builtInWorkflow',
      agentName: 'polish',
      enabled: false,
    });

    expect(
      workspaceState.get(WorkspaceStateKey.AGENT_ROSTER_SELECTION),
    ).toEqual({
      kind: 'custom',
      agentKeys: { workflow: ['builtInWorkflow:correct'], toolUse: 'all' },
    });
    expect(postedCommands(posted)).toEqual(
      expect.arrayContaining([
        SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION,
        MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
      ]),
    );
  });

  it('posts well-formed team options when the catalog refreshes', async () => {
    const { controller, posted } = createControllerFixture({
      catalog: physicistCatalog(),
    });

    await controller.refreshCatalogData();

    expect(postedCommands(posted)).toContain(
      MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
    );
    const teamOptionsMessage = posted.find(
      (message) => commandOf(message) === MAIN_VIEW_COMMANDS.SET_TEAM_OPTIONS,
    ) as { optionsData?: unknown } | undefined;
    expect(teamOptionsMessage).toBeDefined();
    const teamOptions = z
      .array(TeamOptionDataSchema)
      .parse(teamOptionsMessage?.optionsData);
    expect(teamOptions.map((option) => option.value)).toEqual(
      expect.arrayContaining([
        'lean-project',
        'physicist',
        'mathematician',
        'cs-ml',
        'software-engineer',
      ]),
    );
  });

  it('posts team options when the custom agent directory changes', async () => {
    const { controller, posted } = createControllerFixture({
      catalog: physicistCatalog(),
      selectCustomAgentDirectory: async () => '/agents/selected',
    });
    const setCustomDir = assertSupported(controller.handlers.setCustomAgentDir);

    await setCustomDir({
      command: SETTINGS_VIEW_COMMANDS.SET_CUSTOM_AGENT_DIR,
    });

    expect(postedCommands(posted)).toEqual(
      expect.arrayContaining([
        SETTINGS_VIEW_COMMANDS.UPDATE_CUSTOM_AGENT_DIR,
        MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
        MAIN_VIEW_COMMANDS.SET_TEAM_OPTIONS,
      ]),
    );
  });

  it('applies source-qualified teams and selects the tool-use root', async () => {
    const { controller, infoMessages, posted, workspaceState } =
      createControllerFixture({
        catalog: physicistCatalog(),
        chooseTeamAvailability: async () => 'continue',
      });

    await applyAgentPreset(controller, 'physicist');

    expect(
      workspaceState.get(WorkspaceStateKey.AGENT_ROSTER_SELECTION),
    ).toEqual({ kind: 'team', teamId: 'physicist' });
    expect(
      posted.find(
        (message) =>
          commandOf(message) === MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
      ),
    ).toMatchObject({
      command: MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
      selectedToolUseAgent: 'orchestrator',
    });
    expect(postedCommands(posted)).toContain(
      MAIN_VIEW_COMMANDS.SET_TEAM_OPTIONS,
    );
    expect(postedCommands(posted)).toContain(
      SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION,
    );
    // The fixture catalog is missing the preset's hosted members, so the
    // notification must say the team is only partially applied.
    expect(infoMessages).toEqual([
      'Applied "Physicist" with 7 members still unavailable',
    ]);
  });

  it('reports a fully applied team without an unavailable-member suffix', async () => {
    const catalog = physicistCatalog();
    const workspaceState = customTeamState({
      id: 'paper-team',
      name: 'Paper Team',
      description: 'Every member resolves locally',
      icon: 'screwdriver-wrench',
      agents: { workflow: ['correct'], toolUse: ['review'] },
    });
    const { controller, infoMessages } = createControllerFixture({
      catalog,
      workspaceState,
    });

    await applyAgentPreset(controller, 'paper-team');

    expect(infoMessages).toEqual(['Applied "Paper Team" team']);
  });

  it('signs in before one forced remote refresh and commits the team once', async () => {
    const workspaceState = customTeamState(remoteTeamPreset());
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

    await applyAgentPreset(controller, 'remote-team');

    expect(order).toEqual(['sign-in', 'refresh']);
    expect(refreshAgents).toHaveBeenCalledOnce();
    expect(refreshAgents).toHaveBeenCalledWith({ includeRemote: true });
    expect(
      update.mock.calls.filter(
        ([key]) => key === WorkspaceStateKey.AGENT_ROSTER_SELECTION,
      ),
    ).toHaveLength(1);
    expect(
      workspaceState.get(WorkspaceStateKey.AGENT_ROSTER_SELECTION),
    ).toEqual({ kind: 'team', teamId: 'remote-team' });
  });

  it('does not write roster state when team preflight is cancelled', async () => {
    const workspaceState = customTeamState(remoteTeamPreset());
    const update = vi.spyOn(workspaceState, 'update');
    const refreshAgents = vi.fn(async () => undefined);
    const { controller } = createControllerFixture({
      workspaceState,
      chooseTeamAvailability: async () => 'cancel',
      refreshAgents,
    });
    update.mockClear();

    await applyAgentPreset(controller, 'remote-team');

    expect(refreshAgents).not.toHaveBeenCalled();
    expect(
      update.mock.calls.some(
        ([key]) => key === WorkspaceStateKey.AGENT_ROSTER_SELECTION,
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
    const savePreset = assertSupported(controller.handlers.saveAgentModePreset);

    await savePreset({
      command: SETTINGS_VIEW_COMMANDS.SAVE_AGENT_MODE_PRESET,
    });

    expect(workspaceState.get(WorkspaceStateKey.CUSTOM_AGENT_PRESETS)).toEqual([
      expect.objectContaining({
        name: 'Paper Team',
        agents: { workflow: ['correct'], toolUse: ['review'] },
      }),
    ]);
    expect(infoMessages).toEqual(['Saved team "Paper Team"']);
    expect(posted.at(-1)).toMatchObject({
      command: MAIN_VIEW_COMMANDS.SET_TEAM_OPTIONS,
    });
    expect(posted).toContainEqual(
      expect.objectContaining({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_MODE_PRESETS,
        customPresets: [expect.objectContaining({ name: 'Paper Team' })],
      }),
    );
  });

  function savedTeamState(): FakeStateStore {
    return customTeamState({
      id: 'custom-team',
      name: 'Custom Team',
      description: 'test',
      icon: 'codicon-bookmark',
      agents: { workflow: ['correct'], toolUse: ['review'] },
    });
  }

  it('keeps a custom team when its delete confirmation is declined', async () => {
    const workspaceState = savedTeamState();
    const { confirmed, controller } = createControllerFixture({
      workspaceState,
      confirm: async () => false,
    });

    await deleteAgentPreset(controller, 'custom-team');

    expect(confirmed).toEqual(['Delete team "Custom Team"?']);
    expect(
      workspaceState.get(WorkspaceStateKey.CUSTOM_AGENT_PRESETS),
    ).toHaveLength(1);
  });

  it('deletes custom teams and reports unknown team ids', async () => {
    const workspaceState = savedTeamState();
    const { controller, errorMessages, posted } = createControllerFixture({
      workspaceState,
    });

    await deleteAgentPreset(controller, 'custom-team');

    expect(workspaceState.get(WorkspaceStateKey.CUSTOM_AGENT_PRESETS)).toEqual(
      [],
    );
    expect(posted.at(-1)).toMatchObject({
      command: MAIN_VIEW_COMMANDS.SET_TEAM_OPTIONS,
    });
    expect(posted).toContainEqual(
      expect.objectContaining({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_MODE_PRESETS,
        customPresets: [],
      }),
    );

    await deleteAgentPreset(controller, 'missing-team');

    expect(errorMessages).toEqual(['Unknown custom team: missing-team']);
  });

  it('opens the custom agent directory through the required directory port', async () => {
    const { controller, opened } = createControllerFixture({
      getCustomAgentDirectory: async () => '/agents/custom',
    });
    const openFolder = assertSupported(controller.handlers.openAgentFolder);

    await openFolder({
      command: SETTINGS_VIEW_COMMANDS.OPEN_AGENT_FOLDER,
      folderType: 'custom',
    });

    expect(opened).toEqual(['/agents/custom']);
  });

  it('reports unknown presets without writing roster state', async () => {
    const { controller, errorMessages, workspaceState } =
      createControllerFixture();

    await applyAgentPreset(controller, 'missing-team');

    expect(errorMessages).toEqual(['Unknown team: missing-team']);
    expect(
      workspaceState.get(WorkspaceStateKey.AGENT_ROSTER_SELECTION),
    ).toBeUndefined();
  });
});
