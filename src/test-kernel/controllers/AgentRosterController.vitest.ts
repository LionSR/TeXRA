import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

import {
  AgentRosterController,
  type AgentRosterControllerDeps,
  type AgentRosterEntry,
} from '@agent/roster/AgentRosterController';
import * as logger from '@logger/logUtils';
import type { StateStore } from '@platform/interfaces';
import {
  agentMatchesIdentifier,
  type AgentCategory,
  type AgentModePreset,
} from '@shared/schemas';
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
  texraHostedAgents: [],
};

function controller(
  workspaceState: StateStore,
  overrides: Partial<AgentRosterControllerDeps> = {},
): AgentRosterController {
  const getAgents =
    overrides.getAgents ?? ((category: AgentCategory) => agents[category]);
  return new AgentRosterController({
    workspaceState,
    globalState: new FakeStateStore(),
    getAgents,
    getPresets: () => [preset],
    resolveAgent: (category, identifier) =>
      getAgents(category).find((entry) =>
        agentMatchesIdentifier(entry, identifier),
      ),
    ...overrides,
  });
}

describe('AgentRosterController', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Silence the roster log channel and return the spy for assertions. */
  function stubWarn(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(logger, 'warn').mockImplementation(() => {});
  }

  function expectMalformedWarning(warn: ReturnType<typeof vi.spyOn>): void {
    expect(warn).toHaveBeenCalledWith(
      'AgentRosterController',
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

    expect(roster.snapshot().selection).toEqual({ kind: 'inherit' });
    expectMalformedWarning(warn);
  });

  it('uses the user default only for inherited workspaces', () => {
    const workspaceState = new FakeStateStore();
    const roster = controller(workspaceState, {
      globalState: new FakeStateStore({
        [GlobalStateKey.ONBOARDING_DEFAULT_TEAM_ID]: 'test-team',
      }),
    });

    expect(roster.snapshot().selection).toEqual({ kind: 'inherit' });
    expect(roster.snapshot().effectiveSelection).toEqual({
      kind: 'team',
      teamId: 'test-team',
    });
    expect(
      roster.getVisibleAgents('toolUse').map((agent) => agent.name),
    ).toEqual(['lead']);
  });

  it.effect('persists one canonical team selection', () =>
    Effect.gen(function* () {
      const workspaceState = new FakeStateStore();
      const roster = controller(workspaceState);

      yield* roster.setTeam('test-team');

      expect(
        workspaceState.get(WorkspaceStateKey.AGENT_ROSTER_SELECTION),
      ).toEqual({
        kind: 'team',
        teamId: 'test-team',
      });
    }),
  );

  it.effect('turns an individual toggle into an exact custom roster', () =>
    Effect.gen(function* () {
      const workspaceState = new FakeStateStore();
      const roster = controller(workspaceState);
      yield* roster.setAll();

      yield* roster.setAgentEnabled({
        category: 'toolUse',
        source: 'custom',
        name: 'search',
        enabled: false,
      });

      expect(roster.snapshot().selection).toEqual({
        kind: 'custom',
        agentKeys: {
          workflow: 'all',
          toolUse: ['builtInToolUse:lead'],
        },
      });
    }),
  );

  it.effect(
    'preserves symbolic roster semantics when a toggle changes nothing',
    () =>
      Effect.gen(function* () {
        const inheritedState = new FakeStateStore();
        const inherited = controller(inheritedState, {
          globalState: new FakeStateStore({
            [GlobalStateKey.ONBOARDING_DEFAULT_TEAM_ID]: 'test-team',
          }),
        });
        yield* inherited.setAgentEnabled({
          category: 'workflow',
          source: 'builtInWorkflow',
          name: 'write',
          enabled: true,
        });
        expect(inherited.snapshot().selection).toEqual({ kind: 'inherit' });
        expect(
          inheritedState.get(WorkspaceStateKey.AGENT_ROSTER_SELECTION),
        ).toBeUndefined();

        const team = controller(new FakeStateStore());
        yield* team.setTeam('test-team');
        yield* team.setAgentEnabled({
          category: 'toolUse',
          source: 'builtInToolUse',
          name: 'lead',
          enabled: true,
        });
        expect(team.snapshot().selection).toEqual({
          kind: 'team',
          teamId: 'test-team',
        });

        const all = controller(new FakeStateStore());
        yield* all.setAll();
        yield* all.setAgentEnabled({
          category: 'toolUse',
          source: 'custom',
          name: 'search',
          enabled: true,
        });
        expect(all.snapshot().selection).toEqual({ kind: 'all' });
      }),
  );

  it.effect(
    'preserves unresolved team members when another category changes',
    () =>
      Effect.gen(function* () {
        const unavailablePreset: AgentModePreset = {
          ...preset,
          id: 'partly-unavailable',
          agents: { ...preset.agents, workflow: ['write', 'future-reviewer'] },
        };
        const workspaceState = new FakeStateStore();
        const roster = controller(workspaceState, {
          getPresets: () => [unavailablePreset],
        });
        yield* roster.setTeam(unavailablePreset.id);

        expect(roster.getEnabledAgentKeys('workflow')).toEqual([
          'builtInWorkflow:write',
          'future-reviewer',
        ]);

        yield* roster.setAgentEnabled({
          category: 'toolUse',
          source: 'custom',
          name: 'search',
          enabled: true,
        });

        expect(roster.snapshot().selection).toEqual({
          kind: 'custom',
          agentKeys: {
            workflow: ['builtInWorkflow:write', 'future-reviewer'],
            toolUse: ['builtInToolUse:lead', 'custom:search'],
          },
        });
      }),
  );

  it('falls back to all agents for a missing symbolic team', () => {
    const workspaceState = new FakeStateStore({
      [WorkspaceStateKey.AGENT_ROSTER_SELECTION]: {
        kind: 'team',
        teamId: 'deleted-team',
      },
    });
    const roster = controller(workspaceState);

    expect(roster.snapshot().effectiveSelection).toEqual({ kind: 'all' });
    expect(roster.getVisibleAgents('toolUse')).toEqual(agents.toolUse);
    expect(roster.snapshot().missingTeamId).toBe('deleted-team');
  });

  it.effect(
    'materializes an active custom team before deleting its preset',
    () =>
      Effect.gen(function* () {
        let presets: AgentModePreset[] = [preset];
        const workspaceState = new FakeStateStore();
        const roster = controller(workspaceState, {
          getPresets: () => presets,
        });
        yield* roster.setTeam(preset.id);

        yield* roster.removeTeamPreset(preset.id, () =>
          Effect.sync(() => {
            presets = [];
          }),
        );

        expect(roster.snapshot().selection).toEqual({
          kind: 'custom',
          agentKeys: {
            workflow: ['builtInWorkflow:write'],
            toolUse: ['builtInToolUse:lead'],
          },
        });
      }),
  );

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

  it.effect(
    'serializes concurrent category changes through one workspace owner',
    () =>
      Effect.gen(function* () {
        const workspaceState = new FakeStateStore();
        const first = controller(workspaceState);
        const second = controller(workspaceState);
        yield* first.setAll();

        yield* Effect.all(
          [
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
          ],
          { concurrency: 'unbounded' },
        );

        expect(first.snapshot().selection).toEqual({
          kind: 'custom',
          agentKeys: {
            workflow: ['builtInWorkflow:write'],
            toolUse: ['builtInToolUse:lead'],
          },
        });
      }),
  );
});
