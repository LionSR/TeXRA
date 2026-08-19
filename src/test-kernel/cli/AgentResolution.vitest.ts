/* eslint-disable import/order -- Vitest mocks must be declared before importing the runtime under test. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { agentCatalogMock } from '@test/support/agentCatalogMock';
import type { AgentEntry } from '@agent/index';
import type { ResolvedAgent } from '@agent/index/agentEntry';
import { SupabaseClient } from '@auth/SupabaseClient';
import {
  assertCliAgentLaunch,
  resolveCliAgent,
  resolveCliLaunchAgent,
} from '@cli/runtime/agents';
import { AgentCategory } from '@shared/schemas';

const isAuthenticatedSpy = vi.spyOn(SupabaseClient, 'isAuthenticated');

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
    for (const mock of Object.values(agentCatalogMock)) mock.mockReset();
    isAuthenticatedSpy.mockReset().mockResolvedValue(false);
  });

  it('loads the local registry and returns a local agent for signed-out users', async () => {
    const local = agent('lean');
    agentCatalogMock.getAgent.mockReturnValue(local);

    await expect(resolveCliAgent('lean')).resolves.toBe(local);

    expect(agentCatalogMock.loadAgents).toHaveBeenCalledOnce();
    expect(agentCatalogMock.loadAgents).toHaveBeenCalledWith({
      includeRemote: false,
    });
    expect(isAuthenticatedSpy).toHaveBeenCalledOnce();
  });

  it('does a full registry load when the local registry misses', async () => {
    const remote = agent('orchestrator', 'remote');
    agentCatalogMock.getAgent
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(remote);

    await expect(resolveCliAgent('orchestrator')).resolves.toBe(remote);

    expect(agentCatalogMock.loadAgents).toHaveBeenNthCalledWith(1, {
      includeRemote: false,
    });
    expect(agentCatalogMock.loadAgents).toHaveBeenNthCalledWith(2);
    expect(isAuthenticatedSpy).not.toHaveBeenCalled();
  });

  it('uses launch target category for authenticated remote-priority reloads', async () => {
    const local = agent('lean');
    const remote = agent('lean', 'remote');
    isAuthenticatedSpy.mockResolvedValue(true);
    agentCatalogMock.resolveAgentForLaunch
      .mockReturnValueOnce(resolution(local))
      .mockReturnValueOnce(resolution(remote));

    await expect(resolveCliLaunchAgent('lean', 'chat')).resolves.toBe(remote);

    expect(agentCatalogMock.resolveAgentForLaunch).toHaveBeenNthCalledWith(
      1,
      AgentCategory.ToolUse,
      'lean',
      undefined,
    );
    expect(agentCatalogMock.resolveAgentForLaunch).toHaveBeenNthCalledWith(
      2,
      AgentCategory.ToolUse,
      'lean',
      undefined,
    );
    expect(agentCatalogMock.loadAgents).toHaveBeenNthCalledWith(1, {
      includeRemote: false,
    });
    expect(agentCatalogMock.loadAgents).toHaveBeenNthCalledWith(2);
  });

  it('does not apply remote priority to source-qualified agent names', async () => {
    const local = agent('local:lean');
    isAuthenticatedSpy.mockResolvedValue(true);
    agentCatalogMock.getAgent.mockReturnValue(local);

    await expect(resolveCliAgent('local:lean')).resolves.toBe(local);

    expect(agentCatalogMock.loadAgents).toHaveBeenCalledOnce();
    expect(agentCatalogMock.loadAgents).toHaveBeenCalledWith({
      includeRemote: false,
    });
    expect(isAuthenticatedSpy).not.toHaveBeenCalled();
  });

  it('uses launch target category for local and remote-fallback lookups', async () => {
    const remote = agent('assistant', 'remote');
    agentCatalogMock.resolveAgentForLaunch
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(resolution(remote));

    await expect(resolveCliLaunchAgent('assistant', 'agentsRun')).resolves.toBe(
      remote,
    );

    expect(agentCatalogMock.resolveAgentForLaunch).toHaveBeenNthCalledWith(
      1,
      AgentCategory.ToolUse,
      'assistant',
      undefined,
    );
    expect(agentCatalogMock.resolveAgentForLaunch).toHaveBeenNthCalledWith(
      2,
      AgentCategory.ToolUse,
      'assistant',
      undefined,
    );
  });

  it('pins a source-qualified launch identifier to that exact source', async () => {
    const shadowed = agent('review', 'builtInToolUse');
    agentCatalogMock.resolveAgentForLaunch.mockReturnValue(
      resolution(shadowed),
    );

    await expect(
      resolveCliLaunchAgent('builtInToolUse:review', 'chat'),
    ).resolves.toBe(shadowed);

    expect(agentCatalogMock.resolveAgentForLaunch).toHaveBeenCalledWith(
      AgentCategory.ToolUse,
      'builtInToolUse:review',
      'builtInToolUse',
    );
    expect(isAuthenticatedSpy).not.toHaveBeenCalled();
  });

  it('reports launch-specific missing-agent messages', async () => {
    agentCatalogMock.resolveAgentForLaunch.mockReturnValue(undefined);

    await expect(resolveCliLaunchAgent('missing', 'agentsRun')).rejects.toThrow(
      'Tool-use agent not found: missing. Use `texra agents list` for visible starter agents, `texra agents list --all` for every agent, or pass a known launchable agent name from a team preset.',
    );
  });

  it('probes the other category to report a launch-mode mismatch', async () => {
    const workflow = agent('polish', 'builtInWorkflow', AgentCategory.Workflow);
    agentCatalogMock.resolveAgentForLaunch.mockImplementation(
      (category: AgentCategory) =>
        category === AgentCategory.Workflow ? resolution(workflow) : undefined,
    );

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

    expect(() => assertCliAgentLaunch('correct', workflow, 'chat')).toThrow(
      'Agent "correct" is a workflow agent; `texra chat` only handles tool-use agents.',
    );
  });
});
