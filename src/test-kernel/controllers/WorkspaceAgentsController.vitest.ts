import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

import {
  WorkspaceAgentsController,
  type WorkspaceAgentsControllerDeps,
  type WorkspaceAgentsEntry,
} from '@agent/workspaceAgents/WorkspaceAgentsController';
import type { StateStore } from '@platform/interfaces';
import { agentMatchesIdentifier, type AgentModePreset } from '@shared/schemas';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import { FakeStateStore } from '@test/support/FakePlatform';

const agents: WorkspaceAgentsEntry[] = [
  { source: 'builtIn', name: 'write' },
  { source: 'custom', name: 'review' },
  { source: 'builtIn', name: 'lead' },
  { source: 'custom', name: 'search' },
];

const preset: AgentModePreset = {
  id: 'test-team',
  name: 'Test team',
  description: 'A deterministic test workspaceAgents.',
  icon: 'bookmark',
  agents: ['write', 'lead'],
};

function controller(
  workspaceState: StateStore,
  overrides: Partial<WorkspaceAgentsControllerDeps> = {},
): WorkspaceAgentsController {
  const getAgents = overrides.getAgents ?? (() => agents);
  return new WorkspaceAgentsController({
    repoState: workspaceState,
    globalState: new FakeStateStore(),
    getAgents,
    getPresets: () => Effect.succeed([preset]),
    resolveAgent: (identifier) =>
      getAgents().find((entry) => agentMatchesIdentifier(entry, identifier)),
    ...overrides,
  });
}

describe('WorkspaceAgentsController', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.effect('uses the user default only for inherited workspaces', () =>
    Effect.gen(function* () {
      const workspaceState = new FakeStateStore();
      const workspaceAgents = controller(workspaceState, {
        globalState: new FakeStateStore({
          [GlobalStateKey.ONBOARDING_DEFAULT_TEAM_ID]: 'test-team',
        }),
      });

      expect((yield* workspaceAgents.snapshot()).selection).toEqual({
        kind: 'inherit',
      });
      expect((yield* workspaceAgents.snapshot()).effectiveSelection).toEqual({
        kind: 'team',
        teamId: 'test-team',
      });
      // The team names `write` and `lead`; a custom agent it does not name is
      // shown too.
      expect(
        (yield* workspaceAgents.getVisibleAgents()).map((agent) => agent.name),
      ).toEqual(['write', 'lead', 'review', 'search']);
    }),
  );

  it.effect('turns an individual toggle into an exact custom agent list', () =>
    Effect.gen(function* () {
      const workspaceState = new FakeStateStore();
      const workspaceAgents = controller(workspaceState);
      yield* workspaceAgents.setAll();

      yield* workspaceAgents.setAgentEnabled({
        source: 'custom',
        name: 'search',
        enabled: false,
      });

      expect((yield* workspaceAgents.snapshot()).selection).toEqual({
        kind: 'custom',
        agentKeys: ['builtIn:write', 'custom:review', 'builtIn:lead'],
      });
      // Turned off, it stays off under a team that does not name it.
      yield* workspaceAgents.setTeam('test-team');
      expect(
        (yield* workspaceAgents.getVisibleAgents()).map((agent) => agent.name),
      ).toEqual(['write', 'lead', 'review']);
    }),
  );

  it.effect(
    'keeps a hidden custom agent hidden when the agent list is all',
    () =>
      Effect.gen(function* () {
        const workspaceAgents = controller(
          new FakeStateStore({
            [WorkspaceStateKey.HIDDEN_CUSTOM_AGENTS]: ['custom:search'],
          }),
        );
        expect(
          (yield* workspaceAgents.getVisibleAgents()).map(
            (agent) => agent.name,
          ),
        ).toEqual(['write', 'review', 'lead']);
      }),
  );

  it.effect('reads a bare name in a written list as choosing that agent', () =>
    Effect.gen(function* () {
      const workspaceAgents = controller(new FakeStateStore());
      // The CLI writes bare names (`--tool-use lead,search`).
      yield* workspaceAgents.setEnabledAgentKeys(['lead', 'search']);
      yield* workspaceAgents.setTeam('test-team');
      expect(
        (yield* workspaceAgents.getVisibleAgents()).map((agent) => agent.name),
      ).toEqual(['write', 'lead', 'search']);
    }),
  );

  it.effect(
    'preserves symbolic agent list semantics when a toggle changes nothing',
    () =>
      Effect.gen(function* () {
        const inheritedState = new FakeStateStore();
        const inherited = controller(inheritedState, {
          globalState: new FakeStateStore({
            [GlobalStateKey.ONBOARDING_DEFAULT_TEAM_ID]: 'test-team',
          }),
        });
        yield* inherited.setAgentEnabled({
          source: 'builtIn',
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
          source: 'builtIn',
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
          source: 'custom',
          name: 'search',
          enabled: true,
        });
        expect((yield* all.snapshot()).selection).toEqual({ kind: 'all' });
      }),
  );

  it.effect(
    'preserves unresolved team members when a toggle rewrites the list',
    () =>
      Effect.gen(function* () {
        const unavailablePreset: AgentModePreset = {
          ...preset,
          id: 'partly-unavailable',
          agents: ['write', 'future-reviewer', 'lead'],
        };
        const workspaceState = new FakeStateStore();
        const workspaceAgents = controller(workspaceState, {
          getPresets: () => Effect.succeed([unavailablePreset]),
        });
        yield* workspaceAgents.setTeam(unavailablePreset.id);

        expect(yield* workspaceAgents.getEnabledAgentKeys()).toEqual([
          'builtIn:write',
          'future-reviewer',
          'builtIn:lead',
          'custom:review',
          'custom:search',
        ]);

        yield* workspaceAgents.setAgentEnabled({
          source: 'custom',
          name: 'search',
          enabled: false,
        });

        expect((yield* workspaceAgents.snapshot()).selection).toEqual({
          kind: 'custom',
          agentKeys: [
            'builtIn:write',
            'future-reviewer',
            'builtIn:lead',
            'custom:review',
          ],
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
      const workspaceAgents = controller(workspaceState);

      expect((yield* workspaceAgents.snapshot()).effectiveSelection).toEqual({
        kind: 'all',
      });
      expect(yield* workspaceAgents.getVisibleAgents()).toEqual(agents);
      expect((yield* workspaceAgents.snapshot()).missingTeamId).toBe(
        'deleted-team',
      );
    }),
  );

  it.effect(
    'materializes an active custom team before deleting its preset',
    () =>
      Effect.gen(function* () {
        let presets: AgentModePreset[] = [preset];
        const workspaceState = new FakeStateStore();
        const workspaceAgents = controller(workspaceState, {
          getPresets: () => Effect.succeed(presets),
        });
        yield* workspaceAgents.setTeam(preset.id);

        yield* workspaceAgents.removeTeamPreset(preset.id, () =>
          Effect.sync(() => {
            presets = [];
          }),
        );

        expect((yield* workspaceAgents.snapshot()).selection).toEqual({
          kind: 'custom',
          agentKeys: [
            'builtIn:write',
            'builtIn:lead',
            'custom:review',
            'custom:search',
          ],
        });
      }),
  );

  it.effect(
    'matches source-qualified custom selections by exact identity',
    () =>
      Effect.gen(function* () {
        const duplicateAgents: WorkspaceAgentsEntry[] = [
          { source: 'custom', name: 'review' },
          { source: 'plugin', name: 'review' },
        ];
        const workspaceAgents = controller(
          new FakeStateStore({
            [WorkspaceStateKey.WORKSPACE_AGENTS]: {
              kind: 'custom',
              agentKeys: ['plugin:review'],
            },
            // Hidden, so only the exact identity decides what shows.
            [WorkspaceStateKey.HIDDEN_CUSTOM_AGENTS]: ['custom:review'],
          }),
          { getAgents: () => duplicateAgents },
        );

        expect(yield* workspaceAgents.getVisibleAgents()).toEqual([
          { source: 'plugin', name: 'review' },
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
        const workspaceAgents = controller(workspaceState, {
          getAgents: () => [],
        });
        const hidden = () =>
          workspaceState.get(WorkspaceStateKey.HIDDEN_CUSTOM_AGENTS);

        yield* workspaceAgents.setEnabledAgentKeys([]);
        expect(yield* hidden()).toEqual(['custom:review', 'custom:search']);

        yield* workspaceAgents.forgetDeletedAgent('review');
        expect(yield* hidden()).toEqual(['custom:search']);
      }),
  );

  it.effect('serializes concurrent toggles through one workspace owner', () =>
    Effect.gen(function* () {
      const workspaceState = new FakeStateStore();
      const first = controller(workspaceState);
      const second = controller(workspaceState);
      yield* first.setAll();

      yield* Effect.all(
        [
          first.setAgentEnabled({
            source: 'custom',
            name: 'review',
            enabled: false,
          }),
          second.setAgentEnabled({
            source: 'custom',
            name: 'search',
            enabled: false,
          }),
        ],
        { concurrency: 'unbounded' },
      );

      expect((yield* first.snapshot()).selection).toEqual({
        kind: 'custom',
        agentKeys: ['builtIn:write', 'builtIn:lead'],
      });
    }),
  );
});
