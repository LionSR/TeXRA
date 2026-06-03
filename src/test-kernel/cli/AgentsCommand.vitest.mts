import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { CliContext } from '@cli/runtime/cliContext';

const mocks = vi.hoisted(() => ({
  emitCliResult: vi.fn(),
  getAgent: vi.fn(),
  getToolUseAgents: vi.fn(),
  getVisibleAgents: vi.fn(),
  getWorkflowAgents: vi.fn(),
  initLocalCliPlatform: vi.fn(),
  loadAgents: vi.fn(),
  resolveAgentWithRemoteFallback: vi.fn(),
  writeTextStderr: vi.fn(),
}));

vi.mock('@agent/index', () => ({
  getAgent: mocks.getAgent,
  getToolUseAgents: mocks.getToolUseAgents,
  getVisibleAgents: mocks.getVisibleAgents,
  getWorkflowAgents: mocks.getWorkflowAgents,
  loadAgents: mocks.loadAgents,
}));

vi.mock('@cli/runtime/initPlatform', () => ({
  initLocalCliPlatform: mocks.initLocalCliPlatform,
}));

vi.mock('@cli/runtime/logSinks', () => ({
  writeTextStderr: mocks.writeTextStderr,
}));

vi.mock('@cli/commands/_helpers/output', () => ({
  emitCliResult: mocks.emitCliResult,
}));

vi.mock('@cli/commands/_helpers/remoteAgents', () => ({
  resolveAgentWithRemoteFallback: mocks.resolveAgentWithRemoteFallback,
}));

function cliContext(overrides: Partial<CliContext> = {}): CliContext {
  return {
    cwd: '/tmp/project',
    mode: 'headless',
    outputFormat: 'text',
    approvalPolicy: 'never',
    quietLogs: false,
    renderRunProgress: true,
    stderrIsTty: false,
    stdoutColorEnabled: false,
    stderrColorEnabled: false,
    colorEnabled: false,
    version: '0.0.0',
    resourcesPath: '/tmp/resources',
    ...overrides,
  };
}

describe('CLI agents command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getToolUseAgents.mockReturnValue([]);
    mocks.getVisibleAgents.mockReturnValue([]);
    mocks.getWorkflowAgents.mockReturnValue([]);
  });

  it('parses agent category filter spellings', async () => {
    const { parseAgentCategoryFilter } = await import('@cli/commands/agents');

    expect(parseAgentCategoryFilter('workflow')).toBe(AgentCategory.Workflow);
    expect(parseAgentCategoryFilter('toolUse')).toBe(AgentCategory.ToolUse);
    expect(parseAgentCategoryFilter('tool-use')).toBe(AgentCategory.ToolUse);
    expect(parseAgentCategoryFilter('tool_use')).toBe(AgentCategory.ToolUse);
    expect(parseAgentCategoryFilter('work-flow')).toBeUndefined();
    expect(parseAgentCategoryFilter('unknown')).toBeUndefined();
  });

  it('lists visible agents by default and reports hidden agents in text mode', async () => {
    const visibleAgent = {
      name: 'lean',
      source: 'builtInToolUse',
      path: '/tmp/resources/tool_use_agents/lean.yaml',
      category: AgentCategory.ToolUse,
      description: 'Lean 4 proof assistant.',
    };
    const hiddenAgent = {
      name: 'chat',
      source: 'builtInToolUse',
      path: '/tmp/resources/tool_use_agents/chat.yaml',
      category: AgentCategory.ToolUse,
      description: 'Interactive assistant.',
    };
    mocks.getVisibleAgents.mockImplementation((category: AgentCategory) =>
      category === AgentCategory.ToolUse ? [visibleAgent] : [],
    );
    mocks.getToolUseAgents.mockReturnValue([visibleAgent, hiddenAgent]);
    const { listAgents } = await import('@cli/commands/agents');

    const exitCode = await listAgents(cliContext());

    expect(exitCode).toBe(0);
    expect(mocks.loadAgents).toHaveBeenCalledWith({ includeRemote: false });
    expect(mocks.emitCliResult).toHaveBeenCalledWith(
      expect.anything(),
      {
        json: [visibleAgent],
        ndjson: [{ kind: 'agent', agent: visibleAgent }],
        text: 'toolUse\tlean\tLean 4 proof assistant.',
      },
      { paged: true },
    );
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      'Showing visible agents only; 1 hidden agent omitted. Use `texra agents list --all` to show the full catalog.',
    );
  });

  it('filters agents by category and reports hidden agents in that category', async () => {
    const visibleToolUseAgent = {
      name: 'lean',
      source: 'builtInToolUse',
      path: '/tmp/resources/tool_use_agents/lean.yaml',
      category: AgentCategory.ToolUse,
      description: 'Lean 4 proof assistant.',
    };
    const hiddenToolUseAgent = {
      name: 'chat',
      source: 'builtInToolUse',
      path: '/tmp/resources/tool_use_agents/chat.yaml',
      category: AgentCategory.ToolUse,
      description: 'Interactive assistant.',
    };
    mocks.getVisibleAgents.mockImplementation((category: AgentCategory) => {
      if (category !== AgentCategory.ToolUse) {
        throw new Error('workflow agents should not be loaded');
      }
      return [visibleToolUseAgent];
    });
    mocks.getWorkflowAgents.mockImplementation(() => {
      throw new Error('workflow agents should not be loaded');
    });
    mocks.getToolUseAgents.mockReturnValue([
      visibleToolUseAgent,
      hiddenToolUseAgent,
    ]);
    const { listAgents } = await import('@cli/commands/agents');

    const exitCode = await listAgents(cliContext(), {
      category: AgentCategory.ToolUse,
    });

    expect(exitCode).toBe(0);
    expect(mocks.getWorkflowAgents).not.toHaveBeenCalled();
    expect(mocks.emitCliResult).toHaveBeenCalledWith(
      expect.anything(),
      {
        json: [visibleToolUseAgent],
        ndjson: [{ kind: 'agent', agent: visibleToolUseAgent }],
        text: 'toolUse\tlean\tLean 4 proof assistant.',
      },
      { paged: true },
    );
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      'Showing visible agents only; 1 hidden agent omitted. Use `texra agents list --all` to show the full catalog.',
    );
  });

  it('lists the full catalog with --all semantics', async () => {
    const workflowAgent = {
      name: 'correct',
      source: 'builtInWorkflow',
      path: '/tmp/resources/agents/correct.yaml',
      category: AgentCategory.Workflow,
      description: 'Fixes typos.',
    };
    const toolUseAgent = {
      name: 'chat',
      source: 'builtInToolUse',
      path: '/tmp/resources/tool_use_agents/chat.yaml',
      category: AgentCategory.ToolUse,
      description: 'Interactive assistant.',
    };
    mocks.getWorkflowAgents.mockReturnValue([workflowAgent]);
    mocks.getToolUseAgents.mockReturnValue([toolUseAgent]);
    const { listAgents } = await import('@cli/commands/agents');

    const exitCode = await listAgents(cliContext(), { includeHidden: true });

    expect(exitCode).toBe(0);
    expect(mocks.loadAgents).toHaveBeenCalledWith(undefined);
    expect(mocks.getVisibleAgents).not.toHaveBeenCalled();
    expect(mocks.writeTextStderr).not.toHaveBeenCalled();
    expect(mocks.emitCliResult).toHaveBeenCalledWith(
      expect.anything(),
      {
        json: [workflowAgent, toolUseAgent],
        ndjson: [
          { kind: 'agent', agent: workflowAgent },
          { kind: 'agent', agent: toolUseAgent },
        ],
        text: [
          'workflow\tcorrect\tFixes typos.',
          'toolUse\tchat\tInteractive assistant.',
        ].join('\n'),
      },
      { paged: true },
    );
  });

  it('uses the local registry match for agent details before remote fallback', async () => {
    const localAgent = {
      name: 'lean',
      source: 'builtInToolUse',
      path: '/tmp/resources/tool_use_agents/lean.yaml',
      category: AgentCategory.ToolUse,
      description: 'Lean 4 proof assistant.',
      tools: ['lean_diagnostics'],
    };
    mocks.getAgent.mockReturnValue(localAgent);
    const { showAgent } = await import('@cli/commands/agents');

    const exitCode = await showAgent(cliContext(), 'lean');

    expect(exitCode).toBe(0);
    expect(mocks.initLocalCliPlatform).toHaveBeenCalledTimes(1);
    expect(mocks.loadAgents).toHaveBeenCalledWith({ includeRemote: false });
    expect(mocks.getAgent).toHaveBeenCalledWith('lean');
    expect(mocks.resolveAgentWithRemoteFallback).not.toHaveBeenCalled();
    expect(mocks.emitCliResult).toHaveBeenCalledWith(expect.anything(), {
      json: localAgent,
      ndjson: { kind: 'agent', agent: localAgent },
      text: expect.stringContaining('source: builtInToolUse'),
    });
  });

  it('uses the remote fallback resolver when local lookup misses', async () => {
    const remoteAgent = {
      name: 'orchestrator',
      source: 'remote',
      path: '',
      category: AgentCategory.ToolUse,
      description: 'Coordinates multi-agent work.',
      tools: ['delegate_agent', 'delegate_workflow'],
      visibility: ['public'],
    };
    mocks.getAgent.mockReturnValue(undefined);
    mocks.resolveAgentWithRemoteFallback.mockResolvedValue(remoteAgent);
    const { showAgent } = await import('@cli/commands/agents');

    const exitCode = await showAgent(cliContext(), 'orchestrator');

    expect(exitCode).toBe(0);
    expect(mocks.initLocalCliPlatform).toHaveBeenCalledTimes(1);
    expect(mocks.loadAgents).toHaveBeenCalledWith({ includeRemote: false });
    expect(mocks.resolveAgentWithRemoteFallback).toHaveBeenCalledWith(
      'orchestrator',
    );
    expect(mocks.emitCliResult).toHaveBeenCalledWith(expect.anything(), {
      json: remoteAgent,
      ndjson: { kind: 'agent', agent: remoteAgent },
      text: expect.stringContaining('source: remote'),
    });
  });

  it('reports missing agents after the remote fallback is exhausted', async () => {
    mocks.getAgent.mockReturnValue(undefined);
    mocks.resolveAgentWithRemoteFallback.mockResolvedValue(undefined);
    const { showAgent } = await import('@cli/commands/agents');

    const exitCode = await showAgent(cliContext(), 'missing-agent');

    expect(exitCode).toBe(2);
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      'Agent not found: missing-agent. Use `texra agents list` for visible starter agents, or pass a known launchable agent name from a team preset.',
    );
    expect(mocks.emitCliResult).not.toHaveBeenCalled();
  });
});
