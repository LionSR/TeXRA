import { describe, expect, it } from 'vitest';

import {
  SettingsAgentVisibilityController,
  type SettingsAgentVisibilityEntry,
} from '@controllers/settingsView/SettingsAgentVisibilityController';
import type { AgentCategory } from '@shared/schemas/agent';

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

type AgentToggle = Parameters<
  SettingsAgentVisibilityController['setAgentEnabled']
>[0];

function createController(options?: {
  enabled?: Partial<Record<AgentCategory, string[] | undefined>>;
}): {
  controller: SettingsAgentVisibilityController;
  enabled: Partial<Record<AgentCategory, string[] | undefined>>;
  writes: string[][];
  toggles: AgentToggle[];
} {
  const enabled = { ...options?.enabled };
  const writes: string[][] = [];
  const toggles: AgentToggle[] = [];
  return {
    controller: new SettingsAgentVisibilityController({
      state: {
        getEnabledAgentKeys: (category) => enabled[category],
        setAgentEnabled: async (input) => {
          toggles.push(input);
        },
        setEnabledAgentKeys: async (category, enabledKeys) => {
          writes.push(enabledKeys);
          enabled[category] = enabledKeys;
        },
        getAgents: (category) => AGENTS[category],
      },
    }),
    enabled,
    writes,
    toggles,
  };
}

describe('SettingsAgentVisibilityController', () => {
  it('delegates individual toggles to the canonical roster state', async () => {
    const { controller, toggles } = createController();

    const input = {
      category: 'workflow',
      source: 'builtInWorkflow',
      name: 'criticize',
      enabled: false,
    } as const;
    await controller.setAgentEnabled(input);

    expect(toggles).toEqual([input]);
  });

  it('disables every agent from a source while preserving other sources', async () => {
    const { controller, enabled } = createController({
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
      source: 'remote',
      enabled: false,
    });

    expect(enabled.workflow).toEqual([
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

    expect(enabled.workflow).toEqual([
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
