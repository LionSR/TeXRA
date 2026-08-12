import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AgentRosterController,
  type AgentRosterControllerDeps,
  type AgentRosterEntry,
} from '@agent/roster/AgentRosterController';
import type { StateStore } from '@platform/interfaces';
import {
  agentMatchesIdentifier,
  type AgentCategory,
} from '@shared/schemas/agent';
import {
  STARTER_AGENT_MODE_PRESET,
  type AgentModePreset,
} from '@shared/schemas/agentPresets';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import { FakeStateStore } from '@test/support/FakePlatform';

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
  agents: {
    workflow: ['write'],
    toolUse: ['lead'],
  },
};

function controller(
  workspaceState: StateStore,
  overrides: Partial<AgentRosterControllerDeps> = {},
): AgentRosterController {
  const getAgents =
    overrides.getAgents ?? ((category: AgentCategory) => agents[category]);
  const resolveAgent =
    overrides.resolveAgent ??
    ((category: AgentCategory, identifier: string) =>
      getAgents(category).find((entry) =>
        agentMatchesIdentifier(entry, identifier),
      ));
  return new AgentRosterController({
    workspaceState,
    globalState: new FakeStateStore(),
    getPresets: () => [preset],
    ...overrides,
    getAgents,
    resolveAgent,
  });
}

describe('AgentRosterController', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Silence console.warn and return the spy for warning assertions. */
  function stubWarn(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(console, 'warn').mockImplementation(() => {});
  }

  function expectMalformedWarning(warn: ReturnType<typeof vi.spyOn>): void {
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('malformed roster selection'),
    );
  }

  it('warns and falls back to the inherited roster on malformed state', () => {
    const warn = stubWarn();
    const roster = controller(
      new FakeStateStore({
        [WorkspaceStateKey.AGENT_ROSTER_SELECTION]: { kind: 'invalid' },
      }),
    );

    expect(roster.getSelection()).toEqual({ kind: 'inherit' });
    expectMalformedWarning(warn);
  });

  it('treats the retired pair-shaped roster as malformed and overwrites it in place', async () => {
    // The pre-record `workflowAgentKeys`/`toolUseAgentKeys` pair is retired
    // vocabulary: it warns and reads as inherited, and the next write
    // replaces it at the same key.
    const warn = stubWarn();
    const pairShaped = {
      kind: 'custom',
      workflowAgentKeys: ['builtInWorkflow:write'],
      toolUseAgentKeys: 'all',
    };
    const workspaceState = new FakeStateStore({
      [WorkspaceStateKey.AGENT_ROSTER_SELECTION]: pairShaped,
    });
    const roster = controller(workspaceState);

    expect(roster.getSelection()).toEqual({ kind: 'inherit' });
    expectMalformedWarning(warn);

    await roster.setTeam('test-team');
    expect(
      workspaceState.get(WorkspaceStateKey.AGENT_ROSTER_SELECTION),
    ).toEqual({ kind: 'team', teamId: 'test-team' });
    expect(roster.getSelection()).toEqual({
      kind: 'team',
      teamId: 'test-team',
    });
  });

  it('reads the hybrid pair-shaped roster without mutating workspace state', () => {
    // An intermediate version wrote `{kind: 'custom', workflowAgentKeys,
    // toolUseAgentKeys}` under AGENT_ROSTER_SELECTION. Neither the canonical
    // schema (missing `agentKeys`) nor the strict legacy schema (rejects
    // `kind`) accepts it, so it must be normalized to the canonical custom
    // selection without warning.
    const warn = stubWarn();
    const hybrid = {
      kind: 'custom',
      workflowAgentKeys: ['builtInWorkflow:write'],
      toolUseAgentKeys: ['builtInToolUse:lead'],
    };
    const workspaceState = new FakeStateStore({
      [WorkspaceStateKey.AGENT_ROSTER_SELECTION]: hybrid,
    });
    const update = vi.spyOn(workspaceState, 'update');
    const roster = controller(workspaceState);

    expect(roster.getSelection()).toEqual({
      kind: 'custom',
      agentKeys: {
        workflow: ['builtInWorkflow:write'],
        toolUse: ['builtInToolUse:lead'],
      },
    });
    expect(warn).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(workspaceState.get(WorkspaceStateKey.AGENT_ROSTER_SELECTION)).toBe(
      hybrid,
    );
  });

  it('uses the user default only for inherited workspaces', () => {
    const workspaceState = new FakeStateStore();
    const roster = controller(workspaceState, {
      globalState: new FakeStateStore({
        [GlobalStateKey.ONBOARDING_DEFAULT_TEAM_ID]: 'test-team',
      }),
    });

    expect(roster.getSelection()).toEqual({ kind: 'inherit' });
    expect(roster.getEffectiveSelection()).toEqual({
      kind: 'team',
      teamId: 'test-team',
    });
    expect(
      roster.getVisibleAgents('toolUse').map((agent) => agent.name),
    ).toEqual(['lead']);
  });

  it('updates the user default without rewriting workspace selection', async () => {
    const workspaceState = new FakeStateStore();
    const workspaceUpdate = vi.spyOn(workspaceState, 'update');
    const globalState = new FakeStateStore();
    const roster = controller(workspaceState, { globalState });

    await roster.setDefaultTeam(STARTER_AGENT_MODE_PRESET.id);

    expect(roster.getDefaultTeamId()).toBe(STARTER_AGENT_MODE_PRESET.id);
    expect(workspaceUpdate).not.toHaveBeenCalled();

    await roster.clearDefaultTeam();

    expect(roster.getDefaultTeamId()).toBeUndefined();
    expect(workspaceUpdate).not.toHaveBeenCalled();
  });

  it('persists one canonical team selection', async () => {
    const workspaceState = new FakeStateStore();
    const roster = controller(workspaceState);

    await roster.setTeam('test-team');

    expect(
      workspaceState.get(WorkspaceStateKey.AGENT_ROSTER_SELECTION),
    ).toEqual({
      kind: 'team',
      teamId: 'test-team',
    });
  });

  it('turns an individual toggle into an exact custom roster', async () => {
    const workspaceState = new FakeStateStore();
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
      agentKeys: {
        workflow: 'all',
        toolUse: ['builtInToolUse:lead'],
      },
    });
  });

  it('preserves symbolic roster semantics when a toggle changes nothing', async () => {
    const inheritedState = new FakeStateStore();
    const inherited = controller(inheritedState, {
      globalState: new FakeStateStore({
        [GlobalStateKey.ONBOARDING_DEFAULT_TEAM_ID]: 'test-team',
      }),
    });
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

    const team = controller(new FakeStateStore());
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

    const all = controller(new FakeStateStore());
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
      agents: { ...preset.agents, workflow: ['write', 'future-reviewer'] },
    };
    const workspaceState = new FakeStateStore();
    const roster = controller(workspaceState, {
      getPresets: () => [unavailablePreset],
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
      agentKeys: {
        workflow: ['builtInWorkflow:write', 'future-reviewer'],
        toolUse: ['builtInToolUse:lead', 'custom:search'],
      },
    });
  });

  it('falls back to all agents for a missing symbolic team', () => {
    const workspaceState = new FakeStateStore({
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

  it('builds a snapshot from one coherent preset catalog', async () => {
    let presetReads = 0;
    const workspaceState = new FakeStateStore();
    const roster = controller(workspaceState, {
      getPresets: () => {
        presetReads += 1;
        return presetReads === 1 ? [preset] : [];
      },
    });
    await roster.setTeam(preset.id);
    presetReads = 0;

    const snapshot = roster.snapshot();

    expect(presetReads).toBe(1);
    expect(snapshot.effectiveSelection).toEqual({
      kind: 'team',
      teamId: preset.id,
    });
    expect(snapshot.missingTeamId).toBeUndefined();
    expect(snapshot.agents.workflow.map((agent) => agent.name)).toEqual([
      'write',
    ]);
    expect(snapshot.agents.toolUse.map((agent) => agent.name)).toEqual([
      'lead',
    ]);
  });

  it('materializes an active custom team before deleting its preset', async () => {
    let presets: AgentModePreset[] = [preset];
    const workspaceState = new FakeStateStore();
    const roster = controller(workspaceState, { getPresets: () => presets });
    await roster.setTeam(preset.id);

    await roster.removeTeamPreset(preset.id, async () => {
      presets = [];
    });

    expect(roster.getSelection()).toEqual({
      kind: 'custom',
      agentKeys: {
        workflow: ['builtInWorkflow:write'],
        toolUse: ['builtInToolUse:lead'],
      },
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
    const roster = controller(
      new FakeStateStore({
        [WorkspaceStateKey.AGENT_ROSTER_SELECTION]: {
          kind: 'custom',
          agentKeys: {
            workflow: [],
            toolUse: ['remote:review'],
          },
        },
      }),
      { getAgents: (category) => duplicateAgents[category] },
    );

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
    const roster = controller(
      new FakeStateStore({
        [WorkspaceStateKey.AGENT_ROSTER_SELECTION]: {
          kind: 'custom',
          agentKeys: {
            workflow: [],
            toolUse: ['remote:review'],
          },
        },
      }),
      {
        getAgents: (category) => (category === 'toolUse' ? [custom] : []),
        resolveAgent: (_category, identifier) =>
          identifier === 'remote:review' ? remote : undefined,
      },
    );

    expect(roster.getVisibleAgents('toolUse')).toEqual([remote]);
  });

  it('serializes concurrent category changes through one workspace owner', async () => {
    const workspaceState = new FakeStateStore();
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
      agentKeys: {
        workflow: ['builtInWorkflow:write'],
        toolUse: ['builtInToolUse:lead'],
      },
    });
  });
});
