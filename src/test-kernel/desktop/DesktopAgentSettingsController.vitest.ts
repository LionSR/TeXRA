import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

import { AgentRosterController } from '@agent/roster/AgentRosterController';
import { DefaultDesktopAgentSettingsController } from '@desktop/main/desktopAgentSettingsController';
import { withProcessServices } from '@platform/processRuntime';
import {
  agentKeyOf,
  agentMatchesIdentifier,
  byCategory,
  parseAgentModePresets,
} from '@shared/schemas';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { assertSupported } from '@shared/utils/dispatcher';
import {
  initTestProcessRuntime,
  testRuntime,
} from '@test/support/testProcessRuntime';
import { bareProcessRuntime } from '@test/support/bareProcessRuntime';

import {
  physicistCatalog,
  type AgentCatalog,
} from '@test/support/agentCatalogFixtures';
import { FakeStateStore } from '@test/support/FakePlatform';

import { commandOf } from './desktopSettingsTestSupport';

interface ControllerFixtureOptions {
  readonly workspaceState?: FakeStateStore;
  readonly globalState?: FakeStateStore;
  readonly catalog?: AgentCatalog;
  readonly visibleCatalog?: AgentCatalog;
  readonly loadAgents?: (options?: {
    includeRemote?: boolean;
  }) => Effect.Effect<void>;
  readonly refreshAgents?: (options?: {
    includeRemote?: boolean;
  }) => Effect.Effect<void>;
  readonly promptText?: () => Effect.Effect<string | undefined>;
  readonly confirm?: () => Effect.Effect<boolean>;
  readonly chooseTeamAvailability?: () => Effect.Effect<
    'cancel' | 'continue' | 'sign-in'
  >;
  readonly canAccessRemoteCatalog?: Effect.Effect<boolean>;
  readonly signInForRemoteCatalog?: () => Effect.Effect<boolean>;
  readonly selectCustomAgentDirectory?: () => Promise<string | undefined>;
}

beforeEach(() => {
  initTestProcessRuntime(bareProcessRuntime());
});

function createControllerFixture(options: ControllerFixtureOptions = {}) {
  const workspaceState =
    options.workspaceState ??
    new FakeStateStore(
      options.visibleCatalog
        ? {
            [WorkspaceStateKey.AGENT_ROSTER_SELECTION]: {
              kind: 'custom',
              agentKeys: byCategory((category) =>
                options.visibleCatalog![category].map(agentKeyOf),
              ),
            },
          }
        : {},
    );
  const globalState = options.globalState ?? new FakeStateStore();
  const posted: unknown[] = [];
  /** One entry per catalog change: the applied team's tool-use root, else undefined. */
  const catalogChanges: (string | undefined)[] = [];
  const opened: string[] = [];
  const infoMessages: string[] = [];
  const errorMessages: string[] = [];
  const confirmed: string[] = [];
  const emptyCatalog: AgentCatalog = { workflow: [], toolUse: [] };
  const catalog = options.catalog ?? emptyCatalog;
  const controller = new DefaultDesktopAgentSettingsController({
    roster: new AgentRosterController({
      workspaceState,
      globalState,
      getAgents: (category) => catalog[category],
      resolveAgent: (category, identifier) =>
        catalog[category].find((entry) =>
          agentMatchesIdentifier(entry, identifier),
        ),
      getPresets: () =>
        workspaceState
          .get(WorkspaceStateKey.CUSTOM_AGENT_PRESETS, [])
          .pipe(Effect.map(parseAgentModePresets)),
    }),
    workspaceState,
    globalState,
    registry: {
      loadAgents: options.loadAgents ?? (() => Effect.void),
      refreshAgents: options.refreshAgents ?? (() => Effect.void),
      getAgents: (category) => catalog[category],
    },
    directory: {
      getCustomAgentDirectory: () => Effect.succeed('/agents/custom'),
      getSourceDirectory: (source) => Effect.succeed(`/agents/${source}`),
      selectCustomAgentDirectory:
        options.selectCustomAgentDirectory ?? (async () => undefined),
      openPath: (filePath) =>
        Effect.sync(() => {
          opened.push(filePath);
        }),
      revealPath: async () => undefined,
    },
    renderer: { postToRenderer: (message) => posted.push(message) },
    onCatalogChanged: (selectedToolUseAgent) =>
      Effect.sync(() => {
        catalogChanges.push(selectedToolUseAgent);
      }),
    prompts: {
      promptText: options.promptText ?? (() => Effect.succeed(undefined)),
      confirm: (input) =>
        Effect.suspend(() => {
          confirmed.push(input.message);
          return options.confirm?.() ?? Effect.succeed(true);
        }),
      chooseTeamAvailability:
        options.chooseTeamAvailability ?? (() => Effect.succeed('cancel')),
    },
    remoteCatalog: {
      canAccess: () => options.canAccessRemoteCatalog ?? Effect.succeed(false),
      signIn: options.signInForRemoteCatalog ?? (() => Effect.succeed(false)),
    },
    notifications: {
      showInfoMessage: (message) =>
        Effect.sync(() => {
          infoMessages.push(message);
        }),
      showErrorMessage: (message) =>
        Effect.sync(() => {
          errorMessages.push(message);
        }),
    },
    resourcesPath: '/test/resources',
  });
  return {
    catalogChanges,
    confirmed,
    controller,
    errorMessages,
    globalState,
    infoMessages,
    opened,
    posted,
    workspaceState,
  };
}

type Controller = DefaultDesktopAgentSettingsController;

function applyAgentPreset(controller: Controller, presetId: string) {
  return assertSupported(controller.handlers.applyAgentModePreset)({
    command: SETTINGS_VIEW_COMMANDS.APPLY_AGENT_MODE_PRESET,
    presetId,
  });
}

function deleteAgentPreset(controller: Controller, presetId: string) {
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

describe('DefaultDesktopAgentSettingsController', () => {
  it.effect(
    'updates source-qualified visibility state and both renderer surfaces',
    () =>
      Effect.gen(function* () {
        const { catalogChanges, controller, posted, workspaceState } =
          createControllerFixture({
            catalog: physicistCatalog(),
          });
        const setEnabled = assertSupported(controller.handlers.setAgentEnabled);

        yield* withProcessServices(
          testRuntime(),
          setEnabled({
            category: 'workflow',
            command: SETTINGS_VIEW_COMMANDS.SET_AGENT_ENABLED,
            agentSource: 'builtInWorkflow',
            agentName: 'polish',
            enabled: false,
          }),
        );

        expect(
          yield* withProcessServices(
            testRuntime(),
            workspaceState.get(WorkspaceStateKey.AGENT_ROSTER_SELECTION),
          ),
        ).toEqual({
          kind: 'custom',
          agentKeys: { workflow: ['builtInWorkflow:correct'], toolUse: 'all' },
        });
        expect(postedCommands(posted)).toContain(
          SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION,
        );
        expect(catalogChanges).toEqual([undefined]);
      }),
  );

  it.effect(
    'reports a catalog change when the custom agent directory changes',
    () =>
      Effect.gen(function* () {
        const { catalogChanges, controller, posted } = createControllerFixture({
          catalog: physicistCatalog(),
          selectCustomAgentDirectory: async () => '/agents/selected',
        });
        const setCustomDir = assertSupported(
          controller.handlers.setCustomAgentDir,
        );

        yield* withProcessServices(
          testRuntime(),
          setCustomDir({
            command: SETTINGS_VIEW_COMMANDS.SET_CUSTOM_AGENT_DIR,
          }),
        );

        expect(postedCommands(posted)).toContain(
          SETTINGS_VIEW_COMMANDS.UPDATE_CUSTOM_AGENT_DIR,
        );
        expect(catalogChanges).toEqual([undefined]);
      }),
  );

  it.effect(
    'applies source-qualified teams and selects the tool-use root',
    () =>
      Effect.gen(function* () {
        const {
          catalogChanges,
          controller,
          infoMessages,
          posted,
          workspaceState,
        } = createControllerFixture({
          catalog: physicistCatalog(),
          chooseTeamAvailability: () => Effect.succeed('continue'),
        });

        yield* withProcessServices(
          testRuntime(),
          applyAgentPreset(controller, 'physicist'),
        );

        expect(
          yield* withProcessServices(
            testRuntime(),
            workspaceState.get(WorkspaceStateKey.AGENT_ROSTER_SELECTION),
          ),
        ).toEqual({ kind: 'team', teamId: 'physicist' });
        expect(catalogChanges).toContain('orchestrator');
        expect(postedCommands(posted)).toContain(
          SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION,
        );
        // The fixture catalog is missing the preset's hosted members, so the
        // notification must say the team is only partially applied.
        expect(infoMessages).toEqual([
          'Applied "Physicist" with 7 members still unavailable',
        ]);
      }),
  );

  it.effect(
    'signs in before one forced remote refresh and commits the team once',
    () =>
      Effect.gen(function* () {
        const workspaceState = customTeamState(remoteTeamPreset());
        const catalog: AgentCatalog = { workflow: [], toolUse: [] };
        const order: string[] = [];
        const refreshAgents = vi.fn(() =>
          Effect.sync(() => {
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
          }),
        );
        const update = vi.spyOn(workspaceState, 'update');
        const { controller } = createControllerFixture({
          workspaceState,
          catalog,
          canAccessRemoteCatalog: Effect.succeed(false),
          chooseTeamAvailability: () => Effect.succeed('sign-in'),
          signInForRemoteCatalog: () =>
            Effect.sync(() => {
              order.push('sign-in');
              return true;
            }),
          refreshAgents,
        });
        update.mockClear();

        yield* withProcessServices(
          testRuntime(),
          applyAgentPreset(controller, 'remote-team'),
        );

        expect(order).toEqual(['sign-in', 'refresh']);
        expect(refreshAgents).toHaveBeenCalledOnce();
        expect(refreshAgents).toHaveBeenCalledWith({ includeRemote: true });
        expect(
          update.mock.calls.filter(
            ([key]) => key === WorkspaceStateKey.AGENT_ROSTER_SELECTION,
          ),
        ).toHaveLength(1);
        expect(
          yield* withProcessServices(
            testRuntime(),
            workspaceState.get(WorkspaceStateKey.AGENT_ROSTER_SELECTION),
          ),
        ).toEqual({ kind: 'team', teamId: 'remote-team' });
      }),
  );

  it.effect(
    'does not write roster state when team preflight is cancelled',
    () =>
      Effect.gen(function* () {
        const workspaceState = customTeamState(remoteTeamPreset());
        const update = vi.spyOn(workspaceState, 'update');
        const refreshAgents = vi.fn(() => Effect.void);
        const { controller } = createControllerFixture({
          workspaceState,
          chooseTeamAvailability: () => Effect.succeed('cancel'),
          refreshAgents,
        });
        update.mockClear();

        yield* withProcessServices(
          testRuntime(),
          applyAgentPreset(controller, 'remote-team'),
        );

        expect(refreshAgents).not.toHaveBeenCalled();
        expect(
          update.mock.calls.some(
            ([key]) => key === WorkspaceStateKey.AGENT_ROSTER_SELECTION,
          ),
        ).toBe(false);
      }),
  );

  it.effect('saves visible agents as a custom team', () =>
    Effect.gen(function* () {
      const catalog = physicistCatalog();
      const visibleCatalog: AgentCatalog = {
        workflow: [catalog.workflow[0]],
        toolUse: [catalog.toolUse[3]],
      };
      const {
        catalogChanges,
        controller,
        infoMessages,
        posted,
        workspaceState,
      } = createControllerFixture({
        catalog,
        visibleCatalog,
        promptText: () => Effect.succeed('  Paper Team  '),
      });
      const savePreset = assertSupported(
        controller.handlers.saveAgentModePreset,
      );

      yield* withProcessServices(
        testRuntime(),
        savePreset({
          command: SETTINGS_VIEW_COMMANDS.SAVE_AGENT_MODE_PRESET,
        }),
      );

      expect(
        yield* withProcessServices(
          testRuntime(),
          workspaceState.get(WorkspaceStateKey.CUSTOM_AGENT_PRESETS),
        ),
      ).toEqual([
        expect.objectContaining({
          name: 'Paper Team',
          agents: { workflow: ['correct'], toolUse: ['review'] },
        }),
      ]);
      expect(infoMessages).toEqual(['Saved team "Paper Team"']);
      expect(catalogChanges.at(-1)).toBeUndefined();
      expect(catalogChanges.length).toBeGreaterThan(0);
      expect(posted).toContainEqual(
        expect.objectContaining({
          command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_MODE_PRESETS,
          customPresets: [expect.objectContaining({ name: 'Paper Team' })],
        }),
      );
    }),
  );

  function savedTeamState(): FakeStateStore {
    return customTeamState({
      id: 'custom-team',
      name: 'Custom Team',
      description: 'test',
      icon: 'bookmark',
      agents: { workflow: ['correct'], toolUse: ['review'] },
      texraHostedAgents: [],
    });
  }

  it.effect(
    'keeps a custom team when its delete confirmation is declined',
    () =>
      Effect.gen(function* () {
        const workspaceState = savedTeamState();
        const { confirmed, controller } = createControllerFixture({
          workspaceState,
          confirm: () => Effect.succeed(false),
        });

        yield* withProcessServices(
          testRuntime(),
          deleteAgentPreset(controller, 'custom-team'),
        );

        expect(confirmed).toEqual(['Delete team "Custom Team"?']);
        expect(
          yield* withProcessServices(
            testRuntime(),
            workspaceState.get(WorkspaceStateKey.CUSTOM_AGENT_PRESETS),
          ),
        ).toHaveLength(1);
      }),
  );

  it.effect('deletes custom teams and reports unknown team ids', () =>
    Effect.gen(function* () {
      const workspaceState = savedTeamState();
      const { catalogChanges, controller, errorMessages, posted } =
        createControllerFixture({
          workspaceState,
        });

      yield* withProcessServices(
        testRuntime(),
        deleteAgentPreset(controller, 'custom-team'),
      );

      expect(
        yield* withProcessServices(
          testRuntime(),
          workspaceState.get(WorkspaceStateKey.CUSTOM_AGENT_PRESETS),
        ),
      ).toEqual([]);
      expect(catalogChanges.length).toBeGreaterThan(0);
      expect(posted).toContainEqual(
        expect.objectContaining({
          command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_MODE_PRESETS,
          customPresets: [],
        }),
      );

      yield* withProcessServices(
        testRuntime(),
        deleteAgentPreset(controller, 'missing-team'),
      );

      expect(errorMessages).toEqual(['Unknown custom team: missing-team']);
    }),
  );

  it.effect('reports unknown presets without writing roster state', () =>
    Effect.gen(function* () {
      const { controller, errorMessages, workspaceState } =
        createControllerFixture();

      yield* withProcessServices(
        testRuntime(),
        applyAgentPreset(controller, 'missing-team'),
      );

      expect(errorMessages).toEqual(['Unknown team "missing-team".']);
      expect(
        yield* withProcessServices(
          testRuntime(),
          workspaceState.get(WorkspaceStateKey.AGENT_ROSTER_SELECTION),
        ),
      ).toBeUndefined();
    }),
  );
});
