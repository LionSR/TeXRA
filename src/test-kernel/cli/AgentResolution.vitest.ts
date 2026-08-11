import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEntry, ResolvedAgent } from '@agent/index';
import { SupabaseClient } from '@auth/SupabaseClient';
import { AgentCategory } from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  getAgent: vi.fn(),
  getAgentsByCategory: vi.fn(),
  getVisibleAgents: vi.fn(),
  loadAgents: vi.fn(),
  resolveAgentForLaunch: vi.fn(),
}));

vi.mock('@agent/index', () => ({
  getAgent: mocks.getAgent,
  getAgentsByCategory: mocks.getAgentsByCategory,
  getVisibleAgents: mocks.getVisibleAgents,
  loadAgents: mocks.loadAgents,
  resolveAgentForLaunch: mocks.resolveAgentForLaunch,
}));

const isAuthenticatedSpy = vi.spyOn(SupabaseClient, 'isAuthenticated');
const canAccessRemoteAgentCatalogSpy = vi.spyOn(
  SupabaseClient,
  'canAccessRemoteAgentCatalog',
);

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

function resolution(entry: AgentEntry): ResolvedAgent {
  return { entry };
}

describe('CLI agent resolution', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    isAuthenticatedSpy.mockReset().mockResolvedValue(false);
    canAccessRemoteAgentCatalogSpy.mockReset().mockResolvedValue(false);
  });

  it('loads the local registry and returns a local agent for signed-out users', async () => {
    const local = agent('lean');
    mocks.getAgent.mockReturnValue(local);
    const { resolveCliAgent } = await import('@cli/runtime/agents');

    await expect(resolveCliAgent('lean')).resolves.toBe(local);

    expect(mocks.loadAgents).toHaveBeenCalledOnce();
    expect(mocks.loadAgents).toHaveBeenCalledWith({ includeRemote: false });
    expect(canAccessRemoteAgentCatalogSpy).toHaveBeenCalledOnce();
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
    expect(canAccessRemoteAgentCatalogSpy).not.toHaveBeenCalled();
  });

  it('does not treat relay-only model access as remote-catalog access', async () => {
    const local = agent('lean');
    isAuthenticatedSpy.mockResolvedValue(true);
    canAccessRemoteAgentCatalogSpy.mockResolvedValue(false);
    mocks.getAgent.mockReturnValue(local);
    const { resolveCliAgent } = await import('@cli/runtime/agents');

    await expect(resolveCliAgent('lean')).resolves.toBe(local);

    expect(mocks.loadAgents).toHaveBeenCalledOnce();
    expect(mocks.loadAgents).toHaveBeenCalledWith({
      includeRemote: false,
    });
    expect(isAuthenticatedSpy).not.toHaveBeenCalled();
  });

  it('uses launch target category for authenticated remote-priority reloads', async () => {
    const local = agent('lean');
    const remote = agent('lean', 'remote');
    canAccessRemoteAgentCatalogSpy.mockResolvedValue(true);
    mocks.resolveAgentForLaunch
      .mockReturnValueOnce(resolution(local))
      .mockReturnValueOnce(resolution(remote));
    const { resolveCliLaunchAgent } = await import('@cli/runtime/agents');

    await expect(resolveCliLaunchAgent('lean', 'chat')).resolves.toBe(remote);

    expect(mocks.resolveAgentForLaunch).toHaveBeenNthCalledWith(
      1,
      AgentCategory.ToolUse,
      'lean',
      undefined,
    );
    expect(mocks.resolveAgentForLaunch).toHaveBeenNthCalledWith(
      2,
      AgentCategory.ToolUse,
      'lean',
      undefined,
    );
    expect(mocks.loadAgents).toHaveBeenNthCalledWith(1, {
      includeRemote: false,
    });
    expect(mocks.loadAgents).toHaveBeenNthCalledWith(2);
  });

  it('does not apply remote priority to source-qualified agent names', async () => {
    const local = agent('local:lean');
    canAccessRemoteAgentCatalogSpy.mockResolvedValue(true);
    mocks.getAgent.mockReturnValue(local);
    const { resolveCliAgent } = await import('@cli/runtime/agents');

    await expect(resolveCliAgent('local:lean')).resolves.toBe(local);

    expect(mocks.loadAgents).toHaveBeenCalledOnce();
    expect(mocks.loadAgents).toHaveBeenCalledWith({ includeRemote: false });
    expect(canAccessRemoteAgentCatalogSpy).not.toHaveBeenCalled();
  });

  it('uses launch target category for local and remote-fallback lookups', async () => {
    const remote = agent('assistant', 'remote');
    mocks.resolveAgentForLaunch
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(resolution(remote));
    const { resolveCliLaunchAgent } = await import('@cli/runtime/agents');

    await expect(resolveCliLaunchAgent('assistant', 'agentsRun')).resolves.toBe(
      remote,
    );

    expect(mocks.resolveAgentForLaunch).toHaveBeenNthCalledWith(
      1,
      AgentCategory.ToolUse,
      'assistant',
      undefined,
    );
    expect(mocks.resolveAgentForLaunch).toHaveBeenNthCalledWith(
      2,
      AgentCategory.ToolUse,
      'assistant',
      undefined,
    );
  });

  it('pins a source-qualified launch identifier to that exact source', async () => {
    const shadowed = agent('review', 'builtInToolUse');
    mocks.resolveAgentForLaunch.mockReturnValue(resolution(shadowed));
    const { resolveCliLaunchAgent } = await import('@cli/runtime/agents');

    await expect(
      resolveCliLaunchAgent('builtInToolUse:review', 'chat'),
    ).resolves.toBe(shadowed);

    expect(mocks.resolveAgentForLaunch).toHaveBeenCalledWith(
      AgentCategory.ToolUse,
      'builtInToolUse:review',
      'builtInToolUse',
    );
    expect(canAccessRemoteAgentCatalogSpy).not.toHaveBeenCalled();
  });

  it('reports launch-specific missing-agent messages', async () => {
    mocks.resolveAgentForLaunch.mockReturnValue(undefined);
    const { resolveCliLaunchAgent } = await import('@cli/runtime/agents');

    await expect(resolveCliLaunchAgent('missing', 'agentsRun')).rejects.toThrow(
      'Tool-use agent not found: missing. Use `texra agents list` for visible starter agents, `texra agents list --all` for every agent, or pass a known launchable agent name from a team preset.',
    );
  });

  it('probes the other category to report a launch-mode mismatch', async () => {
    const workflow = agent('polish', 'builtInWorkflow', AgentCategory.Workflow);
    mocks.resolveAgentForLaunch.mockImplementation((category: AgentCategory) =>
      category === AgentCategory.Workflow ? resolution(workflow) : undefined,
    );
    const { resolveCliLaunchAgent } = await import('@cli/runtime/agents');

    await expect(resolveCliLaunchAgent('polish', 'chat')).rejects.toThrow(
      'Agent "polish" is a workflow agent; `texra chat` only handles tool-use agents.',
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
