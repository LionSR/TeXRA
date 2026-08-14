import { beforeEach, describe, expect, it, vi } from 'vitest';

import { agentMatchesIdentifier } from '@shared/schemas/agent';

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
const remoteReviewScope = {
  workflow: [],
  toolUse: ['remote:review'],
};
const mocks = vi.hoisted(() => ({
  context: undefined as unknown,
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
      if (!scope) return [customReview];
      return category === 'toolUse' && scope.toolUse.includes('remote:review')
        ? [remoteReview]
        : [];
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
});
