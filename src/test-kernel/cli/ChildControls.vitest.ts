import { describe, expect, it } from 'vitest';

import {
  childElapsed,
  numericFocusTargetForActiveStream,
  resolveChildListTarget,
} from '@cli/chat/tui/state/childControls';
import { emptySlice, type StreamSlice } from '@cli/chat/tui/state/cliState';
import {
  streamTreeEntries,
  streamTreeViews,
} from '@cli/chat/tui/state/streamViews';
import {
  STREAM_PHASE,
  type ActiveChildInfo,
  type StreamPhase,
  type StreamTabId,
} from '@shared/schemas';
import { buildChildRosters } from '@test/support/childStreamEntries';

const root = 'root' as StreamTabId;
const child = 'child' as StreamTabId;
const leaf = 'leaf' as StreamTabId;

function slice(overrides: Partial<StreamSlice> = {}): StreamSlice {
  return { ...emptySlice(root), ...overrides };
}

/** A live agent roster row whose execution id follows its name. */
function rosterChild(
  agentName: string,
  childStreamId: StreamTabId,
  overrides: Partial<ActiveChildInfo> = {},
): ActiveChildInfo {
  return {
    executionId: `${agentName}-exec`,
    agentName,
    identity: { kind: 'agent' as const, agent: agentName },
    childStreamId,
    status: STREAM_PHASE.RUNNING,
    ...overrides,
  };
}

function streamMap(
  ...entries: ReadonlyArray<readonly [StreamTabId, StreamPhase?]>
): Map<StreamTabId, StreamSlice> {
  return new Map(
    entries.map(
      ([streamId, status]) => [streamId, slice({ streamId, status })] as const,
    ),
  );
}

describe('CLI child controls', () => {
  it('updates live elapsed time only for running children', () => {
    expect(
      childElapsed(
        {
          startedAt: 1_000,
          status: STREAM_PHASE.RUNNING,
          elapsed: undefined,
        },
        63_000,
      ),
    ).toBe('1m 2s');
    expect(
      childElapsed({
        startedAt: 1_000,
        status: STREAM_PHASE.COMPLETED,
        elapsed: '9s',
      }),
    ).toBe('9s');
  });

  it('resolves one child-list target and falls back to its immediate ancestor', () => {
    const entries = buildChildRosters({
      parentStreamId: root,
      rows: [
        rosterChild('critic', child, {
          status: STREAM_PHASE.COMPLETED,
          finishedAt: 1,
        }),
      ],
    });
    const streams = streamMap([root], [child, STREAM_PHASE.COMPLETED], [leaf]);
    const parentStream = new Map<StreamTabId, StreamTabId>([
      [child, root],
      [leaf, child],
    ]);

    expect(
      resolveChildListTarget({
        activeStreamId: leaf,
        childRosters: entries,
        parentStream,
        streams,
      }),
    ).toMatchObject({
      streamId: root,
      slice: streams.get(root),
    });
  });

  it('roots nested child-list rows at the resolved target stream', () => {
    const entries = new Map([
      ...buildChildRosters({
        parentStreamId: root,
        rows: [rosterChild('child', child)],
      }),
      ...buildChildRosters({
        parentStreamId: child,
        rows: [rosterChild('leaf', leaf)],
      }),
    ]);
    const streams = streamMap(
      [root],
      [child, STREAM_PHASE.RUNNING],
      [leaf, STREAM_PHASE.RUNNING],
    );
    const parentStream = new Map<StreamTabId, StreamTabId>([
      [child, root],
      [leaf, child],
    ]);
    const target = resolveChildListTarget({
      activeStreamId: child,
      childRosters: entries,
      parentStream,
      streams,
    });

    expect(target.streamId).toBe(child);
    expect(
      streamTreeViews({
        activeStreamId: child,
        childRosters: entries,
        parentStream,
        rootStreamId: target.streamId,
        streams,
      }).map((view) => view.id),
    ).toEqual([child, leaf]);

    expect(
      numericFocusTargetForActiveStream({
        activeStreamId: child,
        childRosters: entries,
        parentStream,
        streams,
        zeroBasedIndex: 0,
      }),
    ).toBe(leaf);
  });

  // Row order is newest-first over the shared roster and nothing else: a
  // child's workflow phase never regroups or reorders the list, so the
  // Alt+1..9 numbers follow the rows exactly as the tree yields them.
  it('assigns visible shortcut indices in newest-first roster order', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'].map((id) => id as StreamTabId);
    const [a, b, c, d, e] = ids;
    const entries = buildChildRosters({
      parentStreamId: root,
      rows: [
        rosterChild('a', a, { workflowPhase: 'Reduce' }),
        rosterChild('b', b, { workflowPhase: 'Map' }),
        rosterChild('c', c, { workflowPhase: 'Reduce' }),
        rosterChild('d', d),
        rosterChild('e', e, { workflowPhase: 'Map' }),
      ],
    });
    const streams = streamMap(
      [root],
      ...ids.map((id) => [id, STREAM_PHASE.RUNNING] as const),
    );
    const parentStream = new Map(
      ids.filter((id) => id !== b).map((id) => [id, root] as const),
    );

    // Roster order oldest-first (a…e), reversed for display; the
    // `Map`/`Reduce` tags on the roster rows do not move anybody.
    expect(
      streamTreeEntries({
        activeStreamId: root,
        childRosters: entries,
        parentStream,
        rootStreamId: root,
        streams,
      }),
    ).toEqual([
      { id: root },
      { id: e, shortcutIndex: 1 },
      { id: d, shortcutIndex: 2 },
      { id: c, shortcutIndex: 3 },
      { id: b, shortcutIndex: 4 },
      { id: a, shortcutIndex: 5 },
    ]);
    const views = streamTreeViews({
      activeStreamId: root,
      childRosters: entries,
      parentStream,
      rootStreamId: root,
      streams,
    });
    expect(views.map(({ id }) => id)).toEqual([root, e, d, c, b, a]);
    // `b` has no parent edge yet still rides the roster order.
    expect(views.find(({ id }) => id === b)).toMatchObject({
      parentId: undefined,
    });
    expect(
      numericFocusTargetForActiveStream({
        activeStreamId: root,
        childRosters: entries,
        parentStream,
        streams,
        zeroBasedIndex: 3,
      }),
    ).toBe(b);
  });

  it('preserves Alt/Esc-number stream focus order', () => {
    const entries = buildChildRosters({
      parentStreamId: root,
      rows: [rosterChild('critic', child)],
    });
    const streams = streamMap([root], [child, STREAM_PHASE.RUNNING]);

    expect(
      numericFocusTargetForActiveStream({
        activeStreamId: root,
        childRosters: entries,
        parentStream: new Map([[child, root]]),
        streams,
        zeroBasedIndex: 0,
      }),
    ).toBe(child);
  });
});
