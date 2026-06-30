import { describe, expect, it, vi } from 'vitest';

import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';

// Stub the registry so the writer guard is hermetic: `research` is a real
// tool-use agent; `bash` (a process-tracking name) is not. `ready` flips the
// loaded state so we can assert the "registry not loaded" escape hatch.
const state = { ready: true };
vi.mock('@agent/index/agentRegistry', () => ({
  isAgentRegistryReady: vi.fn(() => state.ready),
  getAgent: vi.fn((name: string, lookupCategory?: AgentCategory) =>
    name === 'research' && lookupCategory === AgentCategory.ToolUse
      ? { name, category: AgentCategory.ToolUse }
      : undefined,
  ),
}));

const { normalizeWriterCategory } =
  await import('@agent/storage/executionLifecycle');

function config(agent: string, agentCategory: AgentCategory): AgentConfig {
  return { agent, agentCategory } as AgentConfig;
}

describe('normalizeWriterCategory', () => {
  it('demotes a ToolUse config whose agent is not a registered tool-use agent', () => {
    state.ready = true;
    const result = normalizeWriterCategory(
      config('bash', AgentCategory.ToolUse),
      'bash',
    );
    expect(result.agentCategory).toBe(AgentCategory.Workflow);
  });

  it.each([
    {
      name: 'leaves a real tool-use agent untouched',
      ready: true,
      agent: 'research',
      category: AgentCategory.ToolUse,
    },
    {
      name: 'leaves Workflow configs untouched',
      ready: true,
      agent: 'bash',
      category: AgentCategory.Workflow,
    },
    {
      name: 'does not demote when the registry is not loaded',
      ready: false,
      agent: 'bash',
      category: AgentCategory.ToolUse,
    },
  ])('$name', ({ ready, agent, category }) => {
    state.ready = ready;
    const input = config(agent, category);
    expect(normalizeWriterCategory(input, agent)).toBe(input);
  });
});
