import { strict as assert } from 'node:assert';

import { describe, expect, it } from 'vitest';

import {
  findTeamPreset,
  planTeamRun,
  teamPresets,
} from '@common/teams/TeamPlan';
import {
  SettingsAgentCatalogController,
  type SettingsAgentCatalogEntry,
} from '@controllers/settingsView/SettingsAgentCatalogController';
import { BUILTIN_TEAM_ROOT_AGENT_NAMES } from '@shared/constants/agents';
import type { AgentCategory } from '@shared/schemas/agent';
import {
  AGENT_MODE_PRESETS_BY_ID,
  type AgentModePreset,
} from '@shared/schemas/agentPresets';

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
}): {
  controller: SettingsAgentCatalogController;
  enabled: Partial<Record<AgentCategory, string[] | undefined>>;
  customPresets: unknown[];
} {
  const enabled = { ...(options?.enabled ?? {}) };
  let customPresetsRaw: unknown = options?.customPresets ?? [];
  return {
    controller: new SettingsAgentCatalogController({
      now: () => options?.now ?? 123,
      state: {
        getEnabledAgentKeys: (category) => enabled[category],
        setEnabledAgentKeys: async (category, enabledKeys) => {
          enabled[category] = enabledKeys;
        },
        getAgents: (category) =>
          options?.agents?.[category] ?? AGENTS[category],
        getVisibleAgents: (category) =>
          options?.visible?.[category] ??
          options?.agents?.[category] ??
          AGENTS[category],
        getCustomPresetsRaw: () => customPresetsRaw,
        setCustomPresets: async (presets) => {
          customPresetsRaw = presets;
        },
        removeCustomPreset: async (_presetId, remaining) => {
          customPresetsRaw = remaining;
        },
      },
    }),
    enabled,
    get customPresets() {
      return Array.isArray(customPresetsRaw) ? customPresetsRaw : [];
    },
  };
}

describe('SettingsAgentCatalogController', () => {
  it('builds sorted selection items with never-configured and legacy enabled state', () => {
    const { controller } = createController({
      enabled: {
        toolUse: ['customTool'],
      },
    });

    assert.deepEqual(controller.buildSelectionItems(), {
      workflow: [
        {
          name: 'correct',
          source: 'builtInWorkflow',
          category: 'workflow',
          description: undefined,
          hasPath: true,
          filePath: '/agents/correct.yaml',
          tools: undefined,
          enabled: true,
        },
        {
          name: 'writer',
          source: 'remote',
          category: 'workflow',
          description: 'Remote writer',
          hasPath: false,
          filePath: undefined,
          tools: undefined,
          enabled: true,
        },
      ],
      toolUse: [
        {
          name: 'customTool',
          source: 'custom',
          category: 'toolUse',
          description: undefined,
          hasPath: true,
          filePath: '/custom/customTool.yaml',
          tools: undefined,
          enabled: true,
        },
        {
          name: 'review',
          source: 'builtInToolUse',
          category: 'toolUse',
          description: undefined,
          hasPath: true,
          filePath: '/tools/review.yaml',
          tools: ['grep'],
          enabled: false,
        },
      ],
    });
  });

  it('applies custom presets by resolving names to canonical source keys', async () => {
    const persistedPreset = {
      id: 'custom-team',
      name: 'Custom Team',
      description: 'test',
      icon: 'codicon-bookmark',
      agents: {
        workflow: ['writer'],
        toolUse: ['review', 'missing'],
      },
    };
    const { controller, enabled } = createController({
      customPresets: [persistedPreset],
    });

    const resolved = controller.resolvePreset('custom-team');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error('expected the preset to resolve');
    expect(resolved.preset).toStrictEqual({
      ...persistedPreset,
      icon: 'bookmark',
    });
    expect(resolved.resolution.unresolvedNames).toStrictEqual(['missing']);
    await controller.commitPresetResolution(
      resolved.preset,
      resolved.resolution,
    );

    assert.deepEqual(enabled.workflow, ['remote:writer']);
    // Unresolved names are kept bare so the agent joins the roster the
    // moment it appears (sign-in, install) — never silently dropped.
    assert.deepEqual(enabled.toolUse, ['builtInToolUse:review', 'missing']);
  });

  it('reports unknown presets without writing enabled agent state', () => {
    const { controller, enabled } = createController();

    expect(controller.resolvePreset('missing')).toStrictEqual({
      ok: false,
      reason: 'unknownPreset',
    });
    assert.deepEqual(enabled, {});
  });

  it('loads invalid custom presets as an empty list', () => {
    const { controller } = createController({
      customPresets: [MALFORMED_PRESET],
    });

    assert.deepEqual(controller.getCustomPresets(), []);
  });

  it('records hosted-definition ownership when saving a custom team', async () => {
    const { controller } = createController();

    const preset = await controller.saveCurrentPreset('Current Team');

    assert.deepEqual(preset.texraHostedAgents, ['writer']);
  });

  it('collects built-in and capability-based orchestrator agent names', () => {
    const { controller } = createController({
      agents: {
        toolUse: [
          ...AGENTS.toolUse,
          {
            source: 'custom',
            name: 'teamLead',
            category: 'toolUse',
            tools: ['delegate_agent'],
          },
        ],
      },
    });

    assert.deepEqual(
      controller.getOrchestratorAgentNames(),
      [...BUILTIN_TEAM_ROOT_AGENT_NAMES, 'teamLead'].sort(),
    );
  });

  it('selects preset roots without matching arbitrary orchestrator substrings', () => {
    const { controller } = createController();

    assert.equal(
      controller.getPresetToolUseRoot([
        'nonOrchestratorHelper',
        'engineer',
        'leanOrchestrator',
      ]),
      'engineer',
    );
    assert.equal(
      controller.getPresetToolUseRoot([
        'nonOrchestratorHelper',
        'leanOrchestrator',
      ]),
      'leanOrchestrator',
    );
  });

  it('previews no root for a custom team with no delegating members', () => {
    const { controller } = createController();

    // The launcher disables this team with "no runnable team root"; the
    // preview must agree instead of inventing a built-in root.
    assert.equal(
      controller.getPresetToolUseRoot(['review', 'customTool']),
      undefined,
    );
  });

  it('previews the engineer root for the built-in Software Engineer team', () => {
    const { controller } = createController();
    const softwareEngineer = AGENT_MODE_PRESETS_BY_ID.get('software-engineer');

    assert.ok(softwareEngineer);
    assert.equal(
      controller.getPresetToolUseRoot(softwareEngineer.agents.toolUse),
      'engineer',
    );
  });

  it('previews the orchestrator root for a built-in team before the catalog loads', () => {
    const { controller } = createController({
      agents: { toolUse: [] },
    });
    const physicist = AGENT_MODE_PRESETS_BY_ID.get('physicist');

    assert.ok(physicist);
    assert.equal(
      controller.getPresetToolUseRoot(physicist.agents.toolUse),
      'orchestrator',
    );
  });

  it('previews a built-in team with the root planTeamRun picks for it', () => {
    const delegatingLean: SettingsAgentCatalogEntry = {
      source: 'remote',
      name: 'lean',
      category: 'toolUse',
      tools: ['delegate_agent'],
    };
    const { controller } = createController({
      agents: { toolUse: [delegatingLean] },
    });
    const mathematician = AGENT_MODE_PRESETS_BY_ID.get('mathematician');
    assert.ok(mathematician);

    const preview = controller.getPresetToolUseRoot(
      mathematician.agents.toolUse,
      mathematician.id,
    );

    // Built-in semantics search only the built-in root names, so the
    // delegating 'lean' member earlier in preset order must not win.
    assert.equal(preview, 'orchestrator');
    const realPreset = findTeamPreset(teamPresets([]), mathematician.id);
    assert.ok(realPreset);
    assert.equal(
      preview,
      planTeamRun(realPreset, {
        agents: {
          workflow: [],
          toolUse: [
            delegatingLean,
            // Stand-in for the controller's synthesized built-in root entry.
            {
              source: 'builtInToolUse',
              name: 'orchestrator',
              category: 'toolUse',
              tools: ['delegate_agent'],
            },
          ],
        },
      }).rootAgent?.name,
    );
    // The same member list previewed ad-hoc keeps custom semantics and
    // picks the preset-order-first delegating member instead.
    assert.equal(
      controller.getPresetToolUseRoot(mathematician.agents.toolUse),
      'lean',
    );
  });

  it('keeps custom root semantics when a custom team is previewed by id', () => {
    const customPreset = {
      id: 'custom-team',
      name: 'Custom Team',
      description: 'test',
      icon: 'bookmark',
      agents: {
        workflow: [],
        toolUse: ['teamLead', 'orchestrator'],
      },
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
      controller.getPresetToolUseRoot(
        customPreset.agents.toolUse,
        'custom-team',
      ),
      'teamLead',
    );
  });

  it('falls back to custom semantics for an unresolvable preset id', () => {
    const { controller } = createController();

    assert.equal(
      controller.getPresetToolUseRoot(['review', 'customTool'], 'missing-team'),
      undefined,
    );
  });

  it('drops only invalid custom presets', () => {
    const { controller } = createController({
      customPresets: [
        MALFORMED_PRESET,
        {
          id: 'custom-team',
          name: 'Custom Team',
          description: 'test',
          icon: 'codicon-bookmark',
          agents: {
            workflow: [],
            toolUse: ['review'],
          },
        },
      ],
    });

    assert.deepEqual(controller.getCustomPresets(), [
      {
        id: 'custom-team',
        name: 'Custom Team',
        description: 'test',
        icon: 'bookmark',
        agents: {
          workflow: [],
          toolUse: ['review'],
        },
      },
    ]);
  });

  it('saves the currently visible agents as a custom preset', async () => {
    const state = createController({
      now: 456,
      visible: {
        workflow: [AGENTS.workflow[1]],
        toolUse: [AGENTS.toolUse[0]],
      },
    });

    assert.deepEqual(await state.controller.saveCurrentPreset('  My Team  '), {
      id: 'custom-456',
      name: 'My Team',
      description: 'Custom team: review, correct',
      icon: 'bookmark',
      agents: {
        workflow: ['correct'],
        toolUse: ['review'],
      },
      texraHostedAgents: [],
    });
    assert.equal(state.customPresets.length, 1);
  });

  it('preserves unrecognized persisted records when saving a preset', async () => {
    const state = createController({
      customPresets: [LEGACY_ICON_PRESET, MALFORMED_PRESET],
    });

    await state.controller.saveCurrentPreset('New Team');

    assert.deepEqual(state.customPresets.slice(0, 2), [
      LEGACY_ICON_PRESET,
      MALFORMED_PRESET,
    ]);
    assert.equal(
      (state.customPresets[2] as AgentModePreset | undefined)?.id,
      'custom-123',
    );
  });

  it('deletes existing custom presets and ignores missing ones', async () => {
    const preset: AgentModePreset = {
      id: 'custom-team',
      name: 'Custom Team',
      description: 'test',
      icon: 'bookmark',
      agents: {
        workflow: [],
        toolUse: [],
      },
    };
    const state = createController({ customPresets: [preset] });

    assert.deepEqual(
      await state.controller.deleteCustomPreset('custom-team'),
      preset,
    );
    assert.deepEqual(state.customPresets, []);
    assert.equal(await state.controller.deleteCustomPreset('missing'), null);
  });

  it('preserves other raw records when deleting a preset', async () => {
    const target: AgentModePreset = {
      id: 'target',
      name: 'Target',
      description: 'test',
      icon: 'bookmark',
      agents: {
        workflow: [],
        toolUse: [],
      },
    };
    const state = createController({
      customPresets: [target, LEGACY_ICON_PRESET, MALFORMED_PRESET],
    });

    assert.deepEqual(
      await state.controller.deleteCustomPreset(target.id),
      target,
    );
    assert.deepEqual(state.customPresets, [
      LEGACY_ICON_PRESET,
      MALFORMED_PRESET,
    ]);
  });
});
