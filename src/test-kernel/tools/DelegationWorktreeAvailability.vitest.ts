import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolDefinition } from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  isWorktreeSupportEnabled: vi.fn(),
  getVisibleAgents: vi.fn(),
  getVisibleAgent: vi.fn(),
  computeModelOptionsData: vi.fn(),
}));

vi.mock('@utils/config/worktreeConfig', () => ({
  isWorktreeSupportEnabled: mocks.isWorktreeSupportEnabled,
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

const { withDelegationWorktreeAvailability } =
  await import('@tools/delegation/delegationAvailability');
const { resolveAgentTools } =
  await import('@agent/runtime/agentToolResolution');
const { MapToolRegistry } = await import('@agent/core/tools/ToolTypes');
const { ToolInjectionRegistry } = await import('@agent/runtime/toolInjection');

const WORKTREE_PLACEHOLDER =
  'Git worktree support: resolved from the active workspace at runtime.';

const DELEGATE_AGENT_DESCRIPTION = [
  'Delegate a task to a tool-use agent.',
  '',
  'Available agents: loaded from the active roster at runtime.',
  '',
  'Available models: loaded from the active API mode at runtime.',
  '',
  WORKTREE_PLACEHOLDER,
].join('\n');

function delegateTool(): ToolDefinition {
  return { name: 'delegate_agent', description: DELEGATE_AGENT_DESCRIPTION };
}

describe('delegation worktree availability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('substitutes the ENABLED guidance when worktrees are on', () => {
    mocks.isWorktreeSupportEnabled.mockReturnValue(true);

    const rewritten = withDelegationWorktreeAvailability(delegateTool());

    expect(rewritten.description).toContain('Git worktree support: ENABLED.');
    expect(rewritten.description).toContain('Pass `working_directory`');
    expect(rewritten.description).not.toContain(
      'resolved from the active workspace at runtime',
    );
    // The lines above the worktree line are left intact.
    expect(rewritten.description).toContain(
      'Available agents: loaded from the active roster at runtime.',
    );
  });

  it('substitutes the DISABLED guidance when worktrees are off', () => {
    mocks.isWorktreeSupportEnabled.mockReturnValue(false);

    const rewritten = withDelegationWorktreeAvailability(delegateTool());

    expect(rewritten.description).toContain(
      'Git worktree support: DISABLED in this workspace.',
    );
    expect(rewritten.description).toContain(
      'will be rejected at schema validation',
    );
  });

  it('leaves a delegation tool without a worktree line untouched and reads no setting', () => {
    const tool: ToolDefinition = {
      name: 'delegate_workflow',
      description:
        'Delegate to a workflow agent.\n\nAvailable agents: loaded from the active roster at runtime.',
    };

    expect(withDelegationWorktreeAvailability(tool)).toBe(tool);
    expect(mocks.isWorktreeSupportEnabled).not.toHaveBeenCalled();
  });

  it('leaves non-delegation tools untouched', () => {
    const tool: ToolDefinition = {
      name: 'read_file',
      description: WORKTREE_PLACEHOLDER,
    };

    expect(withDelegationWorktreeAvailability(tool)).toBe(tool);
  });
});

describe('resolveAgentTools worktree annotation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getVisibleAgents.mockReturnValue([
      { name: 'research', description: 'Derive and verify.' },
    ]);
    mocks.computeModelOptionsData.mockResolvedValue([
      {
        value: 'deepseekT',
        label: 'DeepSeek',
        disabled: false,
        requiresKey: false,
      },
    ]);
  });

  async function resolveDelegateAgentDescription(): Promise<
    string | undefined
  > {
    const { tools } = await resolveAgentTools({
      tools: [
        {
          name: 'delegate_agent',
          availabilityCategory: 'toolUse',
          description: DELEGATE_AGENT_DESCRIPTION,
        },
      ],
      registry: new MapToolRegistry({
        delegate_agent: {
          definition: { name: 'delegate_agent' },
          call: async () => ({ status: 'executed', summary: '', output: '' }),
        },
      }),
      logger: { warn: () => {} },
      toolInjections: new ToolInjectionRegistry(),
    });
    return tools.find((t) => t.name === 'delegate_agent')?.description;
  }

  it.each([
    {
      enabled: true,
      expected: 'Git worktree support: ENABLED.',
    },
    {
      enabled: false,
      expected: 'Git worktree support: DISABLED in this workspace.',
    },
  ])(
    'resolves the worktree line at the resolveAgentTools boundary ($expected)',
    async ({ enabled, expected }) => {
      mocks.isWorktreeSupportEnabled.mockReturnValue(enabled);

      const description = await resolveDelegateAgentDescription();
      expect(description).toContain(expected);
      expect(description).not.toContain(
        'resolved from the active workspace at runtime',
      );
    },
  );
});
