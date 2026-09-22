import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAgentCatalogAuthRefreshScopeForTests } from '@frontend/auth/agentCatalogRefreshScope';
import type { AgentCategory } from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { createDeferred } from '@test/support/asyncTestUtils';
import { testRuntime } from '@test/support/testProcessRuntime';
import {
  physicistCatalog,
  type AgentCatalog,
} from '@test/support/agentCatalogFixtures';
import { FakeStateStore } from '@test/support/FakePlatform';
import { installPlatform } from '@test/support/setupPlatform';

const host = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
}));

vi.mock('vscode', async () => {
  const actual = await vi.importActual<typeof import('vscode')>('vscode');
  return {
    ...actual,
    window: {
      ...actual.window,
      showErrorMessage: host.showErrorMessage,
      showInformationMessage: host.showInformationMessage,
      showWarningMessage: host.showWarningMessage,
    },
  };
});

const registry = vi.hoisted(() => ({
  catalog: { workflow: [], toolUse: [] } as AgentCatalog,
  loadAgents: vi.fn(() => Effect.void),
  refreshAgents: vi.fn(() => Effect.void),
}));

vi.mock('@agent/index', async () => ({
  ...(await vi.importActual<typeof import('@agent/index')>('@agent/index')),
  loadAgents: registry.loadAgents,
  refresh: registry.refreshAgents,
  getAgentsByCategory: (category: AgentCategory) => registry.catalog[category],
  getVisibleAgents: (category: AgentCategory) => registry.catalog[category],
}));

const { AgentHandlers } = await import('@settingsView/handlers/agentHandlers');

type Handlers = InstanceType<typeof AgentHandlers>;

function applyPreset(handlers: Handlers, presetId: string): Promise<void> {
  return testRuntime().runPromise(
    handlers.handleApplyAgentModePreset({
      command: 'applyAgentModePreset',
      presetId,
    }),
  );
}

interface HandlerFixtureOptions {
  readonly workspaceState?: FakeStateStore;
  readonly catalog?: AgentCatalog;
  /** Button label returned by the modal "members unavailable" prompt. */
  readonly modalChoice?: string | undefined;
  readonly infoMessageResult?: Promise<string | undefined>;
  /** Fired after an information message is recorded. */
  readonly onInfoMessage?: (message: string) => void;
}

async function createHandlerFixture(options: HandlerFixtureOptions = {}) {
  const workspaceState = options.workspaceState ?? new FakeStateStore();
  const globalState = new FakeStateStore();
  registry.catalog = options.catalog ?? { workflow: [], toolUse: [] };
  await installPlatform({}, { workspaceState, globalState });

  const notifications: string[] = [];
  const modalPrompts: string[] = [];
  host.showInformationMessage.mockImplementation((message: string) => {
    notifications.push(message);
    options.onInfoMessage?.(message);
    return options.infoMessageResult;
  });
  host.showWarningMessage.mockImplementation(async (message: string) => {
    modalPrompts.push(message);
    return options.modalChoice ? { title: options.modalChoice } : undefined;
  });

  const refreshAfterAgentMutation = vi.fn(
    (_selectedToolUseAgent?: string, _catalogFresh?: boolean) => Effect.void,
  );
  const handlers = new AgentHandlers(
    {
      channel: 'TeXRA',
      log: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      extensionContext: {} as never,
      withActiveWebview: () => Effect.void,
      postMessageToActiveWebview: () => Effect.void,
      run: (program) => testRuntime().runPromise(program),
    },
    refreshAfterAgentMutation,
    { workspaceState, globalState },
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
    registry.refreshAgents.mockImplementation(() => Effect.void);
    resetAgentCatalogAuthRefreshScopeForTests();
  });

  it('applies source-qualified teams without awaiting notification dismissal', async () => {
    const notified = createDeferred();
    const {
      handlers,
      notifications,
      refreshAfterAgentMutation,
      workspaceState,
    } = await createHandlerFixture({
      catalog: physicistCatalog(),
      modalChoice: 'Continue with Available Members',
      infoMessageResult: new Promise(() => {}),
      onInfoMessage: () => notified.resolve(),
    });

    await applyPreset(handlers, 'physicist');

    expect(
      workspaceState.get(WorkspaceStateKey.AGENT_ROSTER_SELECTION),
    ).toEqual({ kind: 'team', teamId: 'physicist' });
    expect(refreshAfterAgentMutation).toHaveBeenCalledWith(
      'orchestrator',
      true,
    );
    await notified.promise;
    expect(notifications).toEqual([
      'Applied "Physicist" with 7 members still unavailable',
    ]);
  });

  it('does not write roster state when team preflight is cancelled', async () => {
    const workspaceState = new FakeStateStore(REMOTE_TEAM_STATE);
    const { handlers, modalPrompts, refreshAfterAgentMutation } =
      await createHandlerFixture({ workspaceState, modalChoice: undefined });
    const update = vi.spyOn(workspaceState, 'update');

    await applyPreset(handlers, 'remote-team');

    expect(modalPrompts).toEqual([
      'Team "Remote team" has unavailable TeXRA-hosted members: orchestrator.',
    ]);
    expect(host.showWarningMessage).toHaveBeenCalledWith(
      modalPrompts[0],
      { modal: true },
      { title: 'Sign In to TeXRA', isCloseAffordance: false },
      {
        title: 'Continue with Available Members',
        isCloseAffordance: false,
      },
      { title: 'Cancel', isCloseAffordance: true },
    );
    expect(registry.refreshAgents).not.toHaveBeenCalled();
    expect(refreshAfterAgentMutation).not.toHaveBeenCalled();
    expect(
      update.mock.calls.some(
        ([key]) => key === WorkspaceStateKey.AGENT_ROSTER_SELECTION,
      ),
    ).toBe(false);
  });
});
