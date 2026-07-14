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
const internalReview = {
  category: 'toolUse',
  source: 'builtInToolUse',
  name: 'internalReview',
  path: '/agents/internal-review.yaml',
  internal: true,
} as const;

const mocks = vi.hoisted(() => ({
  context: undefined as unknown,
}));

vi.mock('@agent/runtime/RunContext', () => ({
  tryUseRunContext: () => mocks.context,
}));

// `resolveDelegationScopeAgents` is the single source of truth for scope
// resolution (agentRegistry.ts) — this test only exercises how
// delegationAgentAvailability.ts consumes its result, so the mock reproduces
// just this scope's expected resolution rather than re-implementing
// priority/dedup logic that belongs to agentRegistry's own tests.
vi.mock('@agent/index/agentRegistry', () => ({
  findAgentByIdentifier: (
    entries: Array<{ source: string; name: string }>,
    identifier: string,
  ) => entries.find((entry) => agentMatchesIdentifier(entry, identifier)),
  getAgent: (identifier: string) => {
    if (identifier === 'remote:review') return remoteReview;
    if (identifier === 'builtInToolUse:internalReview') return internalReview;
    if (identifier === 'custom:review' || identifier === 'review') {
      return customReview;
    }
    return undefined;
  },
  getVisibleAgent: () => customReview,
  resolveDelegationScopeAgents: (
    scope: { toolUseAgentKeys: readonly string[] } | undefined,
    category: string,
  ) =>
    scope && category === 'toolUse' && scope.toolUseAgentKeys.includes('remote:review')
      ? [remoteReview]
      : [],
}));

const { getDelegationAgent, getDelegationAgents } =
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

  it('excludes internal agents from an execution-scoped roster', () => {
    mocks.context = {
      kind: 'launch',
      runScope: {
        delegationAgentScope: {
          workflowAgentKeys: [],
          toolUseAgentKeys: ['remote:review', 'builtInToolUse:internalReview'],
        },
      },
    };

    expect(getDelegationAgents('toolUse')).toEqual([remoteReview]);
  });
});
