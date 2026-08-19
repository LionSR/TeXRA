import { describe, expect, it } from 'vitest';

import {
  computeStreamTreeProjection,
  type StreamTreeExpansionOverride,
  type StreamTreeProjection,
} from '@progressView/frontend/streamTree';
import { AgentCategory, type StreamTabInfo } from '@shared/schemas';

function stream(name: string, parentStreamId?: string): StreamTabInfo {
  return {
    identity: { kind: 'agent', agent: name },
    name,
    label: name,
    agentCategory: AgentCategory.ToolUse,
    creationTimestamp: 0,
    ...(parentStreamId && { parentStreamId }),
  };
}

function project(
  childStreamsByParent: Map<string, StreamTabInfo[]>,
  userOverrides: Map<string, StreamTreeExpansionOverride> = new Map(),
  pendingApprovalStreamIds: ReadonlySet<string> = new Set(),
  activeStreamId: string | null = null,
): StreamTreeProjection {
  return computeStreamTreeProjection({
    childStreamsByParent,
    userOverrides,
    pendingApprovalStreamIds,
    activeStreamId,
  });
}

describe('progress stream tree policy', () => {
  it('starts a parent collapsed while a child has not reported status yet', () => {
    const childStreamsByParent = new Map([['root', [stream('child', 'root')]]]);

    const projection = project(childStreamsByParent);

    expect(projection.expandedParents.has('root')).toBe(false);
  });

  it('collapses a parent once every child branch is finished', () => {
    const childStreamsByParent = new Map([
      ['root', [stream('child-a', 'root'), stream('child-b', 'root')]],
    ]);
    const projection = project(childStreamsByParent);

    expect(projection.expandedParents.has('root')).toBe(false);
  });

  it('keeps ancestors collapsed when a descendant is active', () => {
    const childStreamsByParent = new Map([
      ['root', [stream('child', 'root')]],
      ['child', [stream('grandchild', 'child')]],
    ]);
    const projection = project(childStreamsByParent);

    expect(projection.expandedParents.has('root')).toBe(false);
    expect(projection.expandedParents.has('child')).toBe(false);
  });

  it('honors user overrides and drops overrides for missing parents', () => {
    const childStreamsByParent = new Map([['root', [stream('child', 'root')]]]);
    const projection = project(
      childStreamsByParent,
      new Map([
        ['root', 'collapsed'],
        ['stale-parent', 'expanded'],
      ]),
    );

    expect(projection.expandedParents.has('root')).toBe(false);
    expect([...projection.userOverrides]).toStrictEqual([
      ['root', 'collapsed'],
    ]);
  });

  it('allows users to keep a finished parent expanded', () => {
    const childStreamsByParent = new Map([['root', [stream('child', 'root')]]]);
    const projection = project(
      childStreamsByParent,
      new Map([['root', 'expanded']]),
    );

    expect(projection.expandedParents.has('root')).toBe(true);
  });

  it('expands and badges ancestors when a descendant needs approval', () => {
    const childStreamsByParent = new Map([
      ['root', [stream('child', 'root')]],
      ['child', [stream('grandchild', 'child')]],
    ]);

    const projection = project(
      childStreamsByParent,
      new Map([['root', 'collapsed']]),
      new Set(['grandchild']),
    );

    expect(projection.expandedParents.has('root')).toBe(true);
    expect(projection.expandedParents.has('child')).toBe(true);
    expect(projection.approvalBadgeStreamIds.has('root')).toBe(true);
    expect(projection.approvalBadgeStreamIds.has('child')).toBe(true);
    expect(projection.approvalBadgeStreamIds.has('grandchild')).toBe(true);
  });

  it('expands ancestors of the viewed stream without opening sibling branches', () => {
    const childStreamsByParent = new Map([
      ['root', [stream('child', 'root'), stream('other', 'root')]],
      ['child', [stream('grandchild', 'child')]],
      ['other', [stream('other-child', 'other')]],
    ]);

    const projection = project(
      childStreamsByParent,
      new Map([['root', 'collapsed']]),
      new Set(),
      'grandchild',
    );

    expect(projection.expandedParents.has('root')).toBe(true);
    expect(projection.expandedParents.has('child')).toBe(true);
    expect(projection.expandedParents.has('other')).toBe(false);
    expect(projection.approvalBadgeStreamIds.size).toBe(0);
  });

  it('does not expand a parent just because it is the active stream', () => {
    const childStreamsByParent = new Map([['root', [stream('child', 'root')]]]);

    const projection = project(
      childStreamsByParent,
      new Map(),
      new Set(),
      'root',
    );

    expect(projection.expandedParents.has('root')).toBe(false);
  });
});
