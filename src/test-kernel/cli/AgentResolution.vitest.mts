import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeAgentEntry } from '@agent/runtime/agentResolution';
import { AgentCategory } from '@shared/schemas/agent';

const mocks = vi.hoisted(() => ({
  authProvider: {
    isAuthenticated: vi.fn(),
  },
  getRuntimeAgent: vi.fn(),
  getRuntimeToolUseAgent: vi.fn(),
  getRuntimeWorkflowAgent: vi.fn(),
  listRuntimeAgents: vi.fn(),
  loadRuntimeAgents: vi.fn(),
}));

vi.mock('@agent/runtime/agentResolution', () => ({
  getRuntimeAgent: mocks.getRuntimeAgent,
  getRuntimeToolUseAgent: mocks.getRuntimeToolUseAgent,
  getRuntimeWorkflowAgent: mocks.getRuntimeWorkflowAgent,
  listRuntimeAgents: mocks.listRuntimeAgents,
  loadRuntimeAgents: mocks.loadRuntimeAgents,
}));

vi.mock('@cli/runtime/supabaseAuth', () => ({
  getCliAuthProvider: () => mocks.authProvider,
}));

function agent(
  name: string,
  source: RuntimeAgentEntry['source'] = 'builtInToolUse',
  category: RuntimeAgentEntry['category'] = AgentCategory.ToolUse,
): RuntimeAgentEntry {
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
    mocks.getRuntimeAgent.mockReset();
    mocks.getRuntimeToolUseAgent.mockReset();
    mocks.getRuntimeWorkflowAgent.mockReset();
    mocks.listRuntimeAgents.mockReset();
    mocks.loadRuntimeAgents.mockReset();
  });

  it('loads the local registry and returns a local agent for signed-out users', async () => {
    const local = agent('lean');
    mocks.getRuntimeAgent.mockReturnValue(local);
    const { resolveCliAgent } = await import('@cli/runtime/agents');

    await expect(resolveCliAgent('lean')).resolves.toBe(local);

    expect(mocks.loadRuntimeAgents).toHaveBeenCalledOnce();
    expect(mocks.loadRuntimeAgents).toHaveBeenCalledWith({
      includeRemote: false,
    });
    expect(mocks.authProvider.isAuthenticated).toHaveBeenCalledOnce();
  });

  it('does a full registry load when the local registry misses', async () => {
    const remote = agent('orchestrator', 'remote');
    mocks.getRuntimeAgent
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(remote);
    const { resolveCliAgent } = await import('@cli/runtime/agents');

    await expect(resolveCliAgent('orchestrator')).resolves.toBe(remote);

    expect(mocks.loadRuntimeAgents).toHaveBeenNthCalledWith(1, {
      includeRemote: false,
    });
    expect(mocks.loadRuntimeAgents).toHaveBeenNthCalledWith(2);
    expect(mocks.authProvider.isAuthenticated).not.toHaveBeenCalled();
  });

  it('lets authenticated relay users prefer remote definitions over local built-ins', async () => {
    const local = agent('lean');
    const remote = agent('lean', 'remote');
    mocks.authProvider.isAuthenticated.mockResolvedValue(true);
    mocks.getRuntimeAgent
      .mockReturnValueOnce(local)
      .mockReturnValueOnce(remote);
    const { resolveCliAgent } = await import('@cli/runtime/agents');

    await expect(resolveCliAgent('lean')).resolves.toBe(remote);

    expect(mocks.loadRuntimeAgents).toHaveBeenNthCalledWith(1, {
      includeRemote: false,
    });
    expect(mocks.loadRuntimeAgents).toHaveBeenNthCalledWith(2);
    expect(mocks.authProvider.isAuthenticated).toHaveBeenCalledOnce();
  });

  it('uses launch target category for authenticated remote-priority reloads', async () => {
    const local = agent('lean');
    const remote = agent('lean', 'remote');
    mocks.authProvider.isAuthenticated.mockResolvedValue(true);
    mocks.getRuntimeToolUseAgent
      .mockReturnValueOnce(local)
      .mockReturnValueOnce(remote);
    const { resolveCliLaunchAgent } = await import('@cli/runtime/agents');

    await expect(resolveCliLaunchAgent('lean', 'chat')).resolves.toBe(remote);

    expect(mocks.getRuntimeToolUseAgent).toHaveBeenNthCalledWith(1, 'lean');
    expect(mocks.getRuntimeToolUseAgent).toHaveBeenNthCalledWith(2, 'lean');
    expect(mocks.getRuntimeAgent).not.toHaveBeenCalled();
    expect(mocks.loadRuntimeAgents).toHaveBeenNthCalledWith(1, {
      includeRemote: false,
    });
    expect(mocks.loadRuntimeAgents).toHaveBeenNthCalledWith(2);
  });

  it('does not apply remote priority to source-qualified agent names', async () => {
    const local = agent('local:lean');
    mocks.authProvider.isAuthenticated.mockResolvedValue(true);
    mocks.getRuntimeAgent.mockReturnValue(local);
    const { resolveCliAgent } = await import('@cli/runtime/agents');

    await expect(resolveCliAgent('local:lean')).resolves.toBe(local);

    expect(mocks.loadRuntimeAgents).toHaveBeenCalledOnce();
    expect(mocks.loadRuntimeAgents).toHaveBeenCalledWith({
      includeRemote: false,
    });
    expect(mocks.authProvider.isAuthenticated).not.toHaveBeenCalled();
  });

  it('uses launch target category for local and remote-fallback lookups', async () => {
    const remote = agent('assistant', 'remote');
    mocks.getRuntimeToolUseAgent
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(remote);
    const { resolveCliLaunchAgent } = await import('@cli/runtime/agents');

    await expect(resolveCliLaunchAgent('assistant', 'agentsRun')).resolves.toBe(
      remote,
    );

    expect(mocks.getRuntimeToolUseAgent).toHaveBeenNthCalledWith(
      1,
      'assistant',
    );
    expect(mocks.getRuntimeToolUseAgent).toHaveBeenNthCalledWith(
      2,
      'assistant',
    );
    expect(mocks.getRuntimeAgent).not.toHaveBeenCalled();
  });

  it('uses the workflow lookup for workflow launch mode', async () => {
    const workflow = agent(
      'proofreader',
      'builtInWorkflow',
      AgentCategory.Workflow,
    );
    mocks.getRuntimeWorkflowAgent.mockReturnValue(workflow);
    const { resolveCliLaunchAgent } = await import('@cli/runtime/agents');

    await expect(resolveCliLaunchAgent('proofreader', 'run')).resolves.toBe(
      workflow,
    );

    expect(mocks.getRuntimeWorkflowAgent).toHaveBeenCalledWith('proofreader');
    expect(mocks.getRuntimeToolUseAgent).not.toHaveBeenCalled();
    expect(mocks.getRuntimeAgent).not.toHaveBeenCalled();
  });

  it('reports launch-specific missing-agent messages', async () => {
    mocks.getRuntimeToolUseAgent.mockReturnValue(undefined);
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
