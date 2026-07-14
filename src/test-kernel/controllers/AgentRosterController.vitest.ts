import { describe, expect, it } from 'vitest';

import {
  AgentRosterController,
  readAgentRosterSelection,
  type AgentRosterEntry,
} from '@agent/roster/AgentRosterController';
import type { AgentCategory } from '@shared/schemas/agent';
import type { AgentModePreset } from '@shared/schemas/agentPresets';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import type { StateStore } from '@platform/interfaces';

function memoryStore(initial: Record<string, unknown> = {}): StateStore {
  const values = new Map(Object.entries(initial));
  return {
    get: <T>(key: string, fallback?: T): T =>
      (values.has(key) ? values.get(key) : fallback) as T,
    update: async (key, value) => {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
    },
  };
}

const agents: Record<AgentCategory, AgentRosterEntry[]> = {
  workflow: [
    { category: 'workflow', source: 'builtInWorkflow', name: 'write' },
    { category: 'workflow', source: 'custom', name: 'review' },
  ],
  toolUse: [
    { category: 'toolUse', source: 'builtInToolUse', name: 'lead' },
    { category: 'toolUse', source: 'custom', name: 'search' },
  ],
};

const preset: AgentModePreset = {
  id: 'test-team',
  name: 'Test team',
  description: 'A deterministic test roster.',
  icon: 'bookmark',
  workflowAgents: ['write'],
  toolUseAgents: ['lead'],
};

function controller(
  workspaceState: StateStore,
  globalState: StateStore = memoryStore(),
): AgentRosterController {
  return new AgentRosterController({
    workspaceState,
    globalState,
    getAgents: (category) => agents[category],
    getPresets: () => [preset],
    fallbackTeamId: null,
  });
}

describe('AgentRosterController', () => {
  it('derives a named team from legacy arrays without writing during read', () => {
    const workspaceState = memoryStore({
      [WorkspaceStateKey.ENABLED_AGENTS]: ['builtInWorkflow:write'],
      [WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS]: ['lead'],
    });

    expect(readAgentRosterSelection(workspaceState, [preset])).toEqual({
      kind: 'team',
      teamId: 'test-team',
    });
    expect(
      workspaceState.get(WorkspaceStateKey.AGENT_ROSTER_SELECTION),
    ).toBeUndefined();
  });

  it('uses the user default only for inherited workspaces', () => {
    const workspaceState = memoryStore();
    const globalState = memoryStore({
      [GlobalStateKey.ONBOARDING_DEFAULT_TEAM_ID]: 'test-team',
    });
    const roster = controller(workspaceState, globalState);

    expect(roster.getSelection()).toEqual({ kind: 'inherit' });
    expect(roster.getEffectiveSelection()).toEqual({
      kind: 'team',
      teamId: 'test-team',
    });
    expect(
      roster.getVisibleAgents('toolUse').map((agent) => agent.name),
    ).toEqual(['lead']);
  });

  it('persists one canonical team selection and legacy mirrors', async () => {
    const workspaceState = memoryStore();
    const roster = controller(workspaceState);

    await roster.setTeam('test-team');

    expect(
      workspaceState.get(WorkspaceStateKey.AGENT_ROSTER_SELECTION),
    ).toEqual({
      kind: 'team',
      teamId: 'test-team',
    });
    expect(workspaceState.get(WorkspaceStateKey.ENABLED_AGENTS)).toEqual([
      'builtInWorkflow:write',
    ]);
    expect(
      workspaceState.get(WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS),
    ).toEqual(['builtInToolUse:lead']);
  });

  it('turns an individual toggle into an exact custom roster', async () => {
    const workspaceState = memoryStore();
    const roster = controller(workspaceState);
    await roster.setAll();

    await roster.setAgentEnabled({
      category: 'toolUse',
      source: 'custom',
      name: 'search',
      enabled: false,
    });

    expect(roster.getSelection()).toEqual({
      kind: 'custom',
      workflowAgentKeys: ['builtInWorkflow:write', 'custom:review'],
      toolUseAgentKeys: ['builtInToolUse:lead'],
    });
  });
});
