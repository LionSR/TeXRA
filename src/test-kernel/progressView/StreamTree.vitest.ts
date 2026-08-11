import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

import {
  computeStreamTreeProjection,
  getStreamBranchActivity,
  type StreamTreeExpansionOverride,
  type StreamTreeProjection,
} from '@progressView/frontend/streamTree';
import {
  AgentCategory,
  createStreamState,
  STREAM_PHASE,
  STREAM_STATUS,
  type StreamLifecycleStatus,
  type StreamState,
  type StreamTabInfo,
} from '@shared/schemas';

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

function streamState(status: StreamLifecycleStatus): StreamState {
  return createStreamState(AgentCategory.ToolUse, { status });
}

function project(
  childStreamsByParent: Map<string, StreamTabInfo[]>,
  streamStates: Map<string, StreamState> = new Map(),
  userOverrides: Map<string, StreamTreeExpansionOverride> = new Map(),
): StreamTreeProjection {
  return computeStreamTreeProjection({
    streamStates,
    childStreamsByParent,
    userOverrides,
  });
}

describe('progress stream tree policy', () => {
  it('keeps a parent expanded while a child has not reported status yet', () => {
    const childStreamsByParent = new Map([['root', [stream('child', 'root')]]]);

    const projection = project(childStreamsByParent);

    assert.equal(projection.expandedParents.has('root'), true);
    assert.equal(
      getStreamBranchActivity(
        { streamStates: new Map(), childStreamsByParent },
        'child',
      ),
      'unknown',
    );
  });

  it('collapses a parent once every child branch is finished', () => {
    const childStreamsByParent = new Map([
      ['root', [stream('child-a', 'root'), stream('child-b', 'root')]],
    ]);
    const streamStates = new Map([
      ['child-a', streamState(STREAM_PHASE.CANCELLED)],
      ['child-b', streamState(STREAM_PHASE.FAILED)],
    ]);

    const projection = project(childStreamsByParent, streamStates);

    assert.equal(projection.expandedParents.has('root'), false);
    assert.equal(projection.branchActivityByStream.get('child-a'), 'finished');
    assert.equal(projection.branchActivityByStream.get('child-b'), 'finished');
  });

  it('expands ancestors when a descendant is active', () => {
    const childStreamsByParent = new Map([
      ['root', [stream('child', 'root')]],
      ['child', [stream('grandchild', 'child')]],
    ]);
    const streamStates = new Map([
      ['child', streamState(STREAM_PHASE.CANCELLED)],
      ['grandchild', streamState(STREAM_STATUS.RUNNING)],
    ]);

    const projection = project(childStreamsByParent, streamStates);

    assert.equal(projection.expandedParents.has('root'), true);
    assert.equal(projection.expandedParents.has('child'), true);
    assert.equal(projection.branchActivityByStream.get('child'), 'active');
    assert.equal(projection.branchActivityByStream.get('grandchild'), 'active');
  });

  it('honors user overrides and drops overrides for missing parents', () => {
    const childStreamsByParent = new Map([['root', [stream('child', 'root')]]]);
    const streamStates = new Map([
      ['child', streamState(STREAM_STATUS.RUNNING)],
    ]);

    const projection = project(
      childStreamsByParent,
      streamStates,
      new Map([
        ['root', 'collapsed'],
        ['stale-parent', 'expanded'],
      ]),
    );

    assert.equal(projection.expandedParents.has('root'), false);
    assert.deepEqual([...projection.userOverrides], [['root', 'collapsed']]);
  });

  it('allows users to keep a finished parent expanded', () => {
    const childStreamsByParent = new Map([['root', [stream('child', 'root')]]]);
    const streamStates = new Map([
      ['child', streamState(STREAM_PHASE.CANCELLED)],
    ]);

    const projection = project(
      childStreamsByParent,
      streamStates,
      new Map([['root', 'expanded']]),
    );

    assert.equal(projection.expandedParents.has('root'), true);
  });

  it('guards cycles while preserving the stream own activity', () => {
    const childStreamsByParent = new Map([
      ['root', [stream('child', 'root')]],
      ['child', [stream('root', 'child')]],
    ]);
    const streamStates = new Map([
      ['root', streamState(STREAM_PHASE.CANCELLED)],
      ['child', streamState(STREAM_PHASE.CANCELLED)],
    ]);

    assert.equal(
      getStreamBranchActivity(
        { streamStates, childStreamsByParent },
        'child',
        new Set(['root']),
      ),
      'finished',
    );
  });

  it('guards direct self-loops', () => {
    const childStreamsByParent = new Map([['root', [stream('root', 'root')]]]);
    const streamStates = new Map([
      ['root', streamState(STREAM_PHASE.CANCELLED)],
    ]);

    assert.equal(
      getStreamBranchActivity(
        { streamStates, childStreamsByParent },
        'root',
        new Set(['root']),
      ),
      'finished',
    );
  });
});
