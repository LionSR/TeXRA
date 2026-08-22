import { beforeEach, describe, expect, it, vi } from 'vitest';

import { agentMatchesIdentifier } from '@shared/schemas';

const remoteReview = {
  category: 'toolUse',
  source: 'remote',
  name: 'review',
  path: '/agents/remote-review.yaml',
} as const;
const customReview = {
  category: 'toolUse',
  source: 'custom',
  name: 'review',
  path: '/agents/custom-review.yaml',
} as const;
const lead = {
  category: 'toolUse',
  source: 'custom',
  name: 'lead',
  path: '/agents/lead.yaml',
  tools: ['delegate_agent'],
} as const;
const remoteLead = {
  category: 'toolUse',
  source: 'remote',
  name: 'lead',
  path: '/agents/remote-lead.yaml',
  tools: ['read_file'],
} as const;
const leaf = {
  category: 'toolUse',
  source: 'custom',
  name: 'leaf',
  path: '/agents/leaf.yaml',
  tools: ['read_file'],
} as const;
const workflow = {
  category: 'workflow',
  source: 'custom',
  name: 'child',
  path: '/agents/child-workflow.yaml',
} as const;
const remoteReviewScope = {
  workflow: [],
  toolUse: ['remote:review'],
};
const mocks = vi.hoisted(() => ({
  context: undefined as unknown,
  agents: [] as unknown[],
}));

vi.mock('@agent/runtime/RunContext', () => ({
  tryUseRunContext: () => mocks.context,
}));

// `resolveDelegationScopeAgents` and `findAgentByIdentifier` are the single
// sources of truth for scope resolution and identity matching (agentRegistry.ts)
// — this test only exercises which candidate set and resolver
// delegationAvailability.ts feeds them, so the mock reproduces just this
// scope's expected resolution rather than re-implementing priority/dedup logic
// that belongs to agentRegistry's own tests. A scopeless call resolves the
// workspace-visible roster, exactly as agentRegistry does.
vi.mock('@agent/index/agentRegistry', () => {
  return {
    resolveDelegationScopeAgents: (
      scope: { toolUse: readonly string[] } | undefined,
      category: string,
    ) => {
      if (!scope)
        return mocks.agents.length > 0 ? mocks.agents : [customReview];
      return category === 'toolUse' && scope.toolUse.includes('remote:review')
        ? [remoteReview]
        : mocks.agents.filter((agent: any) => agent.category === category);
    },
    findAgentByIdentifier: (
      entries: Array<{ source: string; name: string }>,
      identifier: string,
    ) => entries.find((entry) => agentMatchesIdentifier(entry, identifier)),
  };
});

const { getDelegationAgent, getDelegationAgents } =
  await import('@tools/delegation/delegationAvailability');

describe('execution-scoped delegation agents', () => {
  beforeEach(() => {
    mocks.agents = [];
    mocks.context = {
      kind: 'launch',
      runScope: {
        delegationAgentScope: remoteReviewScope,
      },
    };
  });

  it('preserves source identity when a higher-priority namesake exists', () => {
    expect(getDelegationAgents('toolUse')).toEqual([remoteReview]);
    expect(getDelegationAgent('toolUse', 'review')).toBe(remoteReview);
    expect(getDelegationAgent('toolUse', 'custom:review')).toBeUndefined();
  });

  it('can enforce a captured scope without ambient run context', () => {
    mocks.context = undefined;

    expect(getDelegationAgents('toolUse', remoteReviewScope)).toEqual([
      remoteReview,
    ]);
    expect(getDelegationAgent('toolUse', 'review', remoteReviewScope)).toBe(
      remoteReview,
    );
    expect(
      getDelegationAgent('toolUse', 'custom:review', remoteReviewScope),
    ).toBeUndefined();
  });

  it('falls back to the workspace-visible roster with no scope at all', () => {
    mocks.context = undefined;

    expect(getDelegationAgents('toolUse')).toEqual([customReview]);
    expect(getDelegationAgent('toolUse', 'review')).toBe(customReview);
  });

  it.each(['lead', 'custom:lead'])(
    'excludes only the exact current identity for launch identifier %s',
    (agentName) => {
      mocks.agents = [lead, remoteLead, leaf];
      mocks.context = {
        kind: 'launch',
        runScope: {
          agentName,
          agentKey: 'custom:lead',
          delegationAgentScope: {
            workflow: [],
            toolUse: ['custom:lead', 'remote:lead', 'custom:leaf'],
          },
          isSubagent: false,
        },
      };

      expect(getDelegationAgents('toolUse')).toEqual([remoteLead, leaf]);
      expect(getDelegationAgent('toolUse', 'custom:lead')).toBeUndefined();
      expect(getDelegationAgent('toolUse', 'remote:lead')).toBe(remoteLead);
    },
  );

  it('keeps leaf and workflow agents while excluding tool-use leads for a child', () => {
    mocks.agents = [lead, leaf, workflow];
    mocks.context = {
      kind: 'launch',
      runScope: {
        agentName: 'child',
        delegationAgentScope: {
          workflow: ['child'],
          toolUse: ['lead', 'leaf'],
        },
        agentKey: 'custom:child',
        isSubagent: true,
      },
    };

    expect(getDelegationAgents('toolUse')).toEqual([leaf]);
    expect(getDelegationAgent('toolUse', 'lead')).toBeUndefined();
    expect(getDelegationAgents('workflow')).toEqual([workflow]);
  });
});
