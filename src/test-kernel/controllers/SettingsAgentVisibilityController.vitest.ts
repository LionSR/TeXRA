// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - controllers
import {
  SettingsAgentVisibilityController,
  type SettingsAgentVisibilityEntry,
} from '@controllers/settingsView/SettingsAgentVisibilityController';
import type { AgentCategory } from '@shared/schemas/agent';

describe('SettingsAgentVisibilityController', () => {
  it('removes legacy bare-name entries when disabling a source-qualified agent', async () => {
    const enabledByCategory = new Map<AgentCategory, string[]>();
    enabledByCategory.set('workflow', ['criticize', 'builtInWorkflow:other']);
    const controller = new SettingsAgentVisibilityController({
      state: {
        getEnabledAgentKeys: (category) => enabledByCategory.get(category),
        setEnabledAgentKeys: async (category, enabledKeys) => {
          enabledByCategory.set(category, enabledKeys);
        },
        getAgents: () => [
          { source: 'builtInWorkflow', name: 'criticize' },
          { source: 'builtInWorkflow', name: 'other' },
        ],
      },
    });

    await controller.setAgentEnabled({
      category: 'workflow',
      source: 'builtInWorkflow',
      name: 'criticize',
      enabled: false,
    });

    expect(enabledByCategory.get('workflow')).toEqual([
      'builtInWorkflow:other',
    ]);
  });
});

const AGENTS: Record<AgentCategory, SettingsAgentVisibilityEntry[]> = {
  workflow: [
    { source: 'builtInWorkflow', name: 'correct' },
    { source: 'custom', name: 'customWriter' },
    { source: 'remote', name: 'remoteWriter' },
  ],
  toolUse: [
    { source: 'builtInToolUse', name: 'claudeCode' },
    { source: 'custom', name: 'customTool' },
  ],
};

function createController(options?: {
  enabled?: Partial<Record<AgentCategory, string[] | undefined>>;
}): {
  controller: SettingsAgentVisibilityController;
  enabled: Partial<Record<AgentCategory, string[] | undefined>>;
} {
  const enabled = { ...(options?.enabled ?? {}) };
  return {
    controller: new SettingsAgentVisibilityController({
      state: {
        getEnabledAgentKeys: (category) => enabled[category],
        setEnabledAgentKeys: async (category, enabledKeys) => {
          enabled[category] = enabledKeys;
        },
        getAgents: (category) => AGENTS[category],
      },
    }),
    enabled,
  };
}

describe('SettingsAgentVisibilityController', () => {
  it('seeds all other agents when disabling from never-configured state', async () => {
    const { controller, enabled } = createController();

    await controller.setAgentEnabled({
      category: 'workflow',
      source: 'custom',
      name: 'customWriter',
      enabled: false,
    });

    assert.deepEqual(enabled.workflow, [
      'builtInWorkflow:correct',
      'remote:remoteWriter',
    ]);
  });

  it('removes canonical and legacy names from configured state', async () => {
    const { controller, enabled } = createController({
      enabled: {
        workflow: [
          'builtInWorkflow:correct',
          'customWriter',
          'remote:remoteWriter',
        ],
      },
    });

    await controller.setAgentEnabled({
      category: 'workflow',
      source: 'custom',
      name: 'customWriter',
      enabled: false,
    });

    assert.deepEqual(enabled.workflow, [
      'builtInWorkflow:correct',
      'remote:remoteWriter',
    ]);
  });

  it('adds canonical keys without duplicating legacy enabled entries', async () => {
    const { controller, enabled } = createController({
      enabled: { workflow: ['customWriter'] },
    });

    await controller.setAgentEnabled({
      category: 'workflow',
      source: 'custom',
      name: 'customWriter',
      enabled: true,
    });

    assert.deepEqual(enabled.workflow, ['customWriter']);
  });

  it('disables every agent from a source while preserving other sources', async () => {
    const { controller, enabled } = createController({
      enabled: {
        workflow: [
          'builtInWorkflow:correct',
          'custom:customWriter',
          'remoteWriter',
        ],
      },
    });

    await controller.setAllAgentsEnabled({
      category: 'workflow',
      source: 'remote',
      enabled: false,
    });

    assert.deepEqual(enabled.workflow, [
      'builtInWorkflow:correct',
      'custom:customWriter',
    ]);
  });

  it('enables missing source agents without duplicating existing keys', async () => {
    const { controller, enabled } = createController({
      enabled: { workflow: ['builtInWorkflow:correct'] },
    });

    await controller.setAllAgentsEnabled({
      category: 'workflow',
      source: 'custom',
      enabled: true,
    });

    assert.deepEqual(enabled.workflow, [
      'builtInWorkflow:correct',
      'custom:customWriter',
    ]);
  });
});
