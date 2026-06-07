import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEntry } from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';

const mocks = vi.hoisted(() => ({
  authProvider: {
    isAuthenticated: vi.fn(),
  },
  getAgent: vi.fn(),
  loadAgents: vi.fn(),
}));

vi.mock('@agent/index', () => ({
  getAgent: mocks.getAgent,
  loadAgents: mocks.loadAgents,
}));

vi.mock('@cli/runtime/supabaseAuth', () => ({
  getCliAuthProvider: () => mocks.authProvider,
}));

function agent(
  name: string,
  source: AgentEntry['source'] = 'builtInToolUse',
): AgentEntry {
  return {
    name,
    source,
    path: `/agents/${name}.yaml`,
    category: AgentCategory.ToolUse,
  };
}

describe('CLI agent resolution', () => {
  beforeEach(() => {
    mocks.authProvider.isAuthenticated.mockReset();
    mocks.authProvider.isAuthenticated.mockResolvedValue(false);
    mocks.getAgent.mockReset();
    mocks.loadAgents.mockReset();
  });

  it('loads the local registry and returns a local agent for signed-out users', async () => {
    const local = agent('lean');
    mocks.getAgent.mockReturnValue(local);
    const { resolveCliAgent } = await import('@cli/runtime/agentResolution');

    await expect(resolveCliAgent('lean')).resolves.toBe(local);

    expect(mocks.loadAgents).toHaveBeenCalledOnce();
    expect(mocks.loadAgents).toHaveBeenCalledWith({ includeRemote: false });
    expect(mocks.authProvider.isAuthenticated).toHaveBeenCalledOnce();
  });

  it('does a full registry load when the local registry misses', async () => {
    const remote = agent('orchestrator', 'remote');
    mocks.getAgent.mockReturnValueOnce(undefined).mockReturnValueOnce(remote);
    const { resolveCliAgent } = await import('@cli/runtime/agentResolution');

    await expect(resolveCliAgent('orchestrator')).resolves.toBe(remote);

    expect(mocks.loadAgents).toHaveBeenNthCalledWith(1, {
      includeRemote: false,
    });
    expect(mocks.loadAgents).toHaveBeenNthCalledWith(2);
    expect(mocks.authProvider.isAuthenticated).not.toHaveBeenCalled();
  });

  it('lets authenticated relay users prefer remote definitions over local built-ins', async () => {
    const local = agent('lean');
    const remote = agent('lean', 'remote');
    mocks.authProvider.isAuthenticated.mockResolvedValue(true);
    mocks.getAgent.mockReturnValueOnce(local).mockReturnValueOnce(remote);
    const { resolveCliAgent } = await import('@cli/runtime/agentResolution');

    await expect(resolveCliAgent('lean')).resolves.toBe(remote);

    expect(mocks.loadAgents).toHaveBeenNthCalledWith(1, {
      includeRemote: false,
    });
    expect(mocks.loadAgents).toHaveBeenNthCalledWith(2);
    expect(mocks.authProvider.isAuthenticated).toHaveBeenCalledOnce();
  });

  it('does not apply remote priority to source-qualified agent names', async () => {
    const local = agent('local:lean');
    mocks.authProvider.isAuthenticated.mockResolvedValue(true);
    mocks.getAgent.mockReturnValue(local);
    const { resolveCliAgent } = await import('@cli/runtime/agentResolution');

    await expect(resolveCliAgent('local:lean')).resolves.toBe(local);

    expect(mocks.loadAgents).toHaveBeenCalledOnce();
    expect(mocks.loadAgents).toHaveBeenCalledWith({ includeRemote: false });
    expect(mocks.authProvider.isAuthenticated).not.toHaveBeenCalled();
  });
});
