// Third-party imports
import { describe, expect, it, vi } from 'vitest';

const roster = vi.hoisted(() => ({
  entries: [
    {
      category: 'workflow',
      source: 'builtInWorkflow',
      name: 'scoped-writer',
      description: 'Scoped workflow agent',
      path: '/agents/scoped-writer.yaml',
    },
    {
      category: 'workflow',
      source: 'custom',
      name: 'outside-writer',
      description: 'Out-of-scope workflow agent',
      path: '/agents/outside-writer.yaml',
    },
    {
      category: 'toolUse',
      source: 'remote',
      name: 'scoped-reviewer',
      description: 'Scoped tool-use agent',
      tools: ['search', 'read_file'],
      path: '/agents/scoped-reviewer.yaml',
    },
    {
      category: 'toolUse',
      source: 'custom',
      name: 'outside-reviewer',
      description: 'Out-of-scope tool-use agent',
      path: '/agents/outside-reviewer.yaml',
    },
  ],
}));

// `resolveDelegationScopeAgents` is the single source of truth for scope
// resolution (agentRegistry.ts, tested there); this test only exercises how
// buildUserVars formats its result into WORKFLOW_AGENTS/TOOL_USE_AGENTS, so
// the mock reproduces the fixture's key-to-entry mapping rather than
// re-implementing the real resolver's priority/dedup logic.
vi.mock('@agent/index/agentRegistry', () => ({
  resolveDelegationScopeAgents: (
    scope:
      { workflowAgentKeys: string[]; toolUseAgentKeys: string[] } | undefined,
    category: string,
  ) => {
    if (!scope) return roster.entries.filter((e) => e.category === category);
    const keys =
      category === 'workflow'
        ? scope.workflowAgentKeys
        : scope.toolUseAgentKeys;
    return keys.flatMap((key) => {
      const entry = roster.entries.find(
        (e) => e.category === category && `${e.source}:${e.name}` === key,
      );
      return entry ? [entry] : [];
    });
  },
}));

// Local imports - test support
import { setupPlatform } from '@test/support/setupPlatform';

// Local imports - agent components
import { noopTrace } from '@agent/trace';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  AgentCategory,
  AgentPromptSchema,
  AgentWorkflowSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { buildUserVars } from '@agent/utils/userVars';

setupPlatform({ workspacePath: '/workspace' });

describe('buildUserVars delegation scope', () => {
  it('renders scoped agents and omits workspace-visible agents outside the run', async () => {
    const vars = await buildUserVars(
      AgentConfigSchema.parse({ agent: 'team-lead', model: 'test-model' }),
      AgentWorkflowSettingSchema.parse({
        agentCategory: AgentCategory.Workflow,
      }),
      AgentPromptSchema.parse({}),
      '/agents/team-lead',
      { isOpenai: false, isAnthropic: false, isGoogle: false },
      noopTrace,
      {
        delegationAgentScope: {
          workflowAgentKeys: ['builtInWorkflow:scoped-writer'],
          toolUseAgentKeys: ['remote:scoped-reviewer'],
        },
      },
    );

    expect(vars.WORKFLOW_AGENTS).toBe('- scoped-writer: Scoped workflow agent');
    expect(vars.TOOL_USE_AGENTS).toBe(
      '- scoped-reviewer: Scoped tool-use agent [search, read_file]',
    );
    expect(vars.WORKFLOW_AGENTS).not.toContain('outside-writer');
    expect(vars.TOOL_USE_AGENTS).not.toContain('outside-reviewer');
  });
});
