import { afterEach, describe, expect, it, vi } from 'vitest';

const agentIndexMock = vi.hoisted(() => ({
  computeAgentOptionsData: vi.fn(),
  getAgent: vi.fn(),
  getAgentsByCategory: vi.fn(),
  getVisibleAgents: vi.fn(),
  loadAgents: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('@agent/index', () => agentIndexMock);

import {
  computeRuntimeAgentOptionsData,
  getRuntimeAgent,
  getRuntimeAgentByIdentifier,
  getRuntimeToolUseAgentCategory,
  listRuntimeAgentsByCategory,
  listRuntimeVisibleAgents,
  loadRuntimeAgents,
  refreshRuntimeAgentCatalog,
  runtimeToolUseAgentHasAnyTool,
} from '@agent/runtime/agentResolution';
import { AgentCategory } from '@shared/schemas/agent';

describe('runtime agent resolution', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('resolves tool-use agents through the runtime boundary', () => {
    const entry = {
      category: AgentCategory.ToolUse,
      tools: ['delegate_agent'],
    };
    agentIndexMock.getAgent.mockReturnValue(entry);

    expect(getRuntimeAgent('proof')).toBe(entry);
    expect(getRuntimeAgentByIdentifier('remote:proof')).toBe(entry);
    expect(getRuntimeToolUseAgentCategory('proof')).toBe(AgentCategory.ToolUse);
    expect(
      runtimeToolUseAgentHasAnyTool('proof', new Set(['delegate_agent'])),
    ).toBe(true);
    expect(agentIndexMock.getAgent).toHaveBeenNthCalledWith(1, 'proof');
    expect(agentIndexMock.getAgent).toHaveBeenCalledWith(
      'proof',
      AgentCategory.ToolUse,
    );
    expect(agentIndexMock.getAgent).toHaveBeenCalledWith('remote:proof');
  });

  it('loads and projects the runtime agent catalog', async () => {
    const options = {
      workflow: [{ value: 'builtIn:workflow', label: 'workflow' }],
      toolUse: [{ value: 'builtInToolUse:proof', label: 'proof' }],
    };
    agentIndexMock.loadAgents.mockResolvedValue(undefined);
    agentIndexMock.computeAgentOptionsData.mockResolvedValue(options);

    await expect(loadRuntimeAgents()).resolves.toBeUndefined();
    await expect(computeRuntimeAgentOptionsData()).resolves.toBe(options);

    expect(agentIndexMock.loadAgents).toHaveBeenCalledOnce();
    expect(agentIndexMock.computeAgentOptionsData).toHaveBeenCalledOnce();
  });

  it('loads local catalogues and lists runtime agents by category', async () => {
    const visible = [{ name: 'proof', category: AgentCategory.ToolUse }];
    const all = [
      { name: 'proof', category: AgentCategory.ToolUse },
      { name: 'hidden', category: AgentCategory.ToolUse, internal: true },
    ];
    agentIndexMock.loadAgents.mockResolvedValue(undefined);
    agentIndexMock.getVisibleAgents.mockReturnValue(visible);
    agentIndexMock.getAgentsByCategory.mockReturnValue(all);

    await expect(
      loadRuntimeAgents({ includeRemote: false }),
    ).resolves.toBeUndefined();
    expect(listRuntimeVisibleAgents(AgentCategory.ToolUse)).toBe(visible);
    expect(listRuntimeAgentsByCategory(AgentCategory.ToolUse)).toBe(all);

    expect(agentIndexMock.loadAgents).toHaveBeenCalledWith({
      includeRemote: false,
    });
    expect(agentIndexMock.getVisibleAgents).toHaveBeenCalledWith(
      AgentCategory.ToolUse,
    );
    expect(agentIndexMock.getAgentsByCategory).toHaveBeenCalledWith(
      AgentCategory.ToolUse,
    );
  });

  it('refreshes the runtime agent catalog', async () => {
    agentIndexMock.refresh.mockResolvedValue(undefined);

    await expect(refreshRuntimeAgentCatalog()).resolves.toBeUndefined();

    expect(agentIndexMock.refresh).toHaveBeenCalledOnce();
  });
});
