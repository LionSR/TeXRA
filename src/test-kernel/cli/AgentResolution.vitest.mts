import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEntry } from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';

const mocks = vi.hoisted(() => ({
  authProvider: {
    isAuthenticated: vi.fn(),
    canAccessRemoteAgentCatalog: vi.fn(),
  },
  getAgent: vi.fn(),
  getAgentsByCategory: vi.fn(),
  getVisibleAgents: vi.fn(),
  loadAgents: vi.fn(),
}));

vi.mock('@agent/index', () => ({
  getAgent: mocks.getAgent,
  getAgentsByCategory: mocks.getAgentsByCategory,
  getVisibleAgents: mocks.getVisibleAgents,
  loadAgents: mocks.loadAgents,
}));

vi.mock('@cli/runtime/supabaseAuth', () => ({
  getCliAuthProvider: () => mocks.authProvider,
}));

function agent(
  name: string,
  source: AgentEntry['source'] = 'builtInToolUse',
  category: AgentEntry['category'] = AgentCategory.ToolUse,
): AgentEntry {
  return {
    name,
    source,
    path: `/agents/${name}.yaml`,
    category,
  };
}

describe('CLI agent resolution', () => {
  beforeEach(() => {
    mocks.authProvider.isAuthenticated.mockReset();
    mocks.authProvider.isAuthenticated.mockResolvedValue(false);
    mocks.authProvider.canAccessRemoteAgentCatalog.mockReset();
    mocks.authProvider.canAccessRemoteAgentCatalog.mockResolvedValue(false);
    mocks.getAgent.mockReset();
    mocks.getAgentsByCategory.mockReset();
    mocks.getVisibleAgents.mockReset();
    mocks.loadAgents.mockReset();
  });

  it('loads the local registry and returns a local agent for signed-out users', async () => {
    const local = agent('lean');
    mocks.getAgent.mockReturnValue(local);
    const { resolveCliAgent } = await import('@cli/runtime/agents');

    await expect(resolveCliAgent('lean')).resolves.toBe(local);

    expect(mocks.loadAgents).toHaveBeenCalledOnce();
    expect(mocks.loadAgents).toHaveBeenCalledWith({ includeRemote: false });
    expect(
      mocks.authProvider.canAccessRemoteAgentCatalog,
    ).toHaveBeenCalledOnce();
  });

  it('does a full registry load when the local registry misses', async () => {
    const remote = agent('orchestrator', 'remote');
    mocks.getAgent.mockReturnValueOnce(undefined).mockReturnValueOnce(remote);
    const { resolveCliAgent } = await import('@cli/runtime/agents');

    await expect(resolveCliAgent('orchestrator')).resolves.toBe(remote);

    expect(mocks.loadAgents).toHaveBeenNthCalledWith(1, {
      includeRemote: false,
    });
    expect(mocks.loadAgents).toHaveBeenNthCalledWith(2);
    expect(
      mocks.authProvider.canAccessRemoteAgentCatalog,
    ).not.toHaveBeenCalled();
  });

  it('does not treat relay-only model access as remote-catalog access', async () => {
    const local = agent('lean');
    mocks.authProvider.isAuthenticated.mockResolvedValue(true);
    mocks.authProvider.canAccessRemoteAgentCatalog.mockResolvedValue(false);
    mocks.getAgent.mockReturnValue(local);
    const { resolveCliAgent } = await import('@cli/runtime/agents');

    await expect(resolveCliAgent('lean')).resolves.toBe(local);

    expect(mocks.loadAgents).toHaveBeenCalledOnce();
    expect(mocks.loadAgents).toHaveBeenCalledWith({
      includeRemote: false,
    });
    expect(mocks.authProvider.isAuthenticated).not.toHaveBeenCalled();
  });

  it('uses launch target category for authenticated remote-priority reloads', async () => {
    const local = agent('lean');
    const remote = agent('lean', 'remote');
    mocks.authProvider.canAccessRemoteAgentCatalog.mockResolvedValue(true);
    mocks.getAgent.mockReturnValueOnce(local).mockReturnValueOnce(remote);
    const { resolveCliLaunchAgent } = await import('@cli/runtime/agents');

    await expect(resolveCliLaunchAgent('lean', 'chat')).resolves.toBe(remote);

    expect(mocks.getAgent).toHaveBeenNthCalledWith(
      1,
      'lean',
      AgentCategory.ToolUse,
    );
    expect(mocks.getAgent).toHaveBeenNthCalledWith(
      2,
      'lean',
      AgentCategory.ToolUse,
    );
    expect(mocks.loadAgents).toHaveBeenNthCalledWith(1, {
      includeRemote: false,
    });
    expect(mocks.loadAgents).toHaveBeenNthCalledWith(2);
  });

  it('does not apply remote priority to source-qualified agent names', async () => {
    const local = agent('local:lean');
    mocks.authProvider.canAccessRemoteAgentCatalog.mockResolvedValue(true);
    mocks.getAgent.mockReturnValue(local);
    const { resolveCliAgent } = await import('@cli/runtime/agents');

    await expect(resolveCliAgent('local:lean')).resolves.toBe(local);

    expect(mocks.loadAgents).toHaveBeenCalledOnce();
    expect(mocks.loadAgents).toHaveBeenCalledWith({ includeRemote: false });
    expect(
      mocks.authProvider.canAccessRemoteAgentCatalog,
    ).not.toHaveBeenCalled();
  });

  it('uses launch target category for local and remote-fallback lookups', async () => {
    const remote = agent('assistant', 'remote');
    mocks.getAgent.mockReturnValueOnce(undefined).mockReturnValueOnce(remote);
    const { resolveCliLaunchAgent } = await import('@cli/runtime/agents');

    await expect(resolveCliLaunchAgent('assistant', 'agentsRun')).resolves.toBe(
      remote,
    );

    expect(mocks.getAgent).toHaveBeenNthCalledWith(
      1,
      'assistant',
      AgentCategory.ToolUse,
    );
    expect(mocks.getAgent).toHaveBeenNthCalledWith(
      2,
      'assistant',
      AgentCategory.ToolUse,
    );
  });

  it('reports launch-specific missing-agent messages', async () => {
    mocks.getAgent.mockReturnValue(undefined);
    const { resolveCliLaunchAgent } = await import('@cli/runtime/agents');

    await expect(resolveCliLaunchAgent('missing', 'agentsRun')).rejects.toThrow(
      'Tool-use agent not found: missing. Use `texra agents list` for visible starter agents, `texra agents list --all` for the full catalog, or pass a known launchable agent name from a team preset.',
    );
  });

  it('validates launch mode category at the launch boundary', async () => {
    const workflow = agent(
      'correct',
      'builtInWorkflow',
      AgentCategory.Workflow,
    );
    const { assertCliAgentLaunch } = await import('@cli/runtime/agents');

    expect(() => assertCliAgentLaunch('correct', workflow, 'chat')).toThrow(
      'Agent "correct" is a workflow agent; `texra chat` only handles tool-use agents.',
    );
  });
});
