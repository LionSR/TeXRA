import { describe, expect, it } from 'vitest';

import { createSettingsAgentControllers } from '@controllers/settingsView/SettingsAgentControllerFactory';
import type { AgentCategory } from '@shared/schemas/agent';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import type { StateStore } from '@platform/interfaces';

function memoryStore(): StateStore & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    get: <T>(key: string, fallback?: T): T =>
      (values.has(key) ? values.get(key) : fallback) as T,
    update: async (key, value) => {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
    },
  };
}

const agents = {
  workflow: [
    {
      category: 'workflow',
      source: 'builtInWorkflow',
      name: 'write',
      path: '/agents/write.yaml',
    },
  ],
  toolUse: [
    {
      category: 'toolUse',
      source: 'builtInToolUse',
      name: 'assistant',
      path: '/agents/assistant.yaml',
    },
  ],
} as const;

describe('createSettingsAgentControllers', () => {
  it('writes visibility changes through the canonical roster controller', async () => {
    const workspaceState = memoryStore();
    const controllers = createSettingsAgentControllers({
      workspaceState,
      globalState: memoryStore(),
      getCustomAgentDirectory: async () => '/agents/custom',
      getSourceDirectory: async () => undefined,
      getAgents: (category: AgentCategory) => [...agents[category]],
      getVisibleAgents: (category: AgentCategory) => [...agents[category]],
    });

    await controllers.state.setEnabledAgentKeys('toolUse', [
      'builtInToolUse:assistant',
    ]);

    expect(
      workspaceState.values.get(WorkspaceStateKey.AGENT_ROSTER_SELECTION),
    ).toEqual({
      kind: 'custom',
      workflowAgentKeys: 'all',
      toolUseAgentKeys: ['builtInToolUse:assistant'],
    });
  });
});
