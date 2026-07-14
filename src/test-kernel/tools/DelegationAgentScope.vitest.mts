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

const mocks = vi.hoisted(() => ({
  context: undefined as unknown,
}));

vi.mock('@agent/runtime/RunContext', () => ({
  tryUseRunContext: () => mocks.context,
}));

vi.mock('@agent/index/agentRegistry', () => ({
  findAgentByIdentifier: (
    entries: Array<{ source: string; name: string }>,
    identifier: string,
  ) => entries.find((entry) => agentMatchesIdentifier(entry, identifier)),
  getAgent: (identifier: string) => {
    if (identifier === 'remote:review') return remoteReview;
    if (identifier === 'custom:review' || identifier === 'review') {
      return customReview;
    }
    return undefined;
  },
  getCategoryAgent: (_category: string, identifier: string) =>
    identifier === 'review' ? customReview : undefined,
  getVisibleAgent: () => customReview,
  getVisibleAgents: () => [customReview],
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
});
