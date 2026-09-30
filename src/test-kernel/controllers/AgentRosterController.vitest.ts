import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

import {
  AgentRosterController,
  type AgentRosterControllerDeps,
  type AgentRosterEntry,
} from '@agent/roster/AgentRosterController';
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
};

function controller(
  workspaceState: StateStore,
  overrides: Partial<AgentRosterControllerDeps> = {},
): AgentRosterController {
  const getAgents =
    overrides.getAgents ?? ((category: AgentCategory) => agents[category]);
  return new AgentRosterController({
    repoState: workspaceState,
    globalState: new FakeStateStore(),
    getAgents,
    getPresets: () => Effect.succeed([preset]),
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

  it.effect('uses the user default only for inherited workspaces', () =>
    Effect.gen(function* () {
      const workspaceState = new FakeStateStore();
      const roster = controller(workspaceState, {
        globalState: new FakeStateStore({
          [GlobalStateKey.ONBOARDING_DEFAULT_TEAM_ID]: 'test-team',
        }),
      });

      expect((yield* roster.snapshot()).selection).toEqual({ kind: 'inherit' });
      expect((yield* roster.snapshot()).effectiveSelection).toEqual({
        kind: 'team',
        teamId: 'test-team',
      });
      // The team names `lead`; a custom agent it does not name is shown too.
      expect(
        (yield* roster.getVisibleAgents('toolUse')).map((agent) => agent.name),
      ).toEqual(['lead', 'search']);
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

      expect((yield* roster.snapshot()).selection).toEqual({
        kind: 'custom',
        agentKeys: {
          workflow: 'all',
          toolUse: ['builtInToolUse:lead'],
        },
      });
      // Turned off, it stays off under a team that does not name it.
      yield* roster.setTeam('test-team');
      expect(
        (yield* roster.getVisibleAgents('toolUse')).map((agent) => agent.name),
      ).toEqual(['lead']);
    }),
  );

  it.effect('keeps a hidden custom agent hidden when the roster is all', () =>
    Effect.gen(function* () {
      const roster = controller(
        new FakeStateStore({
          [WorkspaceStateKey.HIDDEN_CUSTOM_AGENTS]: ['custom:search'],
        }),
      );
      expect(
        (yield* roster.getVisibleAgents('toolUse')).map((agent) => agent.name),
      ).toEqual(['lead']);
      // Editing one category leaves the others symbolic, so agents added
      // later still appear there.
      yield* roster.setEnabledAgentKeys('workflow', ['write']);
      expect((yield* roster.snapshot()).selection).toEqual({
        kind: 'custom',
        agentKeys: { workflow: ['write'], toolUse: 'all' },
      });
    }),
  );

  it.effect('reads a bare name in a written list as choosing that agent', () =>
    Effect.gen(function* () {
      const roster = controller(new FakeStateStore());
      // The CLI writes bare names (`--tool-use lead,search`).
      yield* roster.setEnabledAgentKeys('toolUse', ['lead', 'search']);
      yield* roster.setTeam('test-team');
      expect(
        (yield* roster.getVisibleAgents('toolUse')).map((agent) => agent.name),
      ).toEqual(['lead', 'search']);
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
        expect((yield* inherited.snapshot()).selection).toEqual({
          kind: 'inherit',
        });
        expect(
          yield* inheritedState.get(WorkspaceStateKey.WORKSPACE_AGENTS),
        ).toBeUndefined();

        const team = controller(new FakeStateStore());
        yield* team.setTeam('test-team');
        yield* team.setAgentEnabled({
          category: 'toolUse',
          source: 'builtInToolUse',
          name: 'lead',
          enabled: true,
        });
        expect((yield* team.snapshot()).selection).toEqual({
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
        expect((yield* all.snapshot()).selection).toEqual({ kind: 'all' });
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
          getPresets: () => Effect.succeed([unavailablePreset]),
        });
        yield* roster.setTeam(unavailablePreset.id);

        expect(yield* roster.getEnabledAgentKeys('workflow')).toEqual([
          'builtInWorkflow:write',
          'future-reviewer',
          'custom:review',
        ]);

        yield* roster.setAgentEnabled({
          category: 'toolUse',
          source: 'custom',
          name: 'search',
          enabled: false,
        });

        expect((yield* roster.snapshot()).selection).toEqual({
          kind: 'custom',
          agentKeys: {
            workflow: [
              'builtInWorkflow:write',
              'future-reviewer',
              'custom:review',
            ],
            toolUse: ['builtInToolUse:lead'],
          },
        });
      }),
  );

  it.effect('falls back to all agents for a missing symbolic team', () =>
    Effect.gen(function* () {
      const workspaceState = new FakeStateStore({
        [WorkspaceStateKey.WORKSPACE_AGENTS]: {
          kind: 'team',
          teamId: 'deleted-team',
        },
      });
      const roster = controller(workspaceState);

      expect((yield* roster.snapshot()).effectiveSelection).toEqual({
        kind: 'all',
      });
      expect(yield* roster.getVisibleAgents('toolUse')).toEqual(agents.toolUse);
      expect((yield* roster.snapshot()).missingTeamId).toBe('deleted-team');
    }),
  );

  it.effect(
    'materializes an active custom team before deleting its preset',
    () =>
      Effect.gen(function* () {
        let presets: AgentModePreset[] = [preset];
        const workspaceState = new FakeStateStore();
        const roster = controller(workspaceState, {
          getPresets: () => Effect.succeed(presets),
        });
        yield* roster.setTeam(preset.id);

        yield* roster.removeTeamPreset(preset.id, () =>
          Effect.sync(() => {
            presets = [];
          }),
        );

        expect((yield* roster.snapshot()).selection).toEqual({
          kind: 'custom',
          agentKeys: {
            workflow: ['builtInWorkflow:write', 'custom:review'],
            toolUse: ['builtInToolUse:lead', 'custom:search'],
          },
        });
      }),
  );

  it.effect(
    'matches source-qualified custom selections by exact identity',
    () =>
      Effect.gen(function* () {
        const duplicateAgents: Record<AgentCategory, AgentRosterEntry[]> = {
          workflow: [],
          toolUse: [
            { category: 'toolUse', source: 'custom', name: 'review' },
            { category: 'toolUse', source: 'plugin', name: 'review' },
          ],
        };
        const roster = controller(
          new FakeStateStore({
            [WorkspaceStateKey.WORKSPACE_AGENTS]: {
              kind: 'custom',
              agentKeys: {
                workflow: [],
                toolUse: ['plugin:review'],
              },
            },
            // Hidden, so only the exact identity decides what shows.
            [WorkspaceStateKey.HIDDEN_CUSTOM_AGENTS]: ['custom:review'],
          }),
          { getAgents: (category) => duplicateAgents[category] },
        );

        expect(yield* roster.getVisibleAgents('toolUse')).toEqual([
          { category: 'toolUse', source: 'plugin', name: 'review' },
        ]);
      }),
  );

  it.effect(
    'keeps hidden keys through an empty catalog; a delete drops only its own',
    () =>
      Effect.gen(function* () {
        const workspaceState = new FakeStateStore({
          [WorkspaceStateKey.HIDDEN_CUSTOM_AGENTS]: [
            'custom:review',
            'custom:search',
          ],
        });
        // The catalog has not published its first scan: no agent is known.
        const roster = controller(workspaceState, { getAgents: () => [] });
        const hidden = () =>
          workspaceState.get(WorkspaceStateKey.HIDDEN_CUSTOM_AGENTS);

        yield* roster.setEnabledAgentKeys('toolUse', []);
        expect(yield* hidden()).toEqual(['custom:review', 'custom:search']);

        yield* roster.forgetDeletedAgent('review');
        expect(yield* hidden()).toEqual(['custom:search']);
      }),
  );

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

        expect((yield* first.snapshot()).selection).toEqual({
          kind: 'custom',
          agentKeys: {
            workflow: ['builtInWorkflow:write'],
            toolUse: ['builtInToolUse:lead'],
          },
        });
      }),
  );
});
