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
  it('delegates individual toggles to the canonical roster state', async () => {
    let received:
      | Parameters<SettingsAgentVisibilityController['setAgentEnabled']>[0]
      | undefined;
    const controller = new SettingsAgentVisibilityController({
      state: {
        getEnabledAgentKeys: () => undefined,
        setAgentEnabled: async (input) => {
          received = input;
        },
        setEnabledAgentKeys: async () => undefined,
        getAgents: () => [],
      },
    });

    const input = {
      category: 'workflow',
      source: 'builtInWorkflow',
      name: 'criticize',
      enabled: false,
    } as const;
    await controller.setAgentEnabled(input);

    expect(received).toEqual(input);
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
  writes: string[][];
} {
  const enabled = { ...(options?.enabled ?? {}) };
  const writes: string[][] = [];
  return {
    controller: new SettingsAgentVisibilityController({
      state: {
        getEnabledAgentKeys: (category) => enabled[category],
        setAgentEnabled: async () => undefined,
        setEnabledAgentKeys: async (category, enabledKeys) => {
          writes.push(enabledKeys);
          enabled[category] = enabledKeys;
        },
        getAgents: (category) => AGENTS[category],
      },
    }),
    enabled,
    writes,
  };
}

describe('SettingsAgentVisibilityController', () => {
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

  it('does not replace a symbolic selection for a no-op source toggle', async () => {
    const { controller, writes } = createController({
      enabled: {
        workflow: [
          'builtInWorkflow:correct',
          'custom:customWriter',
          'remote:remoteWriter',
        ],
      },
    });

    await controller.setAllAgentsEnabled({
      category: 'workflow',
      source: 'custom',
      enabled: true,
    });

    expect(writes).toEqual([]);
  });
});
