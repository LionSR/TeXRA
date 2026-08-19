import { describe, expect, it } from 'vitest';

import type { AgentEntry } from '@agent/index';
import {
  createSettingsAgentControllers,
  type SettingsAgentControllers,
} from '@controllers/settingsView/SettingsAgentControllerFactory';
import type { StateStore } from '@platform/interfaces';
import type { AgentCategory } from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { FakeStateStore } from '@test/support/FakePlatform';

const agents = {
  workflow: [
    {
      category: 'workflow',
      source: 'builtInWorkflow',
      name: 'write',
      path: '/agents/write.yaml',
    },
  ],
  toolUse: [
    {
      category: 'toolUse',
      source: 'builtInToolUse',
      name: 'assistant',
      path: '/agents/assistant.yaml',
    },
  ],
} as const;

function createControllers(
  workspaceState: StateStore,
  getAgents: (category: AgentCategory) => AgentEntry[] = (category) => [
    ...agents[category],
  ],
): SettingsAgentControllers {
  return createSettingsAgentControllers({
    workspaceState,
    globalState: new FakeStateStore(),
    getCustomAgentDirectory: async () => '/agents/custom',
    getSourceDirectory: async () => undefined,
    getAgents,
    getVisibleAgents: getAgents,
  });
}

function rosterSelection(workspaceState: StateStore): unknown {
  return workspaceState.get(WorkspaceStateKey.AGENT_ROSTER_SELECTION);
}

describe('createSettingsAgentControllers', () => {
  it('preserves a symbolic roster when an individual toggle is a no-op', async () => {
    const workspaceState = new FakeStateStore({
      [WorkspaceStateKey.AGENT_ROSTER_SELECTION]: { kind: 'all' },
    });
    const controllers = createControllers(workspaceState);

    await controllers.roster.setAgentEnabled({
      category: 'toolUse',
      source: 'builtInToolUse',
      name: 'assistant',
      enabled: true,
    });

    expect(rosterSelection(workspaceState)).toEqual({ kind: 'all' });
  });

  it('writes visibility changes through the canonical roster controller', async () => {
    const workspaceState = new FakeStateStore();
    const controllers = createControllers(workspaceState, (category) =>
      category === 'toolUse'
        ? [
            ...agents.toolUse,
            {
              category: 'toolUse',
              source: 'custom',
              name: 'extra',
              path: '/agents/custom/extra.yaml',
            },
          ]
        : [...agents[category]],
    );

    await controllers.catalog.setAllAgentsEnabled({
      category: 'toolUse',
      source: 'custom',
      enabled: false,
    });

    expect(rosterSelection(workspaceState)).toEqual({
      kind: 'custom',
      agentKeys: { workflow: 'all', toolUse: ['builtInToolUse:assistant'] },
    });
  });

  it('preserves unavailable members when settings toggles a visible agent', async () => {
    const workspaceState = new FakeStateStore({
      [WorkspaceStateKey.AGENT_ROSTER_SELECTION]: {
        kind: 'custom',
        agentKeys: {
          workflow: 'all',
          toolUse: ['builtInToolUse:assistant', 'future-assistant'],
        },
      },
    });
    const controllers = createControllers(workspaceState);

    await controllers.roster.setAgentEnabled({
      category: 'toolUse',
      source: 'builtInToolUse',
      name: 'assistant',
      enabled: false,
    });

    expect(rosterSelection(workspaceState)).toEqual({
      kind: 'custom',
      agentKeys: { workflow: 'all', toolUse: ['future-assistant'] },
    });
  });
});
