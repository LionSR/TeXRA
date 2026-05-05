import { describe, expect, it } from 'vitest';

import { SettingsAgentVisibilityController } from '@controllers/settingsView/SettingsAgentVisibilityController';
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
