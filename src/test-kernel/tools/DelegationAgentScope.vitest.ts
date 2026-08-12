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
const workflowCorrect = {
  category: 'workflow',
  source: 'builtInWorkflow',
  name: 'correct',
  path: '/agents/correct.yaml',
} as const;
const mocks = vi.hoisted(() => ({
  context: undefined as unknown,
  resolutionCalls: [] as string[],
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
      mocks.resolutionCalls.push(category);
      if (!scope) {
        return category === 'workflow' ? [workflowCorrect] : [customReview];
      }
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
const { requireVisibleAgent, requireWorkflowOrToolUseAgent } =
  await import('@tools/delegation/proposalFlow');

describe('execution-scoped delegation agents', () => {
  beforeEach(() => {
    mocks.resolutionCalls = [];
    mocks.context = {
      kind: 'launch',
      runScope: {
        delegationAgentScope: {
          workflow: [],
          toolUse: ['remote:review'],
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
      workflow: [],
      toolUse: ['remote:review'],
    };

    expect(getDelegationAgents('toolUse', scope)).toEqual([remoteReview]);
    expect(getDelegationAgent('toolUse', 'review', scope)).toBe(remoteReview);
    expect(
      getDelegationAgent('toolUse', 'custom:review', scope),
    ).toBeUndefined();
  });

  it('falls back to the workspace-visible roster with no scope at all', () => {
    mocks.context = undefined;

    expect(getDelegationAgents('toolUse')).toEqual([customReview]);
    expect(getDelegationAgent('toolUse', 'review')).toBe(customReview);
  });

  it('resolves a cross-category target without exception fallback', () => {
    mocks.context = undefined;

    expect(requireWorkflowOrToolUseAgent('review')).toEqual({
      agent: customReview,
      category: 'toolUse',
    });
    expect(requireWorkflowOrToolUseAgent('correct')).toEqual({
      agent: workflowCorrect,
      category: 'workflow',
    });
  });

  it('reports both category catalogs when a cross-category target is missing', () => {
    mocks.context = undefined;

    expect(() => requireWorkflowOrToolUseAgent('missing')).toThrow(
      "Unknown workflow or toolUse agent 'missing'. Available: workflow: correct; toolUse: review",
    );
  });

  it('uses one candidate set for visible-agent resolution and its error', () => {
    mocks.context = undefined;

    expect(requireVisibleAgent('toolUse', 'review')).toBe(customReview);
    expect(mocks.resolutionCalls).toEqual(['toolUse']);
    mocks.resolutionCalls = [];
    expect(() => requireVisibleAgent('toolUse', 'missing')).toThrow(
      "Unknown toolUse agent 'missing'. Available: review",
    );
    expect(mocks.resolutionCalls).toEqual(['toolUse']);
  });
});
