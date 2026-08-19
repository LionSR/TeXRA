import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEntry } from '@agent/index/agentEntry';
import { resetAgentCatalogAuthRefreshScopeForTests } from '@frontend/auth/agentCatalogRefreshScope';
import type { AgentCategory, AgentSource } from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { FakeStateStore } from '@test/support/FakePlatform';
import { installPlatform } from '@test/support/setupPlatform';

type AgentCatalog = Record<AgentCategory, AgentEntry[]>;

const host = vi.hoisted(() => ({
  showInformationMessage: vi.fn(),
  executeCommand: vi.fn(),
}));

vi.mock('vscode', async () => {
  const actual = await vi.importActual<typeof import('vscode')>('vscode');
  return {
    ...actual,
    window: {
      ...actual.window,
      showInformationMessage: host.showInformationMessage,
    },
    commands: { ...actual.commands, executeCommand: host.executeCommand },
  };
});

const registry = vi.hoisted(() => ({
  catalog: { workflow: [], toolUse: [] } as AgentCatalog,
  loadAgents: vi.fn(async () => undefined),
  refreshAgents: vi.fn(async (_options?: { includeRemote?: boolean }) => {}),
}));

vi.mock('@agent/index', async () => ({
  ...(await vi.importActual<typeof import('@agent/index')>('@agent/index')),
  loadAgents: registry.loadAgents,
  refresh: registry.refreshAgents,
  getAgentsByCategory: (category: AgentCategory) => registry.catalog[category],
  getVisibleAgents: (category: AgentCategory) => registry.catalog[category],
}));

const isAuthenticated = vi.hoisted(() => vi.fn(async () => false));

vi.mock('@auth/SupabaseClient', async () => ({
  ...(await vi.importActual<typeof import('@auth/SupabaseClient')>(
    '@auth/SupabaseClient',
  )),
  SupabaseClient: {
    isAuthenticated,
    getAccessToken: async () => undefined,
  },
}));

const { AgentHandlers } = await import('@settingsView/handlers/agentHandlers');

type Handlers = InstanceType<typeof AgentHandlers>;

function applyPreset(handlers: Handlers, presetId: string): Promise<void> {
  return handlers.handleApplyAgentModePreset({
    command: 'applyAgentModePreset',
    presetId,
  });
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

interface HandlerFixtureOptions {
  readonly workspaceState?: FakeStateStore;
  readonly catalog?: AgentCatalog;
  /** Button label returned by the modal "members unavailable" prompt. */
  readonly modalChoice?: string | undefined;
}

async function createHandlerFixture(options: HandlerFixtureOptions = {}) {
  const workspaceState = options.workspaceState ?? new FakeStateStore();
  const globalState = new FakeStateStore();
  registry.catalog = options.catalog ?? { workflow: [], toolUse: [] };
  await installPlatform({}, { workspaceState, globalState });

  const notifications: string[] = [];
  const modalPrompts: string[] = [];
  host.showInformationMessage.mockImplementation(
    async (message: string, ...rest: unknown[]) => {
      // The modal team-availability prompt passes options plus button labels;
      // the plain confirmation toast passes only a message.
      if (rest.length === 0) {
        notifications.push(message);
        return undefined;
      }
      modalPrompts.push(message);
      return options.modalChoice;
    },
  );

  const refreshAfterAgentMutation = vi.fn(
    async (_selectedToolUseAgent?: string, _catalogFresh?: boolean) => {},
  );
  const handlers = new AgentHandlers(
    {
      channel: 'TeXRA',
      logger: { warn: () => {}, error: () => {}, debug: () => {} },
      extensionContext: {} as never,
      withActiveWebview: async () => {},
    },
    refreshAfterAgentMutation,
  );

  return {
    globalState,
    handlers,
    modalPrompts,
    notifications,
    refreshAfterAgentMutation,
    workspaceState,
  };
}

const REMOTE_TEAM_STATE = {
  [WorkspaceStateKey.CUSTOM_AGENT_PRESETS]: [
    {
      id: 'remote-team',
      name: 'Remote team',
      description: 'Uses a hosted root',
      icon: 'screwdriver-wrench',
      agents: { workflow: [], toolUse: ['orchestrator'] },
      texraHostedAgents: ['orchestrator'],
    },
  ],
};

describe('extension settings AgentHandlers', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    registry.refreshAgents.mockImplementation(async () => {});
    isAuthenticated.mockResolvedValue(false);
    resetAgentCatalogAuthRefreshScopeForTests();
  });

  it('applies source-qualified teams and selects the tool-use root', async () => {
    const {
      handlers,
      notifications,
      refreshAfterAgentMutation,
      workspaceState,
    } = await createHandlerFixture({
      catalog: physicistCatalog(),
      modalChoice: 'Continue with available members',
    });

    await applyPreset(handlers, 'physicist');

    expect(
      workspaceState.get(WorkspaceStateKey.AGENT_ROSTER_SELECTION),
    ).toEqual({ kind: 'team', teamId: 'physicist' });
    expect(refreshAfterAgentMutation).toHaveBeenCalledWith(
      'orchestrator',
      true,
    );
    expect(notifications).toEqual([
      'Applied "Physicist" with 7 members still unavailable',
    ]);
  });

  it('reports members that stayed unavailable after applying a team', async () => {
    const catalog = physicistCatalog();
    const workspaceState = new FakeStateStore({
      [WorkspaceStateKey.CUSTOM_AGENT_PRESETS]: [
        {
          id: 'partial-team',
          name: 'Partial team',
          description: 'One member is missing locally',
          icon: 'screwdriver-wrench',
          agents: { workflow: ['correct'], toolUse: ['review', 'ghost'] },
          texraHostedAgents: [],
        },
      ],
    });
    const { handlers, notifications } = await createHandlerFixture({
      catalog,
      workspaceState,
    });

    await applyPreset(handlers, 'partial-team');

    expect(notifications).toEqual([
      'Applied "Partial team" with 1 member still unavailable',
    ]);
  });

  it('signs in before one forced remote refresh and commits the team once', async () => {
    const workspaceState = new FakeStateStore(REMOTE_TEAM_STATE);
    const order: string[] = [];
    registry.refreshAgents.mockImplementation(async () => {
      order.push('refresh');
      registry.catalog.toolUse = [
        {
          source: 'remote',
          name: 'orchestrator',
          path: '/remote/orchestrator.yaml',
          category: 'toolUse',
          tools: ['delegate_agent'],
        },
      ];
    });
    host.executeCommand.mockImplementation(async () => {
      order.push('sign-in');
      return true;
    });
    const { handlers } = await createHandlerFixture({
      workspaceState,
      modalChoice: 'Sign in to TeXRA',
    });
    const update = vi.spyOn(workspaceState, 'update');

    await applyPreset(handlers, 'remote-team');

    expect(order).toEqual(['sign-in', 'refresh']);
    expect(host.executeCommand).toHaveBeenCalledOnce();
    expect(registry.refreshAgents).toHaveBeenCalledOnce();
    expect(registry.refreshAgents).toHaveBeenCalledWith({
      includeRemote: true,
    });
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
    const workspaceState = new FakeStateStore(REMOTE_TEAM_STATE);
    const { handlers, modalPrompts, refreshAfterAgentMutation } =
      await createHandlerFixture({ workspaceState, modalChoice: undefined });
    const update = vi.spyOn(workspaceState, 'update');

    await applyPreset(handlers, 'remote-team');

    expect(modalPrompts).toHaveLength(1);
    expect(registry.refreshAgents).not.toHaveBeenCalled();
    expect(refreshAfterAgentMutation).not.toHaveBeenCalled();
    expect(
      update.mock.calls.some(
        ([key]) => key === WorkspaceStateKey.AGENT_ROSTER_SELECTION,
      ),
    ).toBe(false);
  });
});
