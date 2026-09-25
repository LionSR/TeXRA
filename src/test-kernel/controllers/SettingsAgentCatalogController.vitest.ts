import { strict as assert } from 'node:assert';

import { it } from '@effect/vitest';
import { Effect } from 'effect';

import { describe, expect } from 'vitest';

import { AgentRosterController } from '@agent/roster/AgentRosterController';
import { planTeamRun } from '@common/teams/TeamPlan';
import { findTeamPreset, teamPresets } from '@common/teams/TeamPresets';
import { SettingsAgentCatalogController } from '@controllers/settingsView/SettingsAgentCatalogController';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import {
  agentKeyOf,
  agentMatchesIdentifier,
  byCategory,
  parseAgentModePresets,
} from '@shared/schemas';
import type { AgentCategory, AgentModePreset } from '@shared/schemas';
import { FakeStateStore } from '@test/support/FakePlatform';

/** The catalog consumes the native roster and the same entry lookup. */
type SettingsAgentCatalogEntry = ReturnType<
  ConstructorParameters<typeof SettingsAgentCatalogController>[0]['getAgents']
>[0];

const AGENTS: Record<AgentCategory, SettingsAgentCatalogEntry[]> = {
  workflow: [
    {
      source: 'remote',
      name: 'writer',
      category: 'workflow',
      description: 'Remote writer',
    },
    {
      source: 'builtInWorkflow',
      name: 'correct',
      category: 'workflow',
      path: '/agents/correct.yaml',
    },
  ],
  toolUse: [
    {
      source: 'builtInToolUse',
      name: 'review',
      category: 'toolUse',
      path: '/tools/review.yaml',
      tools: ['grep'],
    },
    {
      source: 'custom',
      name: 'customTool',
      category: 'toolUse',
      path: '/custom/customTool.yaml',
    },
  ],
};

// Raw persisted records that fail current validation but must survive
// save/delete round-trips untouched.
const LEGACY_ICON_PRESET = {
  id: 'legacy-team',
  name: 'Legacy Team',
  description: 'test',
  icon: 'future-icon',
  agents: {
    workflow: [],
    toolUse: ['review'],
  },
};
const MALFORMED_PRESET = { id: 'broken' };

function createController(options?: {
  agents?: Partial<Record<AgentCategory, SettingsAgentCatalogEntry[]>>;
  enabled?: Partial<Record<AgentCategory, string[] | undefined>>;
  visible?: Partial<Record<AgentCategory, SettingsAgentCatalogEntry[]>>;
  customPresets?: unknown;
  now?: number;
}) {
  const workspaceState = new FakeStateStore({
    [WorkspaceStateKey.CUSTOM_AGENT_PRESETS]: options?.customPresets ?? [],
    ...(options?.enabled || options?.visible
      ? {
          [WorkspaceStateKey.AGENT_ROSTER_SELECTION]: {
            kind: 'custom',
            agentKeys: byCategory(
              (category) =>
                options.visible?.[category]?.map(agentKeyOf) ??
                options.enabled?.[category] ??
                'all',
            ),
          },
        }
      : {}),
  });
  const getAgents = (category: AgentCategory) =>
    options?.agents?.[category] ?? AGENTS[category];
  const roster = new AgentRosterController({
    workspaceState,
    globalState: new FakeStateStore(),
    getAgents,
    resolveAgent: (category, identifier) =>
      getAgents(category).find((entry) =>
        agentMatchesIdentifier(entry, identifier),
      ),
    getPresets: () =>
      workspaceState
        .get(WorkspaceStateKey.CUSTOM_AGENT_PRESETS, [])
        .pipe(Effect.map(parseAgentModePresets)),
  });
  return {
    controller: new SettingsAgentCatalogController({
      workspaceState,
      roster,
      getAgents,
      now: () => options?.now ?? 123,
    }),
    workspaceState,
    customPresets: workspaceState.get<unknown[]>(
      WorkspaceStateKey.CUSTOM_AGENT_PRESETS,
      [],
    ),
  };
}

describe('SettingsAgentCatalogController', () => {
  it.effect(
    'resolves preset members to canonical keys and commits the team symbolically',
    () =>
      Effect.gen(function* () {
        const persistedPreset = {
          id: 'custom-team',
          name: 'Custom Team',
          description: 'test',
          icon: 'bookmark',
          agents: {
            workflow: ['writer'],
            toolUse: ['review', 'missing'],
          },
          texraHostedAgents: [],
        };
        const { controller, workspaceState } = createController({
          customPresets: [persistedPreset],
        });

        const resolved = yield* controller.resolvePreset('custom-team');
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) throw new Error('expected the preset to resolve');
        expect(resolved.preset).toStrictEqual({
          ...persistedPreset,
          icon: 'bookmark',
          source: 'custom',
        });
        expect(resolved.resolution.unresolvedNames).toStrictEqual(['missing']);
        assert.deepEqual(resolved.resolution.keys.workflow, ['remote:writer']);
        assert.deepEqual(resolved.resolution.keys.toolUse, [
          'builtInToolUse:review',
        ]);

        yield* controller.commitPreset(resolved.preset);

        // The commit stores the team reference, not a frozen key snapshot: the
        // roster re-resolves it against the catalog on every read.
        assert.deepEqual(
          yield* workspaceState.get(WorkspaceStateKey.AGENT_ROSTER_SELECTION),
          { kind: 'team', teamId: 'custom-team' },
        );
      }),
  );

  it.effect(
    'selects preset roots without matching arbitrary orchestrator substrings',
    () =>
      Effect.gen(function* () {
        const { controller } = createController();

        assert.equal(
          yield* controller.getPresetToolUseRoot([
            'nonOrchestratorHelper',
            'engineer',
            'leanOrchestrator',
          ]),
          'engineer',
        );
        assert.equal(
          yield* controller.getPresetToolUseRoot([
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
          source: 'remote',
          name: 'lean',
          category: 'toolUse',
          tools: ['delegate_agent'],
        };
        const { controller } = createController({
          agents: { toolUse: [delegatingLean] },
        });
        const mathematician = findTeamPreset(teamPresets([]), 'mathematician');
        assert.ok(mathematician);

        const preview = yield* controller.getPresetToolUseRoot(
          mathematician.agents.toolUse,
          mathematician.id,
        );

        // Built-in semantics search only the built-in root names, so the
        // delegating 'lean' member earlier in preset order must not win.
        assert.equal(preview, 'orchestrator');
        assert.equal(
          preview,
          planTeamRun(mathematician, {
            resolveAgent: (_category, identifier) =>
              [
                delegatingLean,
                // Stand-in for the controller's synthesized built-in root entry.
                {
                  source: 'builtInToolUse' as const,
                  name: 'orchestrator',
                  category: 'toolUse' as const,
                  tools: ['delegate_agent'],
                },
              ].find((entry) => agentMatchesIdentifier(entry, identifier)),
          }).rootAgent?.name,
        );
        // The same member list previewed ad-hoc keeps custom semantics and
        // picks the preset-order-first delegating member instead.
        assert.equal(
          yield* controller.getPresetToolUseRoot(mathematician.agents.toolUse),
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
          agents: {
            workflow: [],
            toolUse: ['teamLead', 'orchestrator'],
          },
          texraHostedAgents: [],
        };
        const { controller } = createController({
          agents: {
            toolUse: [
              {
                source: 'custom',
                name: 'teamLead',
                category: 'toolUse',
                tools: ['delegate_agent'],
              },
            ],
          },
          customPresets: [customPreset],
        });

        // Preset order wins for custom teams, even over the built-in root the
        // member list names (synthesized because the catalog lacks it).
        assert.equal(
          yield* controller.getPresetToolUseRoot(
            customPreset.agents.toolUse,
            'custom-team',
          ),
          'teamLead',
        );
      }),
  );

  it.effect('saves the currently visible agents as a custom preset', () =>
    Effect.gen(function* () {
      const state = createController({
        now: 456,
        visible: {
          workflow: [AGENTS.workflow[1]],
          toolUse: [AGENTS.toolUse[0]],
        },
      });

      assert.deepEqual(
        yield* state.controller.saveCurrentPreset('  My Team  '),
        {
          id: 'custom-456',
          name: 'My Team',
          description: 'Custom team: review, correct',
          icon: 'bookmark',
          agents: {
            workflow: ['correct'],
            toolUse: ['review'],
          },
          texraHostedAgents: [],
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
        agents: {
          workflow: [],
          toolUse: [],
        },
        texraHostedAgents: [],
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
