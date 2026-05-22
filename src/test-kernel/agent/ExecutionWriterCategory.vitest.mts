import { describe, expect, it, vi } from 'vitest';

import { AgentCategory } from '@agent/core/AgentDataclass';
import type { AgentConfig } from '@agent/core/AgentConfig';

// Stub the registry so the writer guard is hermetic: `research` is a real
// tool-use agent; `bash` (a process-tracking name) is not. `ready` flips the
// loaded state so we can assert the "registry not loaded" escape hatch.
const state = { ready: true };
vi.mock('@agent/index/agentRegistry', () => ({
  isAgentRegistryReady: vi.fn(() => state.ready),
  getAgent: vi.fn((name: string) =>
    name === 'research' ? { name, category: AgentCategory.ToolUse } : undefined,
  ),
}));

const { normalizeWriterCategory } =
  await import('../../agent/storage/executionLifecycle');

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

  it('leaves a real tool-use agent untouched', () => {
    state.ready = true;
    const input = config('research', AgentCategory.ToolUse);
    expect(normalizeWriterCategory(input, 'research')).toBe(input);
  });

  it('leaves Workflow configs untouched', () => {
    state.ready = true;
    const input = config('bash', AgentCategory.Workflow);
    expect(normalizeWriterCategory(input, 'bash')).toBe(input);
  });

  it('does not demote when the registry is not loaded', () => {
    state.ready = false;
    const input = config('bash', AgentCategory.ToolUse);
    expect(normalizeWriterCategory(input, 'bash')).toBe(input);
  });
});
