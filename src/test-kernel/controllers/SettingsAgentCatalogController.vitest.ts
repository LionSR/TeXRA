// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Standard library imports

// Local imports - shared
import {
  SettingsAgentCatalogController,
  type SettingsAgentCatalogEntry,
} from '@controllers/settingsView/SettingsAgentCatalogController';
import type { AgentCategory } from '@shared/schemas/agent';
import type { AgentModePreset } from '@shared/schemas/agentPresets';

// Local imports - controllers

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

function createController(options?: {
  agents?: Partial<Record<AgentCategory, SettingsAgentCatalogEntry[]>>;
  enabled?: Partial<Record<AgentCategory, string[] | undefined>>;
  visible?: Partial<Record<AgentCategory, SettingsAgentCatalogEntry[]>>;
  customPresets?: unknown;
  builtInOrchestratorAgentNames?: readonly string[];
  now?: number;
  loadAgents?: () => Promise<void>;
}): {
  controller: SettingsAgentCatalogController;
  enabled: Partial<Record<AgentCategory, string[] | undefined>>;
  customPresets: AgentModePreset[];
} {
  const enabled = { ...(options?.enabled ?? {}) };
  let customPresetsRaw: unknown = options?.customPresets ?? [];
  return {
    controller: new SettingsAgentCatalogController({
      now: () => options?.now ?? 123,
      loadAgents: options?.loadAgents,
      builtInOrchestratorAgentNames: options?.builtInOrchestratorAgentNames,
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
      },
    }),
    enabled,
    get customPresets() {
      return Array.isArray(customPresetsRaw)
        ? (customPresetsRaw as AgentModePreset[])
        : [];
    },
  };
}

describe('SettingsAgentCatalogController', () => {
  it('loads the live catalog before building fresh selection data', async () => {
    const calls: string[] = [];
    const { controller } = createController({
      loadAgents: async () => {
        calls.push('load');
      },
      agents: {
        workflow: [
          {
            source: 'custom',
            name: 'draft',
            category: 'workflow',
          },
        ],
      },
    });

    assert.deepEqual(await controller.buildFreshSelectionItems(), {
      workflow: [
        {
          name: 'draft',
          source: 'custom',
          category: 'workflow',
          description: undefined,
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
          enabled: true,
        },
      ],
    });
    assert.deepEqual(calls, ['load']);
  });

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
    const calls: string[] = [];
    const persistedPreset = {
      id: 'custom-team',
      name: 'Custom Team',
      description: 'test',
      icon: 'codicon-bookmark',
      workflowAgents: ['writer'],
      toolUseAgents: ['review', 'missing'],
    };
    const { controller, enabled } = createController({
      customPresets: [persistedPreset],
      loadAgents: async () => {
        calls.push('load');
      },
    });

    assert.deepEqual(await controller.applyPreset('custom-team'), {
      ok: true,
      preset: {
        ...persistedPreset,
        icon: 'bookmark',
      },
    });
    assert.deepEqual(enabled.workflow, ['remote:writer']);
    // Unresolved names are kept bare so the agent joins the roster the
    // moment it appears (sign-in, install) — never silently dropped.
    assert.deepEqual(enabled.toolUse, ['builtInToolUse:review', 'missing']);
    assert.deepEqual(calls, ['load']);
  });

  it('reports unknown presets without writing enabled agent state', async () => {
    const { controller, enabled } = createController();

    assert.deepEqual(await controller.applyPreset('missing'), {
      ok: false,
      reason: 'unknownPreset',
    });
    assert.deepEqual(enabled, {});
  });

  it('loads invalid custom presets as an empty list', () => {
    const { controller } = createController({
      customPresets: [{ id: 'broken' }],
    });

    assert.deepEqual(controller.getCustomPresets(), []);
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
      builtInOrchestratorAgentNames: ['orchestrator'],
    });

    assert.deepEqual(controller.getOrchestratorAgentNames(), [
      'orchestrator',
      'teamLead',
    ]);
  });

  it('drops only invalid custom presets', () => {
    const { controller } = createController({
      customPresets: [
        { id: 'broken' },
        {
          id: 'custom-team',
          name: 'Custom Team',
          description: 'test',
          icon: 'codicon-bookmark',
          workflowAgents: [],
          toolUseAgents: ['review'],
        },
      ],
    });

    assert.deepEqual(controller.getCustomPresets(), [
      {
        id: 'custom-team',
        name: 'Custom Team',
        description: 'test',
        icon: 'bookmark',
        workflowAgents: [],
        toolUseAgents: ['review'],
      },
    ]);
  });

  it('saves the currently visible agents as a custom preset', async () => {
    const calls: string[] = [];
    const state = createController({
      now: 456,
      loadAgents: async () => {
        calls.push('load');
      },
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
      workflowAgents: ['correct'],
      toolUseAgents: ['review'],
    });
    assert.equal(state.customPresets.length, 1);
    assert.deepEqual(calls, ['load']);
  });

  it('deletes existing custom presets and ignores missing ones', async () => {
    const preset: AgentModePreset = {
      id: 'custom-team',
      name: 'Custom Team',
      description: 'test',
      icon: 'bookmark',
      workflowAgents: [],
      toolUseAgents: [],
    };
    const state = createController({ customPresets: [preset] });

    assert.deepEqual(
      await state.controller.deleteCustomPreset('custom-team'),
      preset,
    );
    assert.deepEqual(state.customPresets, []);
    assert.equal(await state.controller.deleteCustomPreset('missing'), null);
  });
});
