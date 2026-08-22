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
    {
      category: 'toolUse',
      source: 'custom',
      name: 'child',
      description: 'Current delegated child',
      tools: ['delegate_agent'],
      path: '/agents/child.yaml',
    },
    {
      category: 'toolUse',
      source: 'remote',
      name: 'child',
      description: 'Same-name leaf specialist',
      tools: ['read_file'],
      path: '/agents/remote-child.yaml',
    },
    {
      category: 'toolUse',
      source: 'custom',
      name: 'coder',
      description: 'Leaf specialist',
      tools: ['read_file'],
      path: '/agents/coder.yaml',
    },
    {
      category: 'toolUse',
      source: 'custom',
      name: 'lead',
      description: 'Delegation-capable lead',
      tools: ['delegate_agent'],
      path: '/agents/lead.yaml',
    },
    {
      category: 'workflow',
      source: 'custom',
      name: 'child',
      description: 'Same-name workflow agent',
      path: '/agents/child-workflow.yaml',
    },
  ],
}));

// buildUserVars formats resolveDelegationScopeAgents (tested in agentRegistry)
// into WORKFLOW_AGENTS/TOOL_USE_AGENTS; mock the resolver with the fixture
// mapping rather than re-implementing its priority/dedup logic.
vi.mock('@agent/index/agentRegistry', () => ({
  resolveDelegationScopeAgents: (
    scope: { workflow: string[]; toolUse: string[] } | undefined,
    category: 'workflow' | 'toolUse',
  ) => {
    if (!scope) return roster.entries.filter((e) => e.category === category);
    const keys = scope[category];
    return keys.flatMap((key) => {
      const entry = roster.entries.find(
        (e) => e.category === category && `${e.source}:${e.name}` === key,
      );
      return entry ? [entry] : [];
    });
  },
}));

import { noopTrace } from '@agent/trace';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  AgentPromptSchema,
  AgentToolUseSettingSchema,
  AgentWorkflowSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { buildUserVars } from '@agent/prompt/userVars';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { createRunScope } from '@agent/runtime/RunScope';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { AgentCategory } from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';

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
          workflow: ['builtInWorkflow:scoped-writer'],
          toolUse: ['remote:scoped-reviewer'],
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

  it('builds a fresh child prompt from immutable identity and lineage before a handle exists', async () => {
    const delegationAgentScope = {
      workflow: ['custom:child'],
      toolUse: ['custom:child', 'remote:child', 'custom:coder', 'custom:lead'],
    };
    const runScope = createRunScope({
      streamId: 'child-stream',
      executionId: 'child-execution',
      agentName: 'child',
      agentKey: 'custom:child',
      isSubagent: true,
      delegationAgentScope,
      session: {} as SessionHandle,
      signal: new AbortController().signal,
    });

    const vars = await withRunContext(createRunContext({ runScope }), () =>
      buildUserVars(
        AgentConfigSchema.parse({ agent: 'child', model: 'test-model' }),
        AgentToolUseSettingSchema.parse({
          agentCategory: AgentCategory.ToolUse,
        }),
        AgentPromptSchema.parse({}),
        '/agents/child',
        { isOpenai: false, isAnthropic: false, isGoogle: false },
        noopTrace,
        { delegationAgentScope },
      ),
    );

    expect(vars.TOOL_USE_AGENTS).toContain(
      '- child: Same-name leaf specialist [read_file]',
    );
    expect(vars.TOOL_USE_AGENTS).toContain(
      '- coder: Leaf specialist [read_file]',
    );
    expect(vars.TOOL_USE_AGENTS).not.toContain('Current delegated child');
    expect(vars.TOOL_USE_AGENTS).not.toContain('Delegation-capable lead');
    expect(vars.WORKFLOW_AGENTS).toBe('- child: Same-name workflow agent');
  });
});
