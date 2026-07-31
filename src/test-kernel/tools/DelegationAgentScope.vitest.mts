import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  agentKeyOf,
  agentMatchesIdentifier,
  agentName,
} from '@shared/schemas/agent';

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
const mocks = vi.hoisted(() => ({
  context: undefined as unknown,
}));

vi.mock('@agent/runtime/RunContext', () => ({
  tryUseRunContext: () => mocks.context,
}));

// `resolveDelegationScopeAgents` and `resolveWithinCategory` are the single
// sources of truth for scope resolution and identity matching (agentRegistry.ts)
// — this test only exercises which candidate set and resolver
// delegationAgentAvailability.ts feeds them, so the mock reproduces just this
// scope's expected resolution rather than re-implementing priority/dedup logic
// that belongs to agentRegistry's own tests.
vi.mock('@agent/index/agentRegistry', () => {
  const aliasTarget = (identifier: string) => {
    if (identifier === 'remote:review') return remoteReview;
    if (identifier === 'custom:review' || identifier === 'review') {
      return customReview;
    }
    return undefined;
  };
  return {
    getVisibleAgent: () => customReview,
    resolveDelegationScopeAgents: (
      scope: { toolUseAgentKeys: readonly string[] } | undefined,
      category: string,
    ) =>
      scope &&
      category === 'toolUse' &&
      scope.toolUseAgentKeys.includes('remote:review')
        ? [remoteReview]
        : [],
    resolveWithinCategory: (
      entries: Array<{ source: string; name: string }>,
      _category: string,
      identifier: string,
    ) => {
      const exact = entries.find((entry) =>
        agentMatchesIdentifier(entry, identifier),
      );
      if (exact) return exact;
      const alias = aliasTarget(identifier);
      if (!alias) return undefined;
      const mapped =
        identifier === agentName(identifier) ? alias.name : agentKeyOf(alias);
      return entries.find((entry) => agentMatchesIdentifier(entry, mapped));
    },
  };
});

const { getDelegationAgent, getDelegationAgentForScope, getDelegationAgents } =
  await import('@tools/delegationAgentAvailability');

describe('execution-scoped delegation agents', () => {
  beforeEach(() => {
    mocks.context = {
      kind: 'launch',
      runScope: {
        delegationAgentScope: {
          workflowAgentKeys: [],
          toolUseAgentKeys: ['remote:review'],
        },
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
    const scope = {
      workflowAgentKeys: [],
      toolUseAgentKeys: ['remote:review'],
    };

    expect(getDelegationAgentForScope('toolUse', 'review', scope)).toBe(
      remoteReview,
    );
    expect(
      getDelegationAgentForScope('toolUse', 'custom:review', scope),
    ).toBeUndefined();
  });
});
