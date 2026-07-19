import { describe, expect, it } from 'vitest';

import {
  AgentRosterController,
  readAgentRosterSelection,
  type AgentRosterEntry,
} from '@agent/roster/AgentRosterController';
import type { StateStore } from '@platform/interfaces';
import type { AgentCategory } from '@shared/schemas/agent';
import {
  STARTER_AGENT_MODE_PRESET,
  type AgentModePreset,
} from '@shared/schemas/agentPresets';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';

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

  it('preserves legacy all-agents semantics for an unset category', () => {
    const workspaceState = memoryStore({
      [WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS]: [],
    });
    const roster = controller(workspaceState);

    expect(roster.getSelection()).toEqual({
      kind: 'custom',
      workflowAgentKeys: 'all',
      toolUseAgentKeys: [],
    });
    expect(roster.getVisibleAgents('workflow')).toEqual(agents.workflow);
  });

  it('rejects malformed canonical state instead of treating corruption as inheritance', () => {
    const roster = controller(
      memoryStore({
        [WorkspaceStateKey.AGENT_ROSTER_SELECTION]: { kind: 'invalid' },
      }),
    );

    expect(() => roster.getSelection()).toThrow();
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

  it('refreshes compatibility mirrors when an inherited default changes', async () => {
    const workspaceState = memoryStore();
    const roster = controller(workspaceState, memoryStore());

    await roster.setDefaultTeam(STARTER_AGENT_MODE_PRESET.id);

    expect(roster.getSelection()).toEqual({ kind: 'inherit' });
    expect(workspaceState.get(WorkspaceStateKey.ENABLED_AGENTS)).toEqual(
      STARTER_AGENT_MODE_PRESET.workflowAgents,
    );
    expect(
      workspaceState.get(WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS),
    ).toEqual(STARTER_AGENT_MODE_PRESET.toolUseAgents);

    await roster.clearDefaultTeam();
    expect(
      workspaceState.get(WorkspaceStateKey.ENABLED_AGENTS),
    ).toBeUndefined();
    expect(
      workspaceState.get(WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS),
    ).toBeUndefined();
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
      workflowAgentKeys: 'all',
      toolUseAgentKeys: ['builtInToolUse:lead'],
    });
  });

  it('preserves symbolic roster semantics when a toggle changes nothing', async () => {
    const inheritedState = memoryStore();
    const inherited = controller(
      inheritedState,
      memoryStore({
        [GlobalStateKey.ONBOARDING_DEFAULT_TEAM_ID]: 'test-team',
      }),
    );
    await inherited.setAgentEnabled({
      category: 'workflow',
      source: 'builtInWorkflow',
      name: 'write',
      enabled: true,
    });
    expect(inherited.getSelection()).toEqual({ kind: 'inherit' });
    expect(
      inheritedState.get(WorkspaceStateKey.AGENT_ROSTER_SELECTION),
    ).toBeUndefined();

    const team = controller(memoryStore());
    await team.setTeam('test-team');
    await team.setAgentEnabled({
      category: 'toolUse',
      source: 'builtInToolUse',
      name: 'lead',
      enabled: true,
    });
    expect(team.getSelection()).toEqual({
      kind: 'team',
      teamId: 'test-team',
    });

    const all = controller(memoryStore());
    await all.setAll();
    await all.setAgentEnabled({
      category: 'toolUse',
      source: 'custom',
      name: 'search',
      enabled: true,
    });
    expect(all.getSelection()).toEqual({ kind: 'all' });
  });

  it('preserves unresolved team members when another category changes', async () => {
    const unavailablePreset: AgentModePreset = {
      ...preset,
      id: 'partly-unavailable',
      workflowAgents: ['write', 'future-reviewer'],
    };
    const workspaceState = memoryStore();
    const roster = new AgentRosterController({
      workspaceState,
      globalState: memoryStore(),
      getAgents: (category) => agents[category],
      getPresets: () => [unavailablePreset],
      fallbackTeamId: null,
    });
    await roster.setTeam(unavailablePreset.id);

    expect(roster.getEnabledAgentKeys('workflow')).toEqual([
      'builtInWorkflow:write',
      'future-reviewer',
    ]);

    await roster.setAgentEnabled({
      category: 'toolUse',
      source: 'custom',
      name: 'search',
      enabled: true,
    });

    expect(roster.getSelection()).toEqual({
      kind: 'custom',
      workflowAgentKeys: ['builtInWorkflow:write', 'future-reviewer'],
      toolUseAgentKeys: ['builtInToolUse:lead', 'custom:search'],
    });
  });

  it('keeps an unset legacy category open to agents loaded later', async () => {
    const workspaceState = memoryStore({
      [WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS]: ['builtInToolUse:lead'],
    });
    const workflowAgents = [...agents.workflow];
    const roster = new AgentRosterController({
      workspaceState,
      globalState: memoryStore(),
      getAgents: (category) =>
        category === 'workflow' ? workflowAgents : agents.toolUse,
      getPresets: () => [preset],
      fallbackTeamId: null,
    });

    workflowAgents.push({
      category: 'workflow',
      source: 'remote',
      name: 'future',
    });
    await roster.setEnabledAgentKeys('toolUse', ['builtInToolUse:lead']);

    expect(roster.getSelection()).toEqual({
      kind: 'custom',
      workflowAgentKeys: 'all',
      toolUseAgentKeys: ['builtInToolUse:lead'],
    });
    expect(roster.getVisibleAgents('workflow')).toContainEqual(
      expect.objectContaining({ name: 'future' }),
    );
  });

  it('falls back to all agents for a missing symbolic team', () => {
    const workspaceState = memoryStore({
      [WorkspaceStateKey.AGENT_ROSTER_SELECTION]: {
        kind: 'team',
        teamId: 'deleted-team',
      },
    });
    const roster = controller(workspaceState);

    expect(roster.getEffectiveSelection()).toEqual({ kind: 'all' });
    expect(roster.getVisibleAgents('toolUse')).toEqual(agents.toolUse);
    expect(roster.snapshot().missingTeamId).toBe('deleted-team');
  });

  it('materializes an active custom team before deleting its preset', async () => {
    let presets: AgentModePreset[] = [preset];
    const workspaceState = memoryStore();
    const roster = new AgentRosterController({
      workspaceState,
      globalState: memoryStore(),
      getAgents: (category) => agents[category],
      getPresets: () => presets,
      fallbackTeamId: null,
    });
    await roster.setTeam(preset.id);

    await roster.removeTeamPreset(preset.id, async () => {
      presets = [];
    });

    expect(roster.getSelection()).toEqual({
      kind: 'custom',
      workflowAgentKeys: ['builtInWorkflow:write'],
      toolUseAgentKeys: ['builtInToolUse:lead'],
    });
  });

  it('matches source-qualified custom selections by exact identity', () => {
    const duplicateAgents: Record<AgentCategory, AgentRosterEntry[]> = {
      workflow: [],
      toolUse: [
        { category: 'toolUse', source: 'custom', name: 'review' },
        { category: 'toolUse', source: 'remote', name: 'review' },
      ],
    };
    const roster = new AgentRosterController({
      workspaceState: memoryStore({
        [WorkspaceStateKey.AGENT_ROSTER_SELECTION]: {
          kind: 'custom',
          workflowAgentKeys: [],
          toolUseAgentKeys: ['remote:review'],
        },
      }),
      globalState: memoryStore(),
      getAgents: (category) => duplicateAgents[category],
      fallbackTeamId: null,
    });

    expect(roster.getVisibleAgents('toolUse')).toEqual([
      { category: 'toolUse', source: 'remote', name: 'review' },
    ]);
  });

  it('resolves an exact source key hidden by the display projection', () => {
    const custom: AgentRosterEntry = {
      category: 'toolUse',
      source: 'custom',
      name: 'review',
    };
    const remote: AgentRosterEntry = {
      category: 'toolUse',
      source: 'remote',
      name: 'review',
    };
    const roster = new AgentRosterController({
      workspaceState: memoryStore({
        [WorkspaceStateKey.AGENT_ROSTER_SELECTION]: {
          kind: 'custom',
          workflowAgentKeys: [],
          toolUseAgentKeys: ['remote:review'],
        },
      }),
      globalState: memoryStore(),
      getAgents: (category) => (category === 'toolUse' ? [custom] : []),
      resolveAgent: (_category, identifier) =>
        identifier === 'remote:review' ? remote : undefined,
      fallbackTeamId: null,
    });

    expect(roster.getVisibleAgents('toolUse')).toEqual([remote]);
  });

  it('serializes concurrent category changes through one workspace owner', async () => {
    const workspaceState = memoryStore();
    const first = controller(workspaceState);
    const second = controller(workspaceState);
    await first.setAll();

    await Promise.all([
      first.setAgentEnabled({
        category: 'workflow',
        source: 'custom',
        name: 'review',
        enabled: false,
      }),
      second.setAgentEnabled({
        category: 'toolUse',
        source: 'custom',
        name: 'search',
        enabled: false,
      }),
    ]);

    expect(first.getSelection()).toEqual({
      kind: 'custom',
      workflowAgentKeys: ['builtInWorkflow:write'],
      toolUseAgentKeys: ['builtInToolUse:lead'],
    });
  });

  it('surfaces rollback failures together with the original write error', async () => {
    const originalError = new Error('canonical write failed');
    const rollbackError = new Error('mirror rollback failed');
    const initialSelection = {
      kind: 'custom' as const,
      workflowAgentKeys: ['builtInWorkflow:write'],
      toolUseAgentKeys: ['builtInToolUse:lead'],
    };
    const storedState = memoryStore({
      [WorkspaceStateKey.AGENT_ROSTER_SELECTION]: initialSelection,
      [WorkspaceStateKey.ENABLED_AGENTS]: initialSelection.workflowAgentKeys,
      [WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS]:
        initialSelection.toolUseAgentKeys,
    });
    const workspaceState: StateStore = {
      get: storedState.get.bind(storedState),
      update: async (key, value) => {
        if (
          key === WorkspaceStateKey.AGENT_ROSTER_SELECTION &&
          (value as { readonly kind?: string } | undefined)?.kind === 'all'
        ) {
          throw originalError;
        }
        if (
          key === WorkspaceStateKey.ENABLED_AGENTS &&
          value === initialSelection.workflowAgentKeys
        ) {
          throw rollbackError;
        }
        await storedState.update(key, value);
      },
    };
    const roster = controller(workspaceState);

    let thrown: unknown;
    try {
      await roster.setAll();
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([
      originalError,
      expect.objectContaining({ cause: rollbackError }),
    ]);
  });
});
