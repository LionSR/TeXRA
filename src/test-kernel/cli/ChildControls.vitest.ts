import { describe, expect, it } from 'vitest';

import {
  childElapsed,
  numericFocusTargetForActiveStream,
  resolveChildListTarget,
} from '@cli/chat/tui/state/childControls';
import { emptySlice, type StreamSlice } from '@cli/chat/tui/state/cliState';
import {
  groupWorkflowPhaseEntries,
  streamTreeEntries,
  streamTreeViews,
} from '@cli/chat/tui/state/streamViews';
import {
  STREAM_PHASE,
  type StreamPhase,
  type StreamTabId,
} from '@shared/schemas';
import {
  buildChildStreamEntries,
  type ChildStreamEntryRow,
} from '@test/support/childStreamEntries';

const root = 'root' as StreamTabId;
const child = 'child' as StreamTabId;
const leaf = 'leaf' as StreamTabId;

function slice(overrides: Partial<StreamSlice> = {}): StreamSlice {
  return { ...emptySlice(root), ...overrides };
}

/** A running retained agent row whose execution id follows its name. */
function retainedChild(
  agentName: string,
  childStreamId: StreamTabId,
  overrides: Partial<ChildStreamEntryRow> = {},
): ChildStreamEntryRow {
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
    const entries = buildChildStreamEntries({
      parentStreamId: root,
      retained: [
        retainedChild('critic', child, { status: STREAM_PHASE.COMPLETED }),
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
        childStreamEntries: entries,
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
      ...buildChildStreamEntries({
        parentStreamId: root,
        retained: [retainedChild('child', child)],
      }),
      ...buildChildStreamEntries({
        parentStreamId: child,
        retained: [retainedChild('leaf', leaf)],
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
      childStreamEntries: entries,
      parentStream,
      streams,
    });

    expect(target.streamId).toBe(child);
    expect(
      streamTreeViews({
        activeStreamId: child,
        childStreamEntries: entries,
        parentStream,
        rootStreamId: target.streamId,
        streams,
      }).map((view) => view.id),
    ).toEqual([child, leaf]);

    expect(
      numericFocusTargetForActiveStream({
        activeStreamId: child,
        childStreamEntries: entries,
        parentStream,
        streams,
        zeroBasedIndex: 0,
      }),
    ).toBe(leaf);
  });

  it('returns phase-less ordering unchanged', () => {
    const ordered = [
      { id: 'newest', workflowPhase: undefined },
      { id: 'oldest', workflowPhase: undefined },
    ] as const;

    expect(groupWorkflowPhaseEntries(ordered)).toBe(ordered);
  });

  // A header opens a group and nothing closes one, so an untagged row left
  // between or after groups would render under a phase it is not part of.
  it('partitions untagged rows ahead of every phase group', () => {
    expect(
      groupWorkflowPhaseEntries([
        { id: 'a', workflowPhase: 'Map' },
        { id: 'b', workflowPhase: undefined },
        { id: 'c', workflowPhase: 'Map' },
        { id: 'd', workflowPhase: undefined },
        { id: 'e', workflowPhase: 'Reduce' },
      ]).map(({ id }) => id),
    ).toEqual(['b', 'd', 'a', 'c', 'e']);
  });

  it('stably groups phases before assigning visible shortcut indices', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'].map((id) => id as StreamTabId);
    const [a, b, c, d, e] = ids as [
      StreamTabId,
      StreamTabId,
      StreamTabId,
      StreamTabId,
      StreamTabId,
    ];
    const entries = buildChildStreamEntries({
      parentStreamId: root,
      retained: [
        retainedChild('a', a, { workflowPhase: 'Reduce' }),
        retainedChild('b', b, {
          workflowPhase: 'Map',
          edgeParentStreamId: null,
        }),
        retainedChild('c', c, { workflowPhase: 'Reduce' }),
        retainedChild('d', d),
        retainedChild('e', e, { workflowPhase: 'Map' }),
      ],
    });
    const streams = streamMap(
      [root],
      ...ids.map((id) => [id, STREAM_PHASE.RUNNING] as const),
    );
    const parentStream = new Map(
      ids.filter((id) => id !== b).map((id) => [id, root] as const),
    );

    expect(
      streamTreeEntries({
        activeStreamId: root,
        childStreamEntries: entries,
        parentStream,
        rootStreamId: root,
        streams,
      }),
      // `d` carries no phase, so it heads the list rather than trailing the
      // `Map` group, whose header would otherwise appear to own it.
    ).toEqual([
      { id: root },
      { id: d, shortcutIndex: 1 },
      { id: e, shortcutIndex: 2 },
      { id: b, shortcutIndex: 3 },
      { id: c, shortcutIndex: 4 },
      { id: a, shortcutIndex: 5 },
    ]);
    const views = streamTreeViews({
      activeStreamId: root,
      childStreamEntries: entries,
      parentStream,
      rootStreamId: root,
      streams,
    });
    expect(views.map(({ id }) => id)).toEqual([root, d, e, b, c, a]);
    expect(views.find(({ id }) => id === b)).toMatchObject({
      parentId: undefined,
      shortcutIndex: 3,
      workflowPhase: 'Map',
    });
    expect(
      numericFocusTargetForActiveStream({
        activeStreamId: root,
        childStreamEntries: entries,
        parentStream,
        streams,
        zeroBasedIndex: 2,
      }),
    ).toBe(b);
  });

  it('preserves Alt/Esc-number stream focus order', () => {
    const entries = buildChildStreamEntries({
      parentStreamId: root,
      retained: [retainedChild('critic', child)],
    });
    const streams = streamMap([root], [child, STREAM_PHASE.RUNNING]);

    expect(
      numericFocusTargetForActiveStream({
        activeStreamId: root,
        childStreamEntries: entries,
        parentStream: new Map([[child, root]]),
        streams,
        zeroBasedIndex: 0,
      }),
    ).toBe(child);
  });
});
