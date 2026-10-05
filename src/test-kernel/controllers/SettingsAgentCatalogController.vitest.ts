import { strict as assert } from 'node:assert';

import { it } from '@effect/vitest';
import { Effect } from 'effect';

import { describe, expect } from 'vitest';

import { WorkspaceAgentsController } from '@agent/workspaceAgents/WorkspaceAgentsController';
import { planTeamRun } from '@common/teams/TeamPlan';
import { findTeamPreset, teamPresets } from '@common/teams/TeamPresets';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import {
  agentKeyOf,
  agentMatchesIdentifier,
  parseAgentModePresets,
} from '@shared/schemas';
import type { AgentModePreset } from '@shared/schemas';
import { FakeStateStore } from '@test/support/FakePlatform';
import { SettingsAgentCatalogController } from '@texra/controllers/settingsView/SettingsAgentCatalogController';

/** The catalog consumes the native agent list and the same entry lookup. */
type SettingsAgentCatalogEntry = ReturnType<
  ConstructorParameters<typeof SettingsAgentCatalogController>[0]['getAgents']
>[0];

const AGENTS: SettingsAgentCatalogEntry[] = [
  {
    source: 'plugin',
    name: 'writer',
    task: null,
    description: 'Plugin writer',
  },
  {
    source: 'builtIn',
    name: 'correct',
    task: null,
    path: '/agents/correct.yaml',
  },
  {
    source: 'builtIn',
    name: 'review',
    task: null,
    path: '/tools/review.yaml',
    tools: ['grep'],
  },
  {
    source: 'custom',
    name: 'customTool',
    task: null,
    path: '/custom/customTool.yaml',
  },
];

// Raw persisted records that fail current validation but must survive
// save/delete round-trips untouched.
const LEGACY_ICON_PRESET = {
  id: 'legacy-team',
  name: 'Legacy Team',
  description: 'test',
  icon: 'future-icon',
  agents: ['review'],
};
const MALFORMED_PRESET = { id: 'broken' };

function createController(options?: {
  agents?: SettingsAgentCatalogEntry[];
  visible?: SettingsAgentCatalogEntry[];
  customPresets?: unknown;
  now?: number;
}) {
  const getAgents = () => options?.agents ?? AGENTS;
  const workspaceState = new FakeStateStore({
    [WorkspaceStateKey.CUSTOM_TEAMS]: options?.customPresets ?? [],
    // A `visible` agent list is the user's choice: the custom agents it leaves out
    // were turned off.
    ...(options?.visible
      ? {
          [WorkspaceStateKey.WORKSPACE_AGENTS]: {
            kind: 'custom',
            agentKeys: options.visible.map(agentKeyOf),
          },
          [WorkspaceStateKey.HIDDEN_CUSTOM_AGENTS]: getAgents()
            .filter(
              (entry) =>
                entry.source === 'custom' && !options.visible?.includes(entry),
            )
            .map(agentKeyOf),
        }
      : {}),
  });
  const workspaceAgents = new WorkspaceAgentsController({
    repoState: workspaceState,
    globalState: new FakeStateStore(),
    getAgents,
    resolveAgent: (identifier) =>
      getAgents().find((entry) => agentMatchesIdentifier(entry, identifier)),
    getPresets: () =>
      workspaceState
        .get(WorkspaceStateKey.CUSTOM_TEAMS)
        .pipe(Effect.map(parseAgentModePresets)),
  });
  return {
    workspaceAgents,
    controller: new SettingsAgentCatalogController({
      repoState: workspaceState,
      workspaceAgents,
      getAgents,
      newerBuiltInOf: () => undefined,
      now: () => options?.now ?? 123,
    }),
    workspaceState,
    customPresets: workspaceState
      .get(WorkspaceStateKey.CUSTOM_TEAMS)
      .pipe(Effect.map((stored) => (stored ?? []) as unknown[])),
  };
}

describe('SettingsAgentCatalogController', () => {
  it.effect(
    'applying a team resolves its members to canonical keys and stores the team symbolically',
    () =>
      Effect.gen(function* () {
        const persistedPreset = {
          id: 'custom-team',
          name: 'Custom Team',
          description: 'test',
          icon: 'bookmark',
          agents: ['writer', 'review', 'missing'],
        };
        const { workspaceAgents, workspaceState } = createController({
          customPresets: [persistedPreset],
        });

        const resolved = yield* workspaceAgents.applyTeam('custom-team');
        if (resolved.status !== 'applied')
          throw new Error('expected the preset to apply');
        expect(resolved.preset).toStrictEqual({
          ...persistedPreset,
          icon: 'bookmark',
          source: 'custom',
        });
        assert.deepEqual(resolved.resolution.missingAgents, ['missing']);
        assert.deepEqual(resolved.resolution.agentKeys, [
          'plugin:writer',
          'builtIn:review',
        ]);

        // The commit stores the team reference, not a frozen key snapshot: the
        // agent list re-resolves it against the catalog on every read.
        assert.deepEqual(
          yield* workspaceState.get(WorkspaceStateKey.WORKSPACE_AGENTS),
          { kind: 'team', teamId: 'custom-team' },
        );
      }),
  );

  it.effect(
    'selects preset roots without matching arbitrary orchestrator substrings',
    () =>
      Effect.gen(function* () {
        const delegating = (name: string): SettingsAgentCatalogEntry => ({
          source: 'builtIn',
          name,
          task: null,
          tools: ['agent'],
        });
        const { controller } = createController({
          agents: [delegating('engineer'), delegating('leanOrchestrator')],
        });

        assert.equal(
          yield* controller.getPresetRoot([
            'nonOrchestratorHelper',
            'engineer',
            'leanOrchestrator',
          ]),
          'engineer',
        );
        assert.equal(
          yield* controller.getPresetRoot([
            'nonOrchestratorHelper',
            'leanOrchestrator',
          ]),
          'leanOrchestrator',
        );
      }),
  );

  it.effect(
    'previews a built-in team with the root planTeamRun picks for it',
    () =>
      Effect.gen(function* () {
        const delegatingLean: SettingsAgentCatalogEntry = {
          source: 'plugin',
          name: 'lean',
          task: null,
          tools: ['agent'],
        };
        const orchestrator: SettingsAgentCatalogEntry = {
          source: 'builtIn',
          name: 'orchestrator',
          task: null,
          tools: ['agent'],
        };
        const { controller } = createController({
          agents: [delegatingLean, orchestrator],
        });
        const mathematician = findTeamPreset(teamPresets([]), 'mathematician');
        assert.ok(mathematician);

        const preview = yield* controller.getPresetRoot(
          mathematician.agents,
          mathematician.id,
        );

        // Built-in semantics search only the built-in root names, so the
        // delegating 'lean' member earlier in preset order must not win.
        assert.equal(preview, 'orchestrator');
        assert.equal(
          preview,
          planTeamRun(mathematician, {
            resolveAgent: (identifier) =>
              [delegatingLean, orchestrator].find((entry) =>
                agentMatchesIdentifier(entry, identifier),
              ),
          }).rootAgent?.name,
        );
        // The same member list previewed ad-hoc keeps custom semantics and
        // picks the preset-order-first delegating member instead.
        assert.equal(
          yield* controller.getPresetRoot(mathematician.agents),
          'lean',
        );
      }),
  );

  it.effect(
    'keeps custom root semantics when a custom team is previewed by id',
    () =>
      Effect.gen(function* () {
        const customPreset = {
          id: 'custom-team',
          name: 'Custom Team',
          description: 'test',
          icon: 'bookmark',
          agents: ['teamLead', 'orchestrator'],
        };
        const { controller } = createController({
          agents: [
            {
              source: 'custom',
              name: 'teamLead',
              task: null,
              tools: ['agent'],
            },
          ],
          customPresets: [customPreset],
        });

        // Preset order wins for custom teams, even over the built-in root the
        // member list names.
        assert.equal(
          yield* controller.getPresetRoot(customPreset.agents, 'custom-team'),
          'teamLead',
        );
      }),
  );

  it.effect('saves the currently visible agents as a custom preset', () =>
    Effect.gen(function* () {
      const state = createController({
        now: 456,
        visible: [AGENTS[1], AGENTS[2]],
      });

      assert.deepEqual(
        yield* state.controller.saveCurrentPreset('  My Team  '),
        {
          id: 'custom-456',
          name: 'My Team',
          description: 'Custom team: correct, review',
          icon: 'bookmark',
          agents: ['correct', 'review'],
        },
      );
      assert.equal((yield* state.customPresets).length, 1);
    }),
  );

  it.effect(
    'preserves unrecognized persisted records when saving a preset',
    () =>
      Effect.gen(function* () {
        const state = createController({
          customPresets: [LEGACY_ICON_PRESET, MALFORMED_PRESET],
        });

        yield* state.controller.saveCurrentPreset('New Team');

        assert.deepEqual((yield* state.customPresets).slice(0, 2), [
          LEGACY_ICON_PRESET,
          MALFORMED_PRESET,
        ]);
        assert.equal(
          ((yield* state.customPresets)[2] as AgentModePreset | undefined)?.id,
          'custom-123',
        );
      }),
  );

  it.effect('preserves other raw records when deleting a preset', () =>
    Effect.gen(function* () {
      const target: AgentModePreset = {
        id: 'target',
        name: 'Target',
        description: 'test',
        icon: 'bookmark',
        agents: [],
      };
      const state = createController({
        customPresets: [target, LEGACY_ICON_PRESET, MALFORMED_PRESET],
      });

      assert.deepEqual(
        yield* state.controller.deleteCustomPreset(target.id),
        target,
      );
      assert.deepEqual(yield* state.customPresets, [
        LEGACY_ICON_PRESET,
        MALFORMED_PRESET,
      ]);
    }),
  );
});
