import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { CliContext } from '@cli/runtime/cliContext';

const mocks = vi.hoisted(() => ({
  emitCliResult: vi.fn(),
  getAgent: vi.fn(),
  getAgentsByCategory: vi.fn(),
  getVisibleAgents: vi.fn(),
  initLocalCliPlatform: vi.fn(),
  loadAgents: vi.fn(),
  resolveCliAgent: vi.fn(),
  writeTextStderr: vi.fn(),
}));

vi.mock('@agent/index', () => ({
  getAgent: mocks.getAgent,
  getAgentsByCategory: mocks.getAgentsByCategory,
  getVisibleAgents: mocks.getVisibleAgents,
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

vi.mock('@cli/runtime/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/agents')>()),
  resolveCliAgent: mocks.resolveCliAgent,
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
  // Warm the module graph so the first test isn't charged the import cost,
  // which can exceed the per-test timeout on slow machines.
  beforeAll(async () => {
    await import('@cli/commands/agents');
  }, 30_000);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAgentsByCategory.mockReturnValue([]);
    mocks.getVisibleAgents.mockReturnValue([]);
  });

  it('parses agent category filter spellings', async () => {
    const { parseCliAgentCategoryFilter } = await import('@cli/runtime/agents');

    expect(parseCliAgentCategoryFilter('workflow')).toBe(
      AgentCategory.Workflow,
    );
    expect(parseCliAgentCategoryFilter('toolUse')).toBe(AgentCategory.ToolUse);
    expect(parseCliAgentCategoryFilter('tool-use')).toBe(AgentCategory.ToolUse);
    expect(parseCliAgentCategoryFilter('tool_use')).toBe(AgentCategory.ToolUse);
    expect(parseCliAgentCategoryFilter('work-flow')).toBeUndefined();
    expect(parseCliAgentCategoryFilter('unknown')).toBeUndefined();
  });

  it('lists visible agents by default and reports hidden agents', async () => {
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
    mocks.getAgentsByCategory.mockImplementation((category: AgentCategory) =>
      category === AgentCategory.ToolUse ? [visibleAgent, hiddenAgent] : [],
    );
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

  it('reports hidden agents in json mode without changing stdout payload', async () => {
    const hiddenWorkflowAgent = {
      name: 'correct',
      source: 'builtInWorkflow',
      path: '/tmp/resources/agents/correct.yaml',
      category: AgentCategory.Workflow,
      description: 'Corrects LaTeX.',
    };
    mocks.getAgentsByCategory.mockImplementation((category: AgentCategory) =>
      category === AgentCategory.Workflow ? [hiddenWorkflowAgent] : [],
    );
    const { listAgents } = await import('@cli/commands/agents');

    const exitCode = await listAgents(cliContext({ outputFormat: 'json' }), {
      category: AgentCategory.Workflow,
    });

    expect(exitCode).toBe(0);
    expect(mocks.emitCliResult).toHaveBeenCalledWith(
      expect.anything(),
      {
        json: [],
        ndjson: [],
        text: '',
      },
      { paged: true },
    );
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      'Showing visible agents only; 1 hidden agent omitted. Use `texra agents list --category workflow --all` to show the workflow catalog.',
    );
  });

  it('shows a text empty state when no workflow agents are visible', async () => {
    const hiddenWorkflowAgent = {
      name: 'correct',
      source: 'builtInWorkflow',
      path: '/tmp/resources/agents/correct.yaml',
      category: AgentCategory.Workflow,
      description: 'Corrects LaTeX.',
    };
    mocks.getAgentsByCategory.mockImplementation((category: AgentCategory) =>
      category === AgentCategory.Workflow ? [hiddenWorkflowAgent] : [],
    );
    const { listAgents } = await import('@cli/commands/agents');

    const exitCode = await listAgents(cliContext(), {
      category: AgentCategory.Workflow,
    });

    expect(exitCode).toBe(0);
    expect(mocks.emitCliResult).toHaveBeenCalledWith(
      expect.anything(),
      {
        json: [],
        ndjson: [],
        text: 'No visible workflow agents are enabled for this workspace. Use `texra agents list --category workflow --all` to show the workflow catalog.',
      },
      { paged: true },
    );
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      'Showing visible agents only; 1 hidden agent omitted. Use `texra agents list --category workflow --all` to show the workflow catalog.',
    );
  });

  it('keeps quiet empty agent lists byte-empty for shell completion', async () => {
    const hiddenWorkflowAgent = {
      name: 'correct',
      source: 'builtInWorkflow',
      path: '/tmp/resources/agents/correct.yaml',
      category: AgentCategory.Workflow,
      description: 'Corrects LaTeX.',
    };
    mocks.getAgentsByCategory.mockImplementation((category: AgentCategory) =>
      category === AgentCategory.Workflow ? [hiddenWorkflowAgent] : [],
    );
    const { listAgents } = await import('@cli/commands/agents');

    const exitCode = await listAgents(cliContext({ quietLogs: true }), {
      category: AgentCategory.Workflow,
    });

    expect(exitCode).toBe(0);
    expect(mocks.emitCliResult).toHaveBeenCalledWith(
      expect.anything(),
      {
        json: [],
        ndjson: [],
        text: '',
      },
      { paged: true },
    );
    expect(mocks.writeTextStderr).not.toHaveBeenCalled();
  });

  it('suppresses hidden-agent notices in quiet text mode', async () => {
    const visibleAgent = {
      name: 'polish',
      source: 'builtInWorkflow',
      path: '/tmp/resources/agents/polish.yaml',
      category: AgentCategory.Workflow,
      description: 'Polishes prose.',
    };
    const hiddenAgent = {
      name: 'correct',
      source: 'builtInWorkflow',
      path: '/tmp/resources/agents/correct.yaml',
      category: AgentCategory.Workflow,
      description: 'Corrects LaTeX.',
    };
    mocks.getVisibleAgents.mockImplementation((category: AgentCategory) =>
      category === AgentCategory.Workflow ? [visibleAgent] : [],
    );
    mocks.getAgentsByCategory.mockImplementation((category: AgentCategory) =>
      category === AgentCategory.Workflow ? [visibleAgent, hiddenAgent] : [],
    );
    const { listAgents } = await import('@cli/commands/agents');

    const exitCode = await listAgents(cliContext({ quietLogs: true }), {
      category: AgentCategory.Workflow,
    });

    expect(exitCode).toBe(0);
    expect(mocks.emitCliResult).toHaveBeenCalledWith(
      expect.anything(),
      {
        json: [visibleAgent],
        ndjson: [{ kind: 'agent', agent: visibleAgent }],
        text: 'workflow\tpolish\tPolishes prose.',
      },
      { paged: true },
    );
    expect(mocks.writeTextStderr).not.toHaveBeenCalled();
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
    mocks.getAgentsByCategory.mockImplementation((category: AgentCategory) => {
      if (category !== AgentCategory.ToolUse) {
        throw new Error('workflow agents should not be loaded');
      }
      return [visibleToolUseAgent, hiddenToolUseAgent];
    });
    const { listAgents } = await import('@cli/commands/agents');

    const exitCode = await listAgents(cliContext(), {
      category: AgentCategory.ToolUse,
    });

    expect(exitCode).toBe(0);
    expect(mocks.getAgentsByCategory).not.toHaveBeenCalledWith(
      AgentCategory.Workflow,
    );
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
      'Showing visible agents only; 1 hidden agent omitted. Use `texra agents list --category toolUse --all` to show the tool-use catalog.',
    );
  });

  it('keeps the workflow category in the hidden-agent notice', async () => {
    const visibleWorkflowAgent = {
      name: 'polish',
      source: 'builtInWorkflow',
      path: '/tmp/resources/agents/polish.yaml',
      category: AgentCategory.Workflow,
      description: 'Polishes prose.',
    };
    const hiddenWorkflowAgent = {
      name: 'correct',
      source: 'builtInWorkflow',
      path: '/tmp/resources/agents/correct.yaml',
      category: AgentCategory.Workflow,
      description: 'Corrects LaTeX.',
    };
    mocks.getVisibleAgents.mockImplementation((category: AgentCategory) =>
      category === AgentCategory.Workflow ? [visibleWorkflowAgent] : [],
    );
    mocks.getAgentsByCategory.mockImplementation((category: AgentCategory) =>
      category === AgentCategory.Workflow
        ? [visibleWorkflowAgent, hiddenWorkflowAgent]
        : [],
    );
    const { listAgents } = await import('@cli/commands/agents');

    const exitCode = await listAgents(cliContext(), {
      category: AgentCategory.Workflow,
    });

    expect(exitCode).toBe(0);
    expect(mocks.emitCliResult).toHaveBeenCalledWith(
      expect.anything(),
      {
        json: [visibleWorkflowAgent],
        ndjson: [{ kind: 'agent', agent: visibleWorkflowAgent }],
        text: 'workflow\tpolish\tPolishes prose.',
      },
      { paged: true },
    );
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      'Showing visible agents only; 1 hidden agent omitted. Use `texra agents list --category workflow --all` to show the workflow catalog.',
    );
  });

  it('lists the full catalog with --all semantics', async () => {
    const workflowAgent = {
      name: 'correct',
      source: 'builtInWorkflow',
      path: '/tmp/resources/agents/correct.yaml',
      category: AgentCategory.Workflow,
      description: 'Fixes typos.',
      rounds: 1,
    };
    const toolUseAgent = {
      name: 'chat',
      source: 'builtInToolUse',
      path: '/tmp/resources/tool_use_agents/chat.yaml',
      category: AgentCategory.ToolUse,
      description: 'Interactive assistant.',
    };
    mocks.getAgentsByCategory.mockImplementation((category: AgentCategory) =>
      category === AgentCategory.Workflow ? [workflowAgent] : [toolUseAgent],
    );
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

  it('uses the CLI agent resolver for agent details', async () => {
    const localAgent = {
      name: 'lean',
      source: 'builtInToolUse',
      path: '/tmp/resources/tool_use_agents/lean.yaml',
      category: AgentCategory.ToolUse,
      description: 'Lean 4 proof assistant.',
      tools: ['lean_diagnostics'],
    };
    mocks.resolveCliAgent.mockResolvedValue(localAgent);
    const { showAgent } = await import('@cli/commands/agents');

    const exitCode = await showAgent(cliContext(), 'lean');

    expect(exitCode).toBe(0);
    expect(mocks.initLocalCliPlatform).toHaveBeenCalledTimes(1);
    expect(mocks.getAgent).not.toHaveBeenCalled();
    expect(mocks.resolveCliAgent).toHaveBeenCalledWith('lean');
    expect(mocks.emitCliResult).toHaveBeenCalledWith(expect.anything(), {
      json: localAgent,
      ndjson: { kind: 'agent', agent: localAgent },
      text: expect.stringContaining('source: builtInToolUse'),
    });
  });

  it('renders workflow round counts in agent details', async () => {
    const workflowAgent = {
      name: 'polish',
      source: 'builtInWorkflow',
      path: '/tmp/resources/agents/polish.yaml',
      category: AgentCategory.Workflow,
      description: 'Polishes prose.',
      rounds: 2,
    };
    mocks.resolveCliAgent.mockResolvedValue(workflowAgent);
    const { showAgent } = await import('@cli/commands/agents');

    const exitCode = await showAgent(cliContext(), 'polish');

    expect(exitCode).toBe(0);
    expect(mocks.emitCliResult).toHaveBeenCalledWith(expect.anything(), {
      json: workflowAgent,
      ndjson: { kind: 'agent', agent: workflowAgent },
      text: expect.stringContaining('rounds: 2'),
    });
  });

  it('renders the agent returned by the resolver regardless of source', async () => {
    const remoteAgent = {
      name: 'lean',
      source: 'remote',
      path: '',
      category: AgentCategory.ToolUse,
      description: 'Relay-served Lean assistant.',
      tools: ['delegate_agent', 'lean_diagnostics'],
      visibility: ['public'],
    };
    mocks.resolveCliAgent.mockResolvedValue(remoteAgent);
    const { showAgent } = await import('@cli/commands/agents');

    const exitCode = await showAgent(cliContext(), 'lean');

    expect(exitCode).toBe(0);
    expect(mocks.getAgent).not.toHaveBeenCalled();
    expect(mocks.resolveCliAgent).toHaveBeenCalledWith('lean');
    expect(mocks.emitCliResult).toHaveBeenCalledWith(expect.anything(), {
      json: remoteAgent,
      ndjson: { kind: 'agent', agent: remoteAgent },
      text: expect.stringContaining('source: remote'),
    });
  });

  it('uses the CLI agent resolver when local lookup misses', async () => {
    const remoteAgent = {
      name: 'orchestrator',
      source: 'remote',
      path: '',
      category: AgentCategory.ToolUse,
      description: 'Coordinates multi-agent work.',
      tools: ['delegate_agent', 'delegate_workflow'],
      visibility: ['public'],
    };
    mocks.resolveCliAgent.mockResolvedValue(remoteAgent);
    const { showAgent } = await import('@cli/commands/agents');

    const exitCode = await showAgent(cliContext(), 'orchestrator');

    expect(exitCode).toBe(0);
    expect(mocks.initLocalCliPlatform).toHaveBeenCalledTimes(1);
    expect(mocks.resolveCliAgent).toHaveBeenCalledWith('orchestrator');
    expect(mocks.emitCliResult).toHaveBeenCalledWith(expect.anything(), {
      json: remoteAgent,
      ndjson: { kind: 'agent', agent: remoteAgent },
      text: expect.stringContaining('source: remote'),
    });
  });

  it('reports missing agents after CLI agent resolution misses', async () => {
    mocks.resolveCliAgent.mockResolvedValue(undefined);
    const { showAgent } = await import('@cli/commands/agents');

    const exitCode = await showAgent(cliContext(), 'missing-agent');

    expect(exitCode).toBe(2);
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      'Agent not found: missing-agent. Use `texra agents list` for visible starter agents, `texra agents list --all` for the full catalog, or pass a known launchable agent name from a team preset.',
    );
    expect(mocks.emitCliResult).not.toHaveBeenCalled();
  });
});
