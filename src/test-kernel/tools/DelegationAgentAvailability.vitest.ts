import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolDefinition } from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  getVisibleAgents: vi.fn(),
  getVisibleAgent: vi.fn(),
  computeModelOptionsData: vi.fn(),
}));

vi.mock('@agent/index/agentRegistry', () => ({
  getVisibleAgents: mocks.getVisibleAgents,
  getVisibleAgent: mocks.getVisibleAgent,
  // No test here activates a delegation scope (no RunContext mock), so this
  // always falls through to the workspace-visible roster.
  resolveDelegationScopeAgents: (scope: unknown, category: string) =>
    scope ? [] : mocks.getVisibleAgents(category),
}));

vi.mock('@model/computeModelOptions', () => ({
  computeModelOptionsData: mocks.computeModelOptionsData,
}));

const {
  formatAgentList,
  visibleDelegationAgentsBlock,
  withDelegationAgentAvailability,
} = await import('@tools/delegation/delegationAvailability');
const { resolveAgentTools } =
  await import('@agent/runtime/agentToolResolution');
const { MapToolRegistry } = await import('@agent/core/tools/ToolTypes');
const { ToolInjectionRegistry } = await import('@agent/runtime/toolInjection');

const DELEGATE_AGENT_DESCRIPTION = [
  'Delegate a task to a tool-use agent.',
  '',
  'Available agents: loaded from the active roster at runtime.',
  '',
  'Agent selection: choose the most specific agent whose description matches.',
  '',
  'Available models: loaded from the active API mode at runtime.',
].join('\n');

const DELEGATE_WORKFLOW_DESCRIPTION = [
  'Delegate to a workflow agent.',
  '',
  'Available agents: loaded from the active roster at runtime.',
  '',
  'Pick the agent whose description matches the task.',
].join('\n');

type ToolInput = {
  name: string;
  description?: ToolDefinition['description'];
  availabilityCategory?: ToolDefinition['availabilityCategory'];
};

const DELEGATE_AGENT_TOOL: ToolInput = {
  name: 'delegate_agent',
  availabilityCategory: 'toolUse',
  description: DELEGATE_AGENT_DESCRIPTION,
};

const RESEARCH_NUMERICS_AGENTS = [
  { name: 'research', description: 'Derive and verify.' },
  { name: 'numerics', description: 'Run simulations.', tools: ['bash'] },
];

function rewriteRoster(
  rosterBlock: string,
  tool: ToolDefinition = {
    name: 'delegate_agent',
    description: DELEGATE_AGENT_DESCRIPTION,
  },
) {
  return withDelegationAgentAvailability(tool, rosterBlock);
}

function delegationRegistry(names: readonly string[]) {
  return new MapToolRegistry(
    Object.fromEntries(
      names.map((name) => [
        name,
        {
          definition: { name },
          call: async () => ({ status: 'executed', summary: '', output: '' }),
        },
      ]),
    ),
  );
}

async function resolveToolList(tools: ToolInput[] = [DELEGATE_AGENT_TOOL]) {
  const resolved = await resolveAgentTools({
    tools,
    registry: delegationRegistry(tools.map((t) => t.name)),
    logger: { warn: () => {} },
    toolInjections: new ToolInjectionRegistry(),
  });
  return resolved.tools;
}

async function resolveDelegateAgent(extraTools: ToolInput[] = []) {
  const tools = await resolveToolList([DELEGATE_AGENT_TOOL, ...extraTools]);
  return tools.find((t) => t.name === 'delegate_agent');
}

describe('delegation agent availability', () => {
  it('formats an agent list with descriptions and per-agent tools', () => {
    expect(formatAgentList(RESEARCH_NUMERICS_AGENTS)).toBe(
      [
        '- research: Derive and verify.',
        '- numerics: Run simulations.',
        '  Tools: bash',
      ].join('\n'),
    );
  });

  it('replaces the placeholder Available agents line with the live roster', () => {
    const rewritten = rewriteRoster(
      'Available agents:\n- research: Derive things.',
    );

    expect(rewritten.description).toContain(
      'Available agents:\n- research: Derive things.',
    );
    expect(rewritten.description).not.toContain(
      'loaded from the active roster at runtime',
    );
    // Following sections survive the block replacement untouched.
    expect(rewritten.description).toContain(
      'Agent selection: choose the most specific',
    );
    expect(rewritten.description).toContain(
      'Available models: loaded from the active API mode at runtime.',
    );
  });

  it('replaces an already-expanded multi-line roster block', () => {
    const rewritten = rewriteRoster(
      'Available agents:\n- apply: Apply review suggestions.',
      {
        name: 'delegate_workflow',
        description: [
          'Delegate to a workflow agent.',
          '',
          'Available agents:',
          '- correct: Proofread.',
          '- polish: Rewrite.',
          '',
          'Pick the agent whose description matches the task.',
        ].join('\n'),
      },
    );

    expect(rewritten.description).toContain(
      'Available agents:\n- apply: Apply review suggestions.',
    );
    expect(rewritten.description).not.toContain('correct: Proofread');
    expect(rewritten.description).not.toContain('polish: Rewrite');
    expect(rewritten.description).toContain(
      'Pick the agent whose description matches the task.',
    );
  });

  it('appends the roster block when the description has none', () => {
    const rewritten = rewriteRoster(
      'Available agents:\n- review: Audit a change.',
      {
        name: 'delegate_agent',
        description: 'Delegate a task to a tool-use agent.',
      },
    );

    expect(rewritten.description).toBe(
      'Delegate a task to a tool-use agent.\n\nAvailable agents:\n- review: Audit a change.',
    );
  });

  it('treats a $ in an agent description as a literal, not a replacement token', () => {
    const rewritten = rewriteRoster(
      'Available agents:\n- prover: Prove $\\forall x$ statements.',
    );

    expect(rewritten.description).toContain('Prove $\\forall x$ statements.');
  });

  it('replaces (not duplicates) a roster block that ends the description', () => {
    const rewritten = rewriteRoster(
      'Available agents:\n- review: Audit a change.',
      {
        name: 'delegate_agent',
        description:
          'Delegate a task.\n\nAvailable agents: loaded from the active roster at runtime.',
      },
    );

    expect(rewritten.description).toBe(
      'Delegate a task.\n\nAvailable agents:\n- review: Audit a change.',
    );
    expect(rewritten.description?.match(/Available agents:/g)).toHaveLength(1);
  });

  it('collapses newlines inside an agent description to one paragraph', () => {
    expect(
      formatAgentList([
        { name: 'prover', description: 'Prove theorems.\n\nUses Lean.' },
      ]),
    ).toBe('- prover: Prove theorems. Uses Lean.');
  });

  it('leaves non-delegation tools untouched', () => {
    const tool: ToolDefinition = {
      name: 'read_file',
      description:
        'Available agents: loaded from the active roster at runtime.',
    };

    expect(
      withDelegationAgentAvailability(tool, 'Available agents:\n- x: y'),
    ).toBe(tool);
  });
});

describe('visibleDelegationAgentsBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds a roster block from the currently visible agents', () => {
    mocks.getVisibleAgents.mockReturnValue(RESEARCH_NUMERICS_AGENTS);

    expect(visibleDelegationAgentsBlock('toolUse')).toBe(
      [
        'Available agents:',
        '- research: Derive and verify.',
        '- numerics: Run simulations.',
        '  Tools: bash',
      ].join('\n'),
    );
    expect(mocks.getVisibleAgents).toHaveBeenCalledWith('toolUse');
  });

  it('emits an actionable line when the roster is empty', () => {
    mocks.getVisibleAgents.mockReturnValue([]);

    const block = visibleDelegationAgentsBlock('workflow');
    expect(block).toContain('none are currently in the active roster');
    expect(block).not.toContain('Available agents:\n');
  });
});

describe('resolveAgentTools delegation roster annotation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.computeModelOptionsData.mockResolvedValue([
      {
        value: 'deepseekT',
        label: 'DeepSeek',
        disabled: false,
        requiresKey: false,
      },
    ]);
  });

  it('refreshes the Available agents line of delegation tools per run', async () => {
    mocks.getVisibleAgents.mockReturnValue(RESEARCH_NUMERICS_AGENTS);

    const delegateAgent = await resolveDelegateAgent();
    expect(delegateAgent?.description).toContain(
      'Available agents:\n- research: Derive and verify.',
    );
    expect(delegateAgent?.description).toContain(
      '- numerics: Run simulations.',
    );
    expect(delegateAgent?.description).not.toContain(
      'loaded from the active roster at runtime',
    );
    // The models line is refreshed in the same pass.
    expect(delegateAgent?.description).toContain('Available models: deepseekT');
    expect(mocks.getVisibleAgents).toHaveBeenCalledWith('toolUse');
  });

  it('does not annotate a roster line onto non-delegation tools', async () => {
    mocks.getVisibleAgents.mockReturnValue([
      { name: 'research', description: 'Derive and verify.' },
    ]);

    const tools = await resolveToolList([
      DELEGATE_AGENT_TOOL,
      { name: 'grep', description: 'Search files.' },
    ]);

    const grep = tools.find((t) => t.name === 'grep');
    expect(grep?.description).toBe('Search files.');
  });

  it('reflects the current roster on each call, not a frozen snapshot', async () => {
    // The #6655 regression: the roster was captured once and reused. Resolving
    // twice with a roster change between calls must yield a refreshed list.
    mocks.getVisibleAgents.mockReturnValue([
      { name: 'research', description: 'Derive.' },
      { name: 'numerics', description: 'Simulate.' },
    ]);
    const first = await resolveDelegateAgent();
    expect(first?.description).toContain('- research:');
    expect(first?.description).toContain('- numerics:');

    mocks.getVisibleAgents.mockReturnValue([
      { name: 'coder', description: 'Write code.' },
    ]);
    const second = await resolveDelegateAgent();
    expect(second?.description).toContain('- coder:');
    expect(second?.description).not.toContain('- research:');
    expect(second?.description).not.toContain('- numerics:');
  });

  it('emits the empty-roster directive end-to-end when nothing is visible', async () => {
    mocks.getVisibleAgents.mockReturnValue([]);

    const delegateAgent = await resolveDelegateAgent();
    expect(delegateAgent?.description).toContain(
      'none are currently in the active roster',
    );
    expect(delegateAgent?.description).not.toContain('Available agents:\n');
    expect(delegateAgent?.description).not.toContain(
      'loaded from the active roster at runtime',
    );
  });

  it('annotates each delegation tool from its own agent category', async () => {
    mocks.getVisibleAgents.mockImplementation((category: string) =>
      category === 'toolUse'
        ? [{ name: 'coder', description: 'Write code.' }]
        : [{ name: 'apply', description: 'Apply review suggestions.' }],
    );

    const tools = await resolveToolList([
      DELEGATE_AGENT_TOOL,
      {
        name: 'delegate_workflow',
        availabilityCategory: 'workflow',
        description: DELEGATE_WORKFLOW_DESCRIPTION,
      },
    ]);

    const delegateAgent = tools.find((t) => t.name === 'delegate_agent');
    const delegateWorkflow = tools.find((t) => t.name === 'delegate_workflow');
    expect(delegateAgent?.description).toContain('- coder:');
    expect(delegateAgent?.description).not.toContain('- apply:');
    expect(delegateWorkflow?.description).toContain('- apply:');
    expect(delegateWorkflow?.description).not.toContain('- coder:');
    expect(mocks.getVisibleAgents).toHaveBeenCalledWith('toolUse');
    expect(mocks.getVisibleAgents).toHaveBeenCalledWith('workflow');
  });

  it('keeps a $ in an agent description literal through resolveAgentTools', async () => {
    mocks.getVisibleAgents.mockReturnValue([
      { name: 'prover', description: 'Prove $P=NP$ statements.' },
      { name: 'numerics', description: 'Run simulations.' },
    ]);

    const delegateAgent = await resolveDelegateAgent();
    expect(delegateAgent?.description).toContain(
      '- prover: Prove $P=NP$ statements.',
    );
    expect(delegateAgent?.description).toContain(
      '- numerics: Run simulations.',
    );
  });
});
