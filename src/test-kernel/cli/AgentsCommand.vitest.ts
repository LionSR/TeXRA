import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliContext } from '@cli/runtime/cliContext';
import { AgentCategory } from '@shared/schemas';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';

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

// Import the modules under test after the mock factories above are registered
// so their imports resolve to the mocked modules. Top-level (not beforeAll) so
// the import cost lands in file load, not the first test's timeout budget.
const { listAgents, showAgent } = await import('@cli/commands/agents');
const { parseCliAgentCategoryFilter } = await import('@cli/runtime/agents');

function cliContext(overrides: Partial<CliContext> = {}): CliContext {
  return createTestCliContext({
    renderRunProgress: true,
    ...overrides,
  });
}

const LEAN_AGENT = {
  name: 'lean',
  source: 'builtInToolUse',
  path: '/tmp/resources/tool_use_agents/lean.yaml',
  category: AgentCategory.ToolUse,
  description: 'Lean 4 proof assistant.',
};

const CHAT_AGENT = {
  name: 'chat',
  source: 'builtInToolUse',
  path: '/tmp/resources/tool_use_agents/chat.yaml',
  category: AgentCategory.ToolUse,
  description: 'Interactive assistant.',
};

const POLISH_AGENT = {
  name: 'polish',
  source: 'builtInWorkflow',
  path: '/tmp/resources/agents/polish.yaml',
  category: AgentCategory.Workflow,
  description: 'Polishes prose.',
};

const CORRECT_AGENT = {
  name: 'correct',
  source: 'builtInWorkflow',
  path: '/tmp/resources/agents/correct.yaml',
  category: AgentCategory.Workflow,
  description: 'Corrects LaTeX.',
};

type CategoryCatalog = Partial<
  Record<
    AgentCategory,
    { visible?: readonly unknown[]; all: readonly unknown[] }
  >
>;

function stubCatalog(catalog: CategoryCatalog): void {
  mocks.getVisibleAgents.mockImplementation(
    (category: AgentCategory) => catalog[category]?.visible ?? [],
  );
  mocks.getAgentsByCategory.mockImplementation(
    (category: AgentCategory) => catalog[category]?.all ?? [],
  );
}

interface EmittedAgentsPayload {
  json: unknown;
  ndjson: unknown;
  text: string;
}

function expectEmittedAgents(payload: EmittedAgentsPayload): void {
  expect(mocks.emitCliResult).toHaveBeenCalledWith(expect.anything(), payload, {
    paged: true,
  });
}

describe('CLI agents command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAgentsByCategory.mockReturnValue([]);
    mocks.getVisibleAgents.mockReturnValue([]);
  });

  it('parses agent category filter spellings', () => {
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
    stubCatalog({
      [AgentCategory.ToolUse]: {
        visible: [LEAN_AGENT],
        all: [LEAN_AGENT, CHAT_AGENT],
      },
    });

    const exitCode = await listAgents(cliContext());

    expect(exitCode).toBe(0);
    expect(mocks.loadAgents).toHaveBeenCalledWith({ includeRemote: false });
    expectEmittedAgents({
      json: [LEAN_AGENT],
      ndjson: [{ kind: 'agent', agent: LEAN_AGENT }],
      text: 'toolUse\tlean\tLean 4 proof assistant.',
    });
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      'Showing visible agents only; 1 hidden agent omitted. Use `texra agents list --all` to show all agents.',
    );
  });

  it('reports hidden agents in json mode without changing stdout payload', async () => {
    stubCatalog({ [AgentCategory.Workflow]: { all: [CORRECT_AGENT] } });

    const exitCode = await listAgents(cliContext({ outputFormat: 'json' }), {
      category: AgentCategory.Workflow,
    });

    expect(exitCode).toBe(0);
    expectEmittedAgents({
      json: [],
      ndjson: [],
      text: '',
    });
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      'Showing visible agents only; 1 hidden agent omitted. Use `texra agents list --category workflow --all` to show all workflow agents.',
    );
  });

  it('shows a text empty state when no workflow agents are visible', async () => {
    stubCatalog({ [AgentCategory.Workflow]: { all: [CORRECT_AGENT] } });

    const exitCode = await listAgents(cliContext(), {
      category: AgentCategory.Workflow,
    });

    expect(exitCode).toBe(0);
    expectEmittedAgents({
      json: [],
      ndjson: [],
      text: 'No visible workflow agents are enabled for this workspace. Use `texra agents list --category workflow --all` to show all workflow agents.',
    });
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      'Showing visible agents only; 1 hidden agent omitted. Use `texra agents list --category workflow --all` to show all workflow agents.',
    );
  });

  it('keeps quiet empty agent lists byte-empty for shell completion', async () => {
    stubCatalog({ [AgentCategory.Workflow]: { all: [CORRECT_AGENT] } });

    const exitCode = await listAgents(cliContext({ quietLogs: true }), {
      category: AgentCategory.Workflow,
    });

    expect(exitCode).toBe(0);
    expectEmittedAgents({
      json: [],
      ndjson: [],
      text: '',
    });
    expect(mocks.writeTextStderr).not.toHaveBeenCalled();
  });

  it('suppresses hidden-agent notices in quiet text mode', async () => {
    stubCatalog({
      [AgentCategory.Workflow]: {
        visible: [POLISH_AGENT],
        all: [POLISH_AGENT, CORRECT_AGENT],
      },
    });

    const exitCode = await listAgents(cliContext({ quietLogs: true }), {
      category: AgentCategory.Workflow,
    });

    expect(exitCode).toBe(0);
    expectEmittedAgents({
      json: [POLISH_AGENT],
      ndjson: [{ kind: 'agent', agent: POLISH_AGENT }],
      text: 'workflow\tpolish\tPolishes prose.',
    });
    expect(mocks.writeTextStderr).not.toHaveBeenCalled();
  });

  it('filters agents by category and reports hidden agents in that category', async () => {
    mocks.getVisibleAgents.mockImplementation((category: AgentCategory) => {
      if (category !== AgentCategory.ToolUse) {
        throw new Error('workflow agents should not be loaded');
      }
      return [LEAN_AGENT];
    });
    mocks.getAgentsByCategory.mockImplementation((category: AgentCategory) => {
      if (category !== AgentCategory.ToolUse) {
        throw new Error('workflow agents should not be loaded');
      }
      return [LEAN_AGENT, CHAT_AGENT];
    });
    const exitCode = await listAgents(cliContext(), {
      category: AgentCategory.ToolUse,
    });

    expect(exitCode).toBe(0);
    expect(mocks.getAgentsByCategory).not.toHaveBeenCalledWith(
      AgentCategory.Workflow,
    );
    expectEmittedAgents({
      json: [LEAN_AGENT],
      ndjson: [{ kind: 'agent', agent: LEAN_AGENT }],
      text: 'toolUse\tlean\tLean 4 proof assistant.',
    });
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      'Showing visible agents only; 1 hidden agent omitted. Use `texra agents list --category toolUse --all` to show all tool-use agents.',
    );
  });

  it('keeps the workflow category in the hidden-agent notice', async () => {
    stubCatalog({
      [AgentCategory.Workflow]: {
        visible: [POLISH_AGENT],
        all: [POLISH_AGENT, CORRECT_AGENT],
      },
    });

    const exitCode = await listAgents(cliContext(), {
      category: AgentCategory.Workflow,
    });

    expect(exitCode).toBe(0);
    expectEmittedAgents({
      json: [POLISH_AGENT],
      ndjson: [{ kind: 'agent', agent: POLISH_AGENT }],
      text: 'workflow\tpolish\tPolishes prose.',
    });
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      'Showing visible agents only; 1 hidden agent omitted. Use `texra agents list --category workflow --all` to show all workflow agents.',
    );
  });

  it('lists the full catalog with --all semantics', async () => {
    const workflowAgent = {
      ...CORRECT_AGENT,
      description: 'Fixes typos.',
      rounds: 1,
    };
    stubCatalog({
      [AgentCategory.Workflow]: { all: [workflowAgent] },
      [AgentCategory.ToolUse]: { all: [CHAT_AGENT] },
    });

    const exitCode = await listAgents(cliContext(), { includeHidden: true });

    expect(exitCode).toBe(0);
    expect(mocks.loadAgents).toHaveBeenCalledWith(undefined);
    expect(mocks.getVisibleAgents).not.toHaveBeenCalled();
    expect(mocks.writeTextStderr).not.toHaveBeenCalled();
    expectEmittedAgents({
      json: [workflowAgent, CHAT_AGENT],
      ndjson: [
        { kind: 'agent', agent: workflowAgent },
        { kind: 'agent', agent: CHAT_AGENT },
      ],
      text: [
        'workflow\tcorrect\tFixes typos.',
        'toolUse\tchat\tInteractive assistant.',
      ].join('\n'),
    });
  });

  it.each([
    {
      name: 'uses the CLI agent resolver for agent details',
      agent: { ...LEAN_AGENT, tools: ['lean_diagnostics'] },
      args: 'lean',
      textContain: 'source: builtInToolUse',
    },
    {
      name: 'renders workflow round counts in agent details',
      agent: { ...POLISH_AGENT, rounds: 2 },
      args: 'polish',
      textContain: 'rounds: 2',
    },
    {
      name: 'renders the agent returned by the resolver regardless of source',
      agent: {
        name: 'lean',
        source: 'remote',
        path: '',
        category: AgentCategory.ToolUse,
        description: 'Relay-served Lean assistant.',
        tools: ['delegate_agent', 'lean_diagnostics'],
      },
      args: 'lean',
      textContain: 'source: remote',
    },
  ])('$name', async ({ agent, args, textContain }) => {
    mocks.resolveCliAgent.mockResolvedValue(agent);

    const exitCode = await showAgent(cliContext(), args);

    expect(exitCode).toBe(0);
    expect(mocks.initLocalCliPlatform).toHaveBeenCalledTimes(1);
    expect(mocks.getAgent).not.toHaveBeenCalled();
    expect(mocks.resolveCliAgent).toHaveBeenCalledWith(args);
    expect(mocks.emitCliResult).toHaveBeenCalledWith(expect.anything(), {
      json: agent,
      ndjson: { kind: 'agent', agent },
      text: expect.stringContaining(textContain),
    });
  });

  it('reports missing agents after CLI agent resolution misses', async () => {
    mocks.resolveCliAgent.mockResolvedValue(undefined);

    const exitCode = await showAgent(cliContext(), 'missing-agent');

    expect(exitCode).toBe(2);
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      'Agent not found: missing-agent. Use `texra agents list` for visible starter agents, `texra agents list --all` for every agent, or pass a known launchable agent name from a team preset.',
    );
    expect(mocks.emitCliResult).not.toHaveBeenCalled();
  });
});
