import { describe, expect, it } from 'vitest';

import {
  buildChildStreamEntries,
  type ChildStreamEntryRow,
} from '@test/support/childStreamEntries';
import { NO_BYPASS, type StreamSlice } from '@cli/chat/tui/state/cliState';
import {
  activeStreamParentOrSelfId,
  activeStreamScope,
  activeStreamTreeEntries,
  nearestActiveStreamAncestor,
} from '@cli/chat/tui/state/streamViews';
import {
  streamTabSegmentText,
  streamTabsLineSegments,
  streamTabsLineText,
  streamTabsDisplayItems,
} from '@cli/chat/tui/panes/StreamTabsStrip';
import { textDisplayWidth } from '@cli/chat/tui/render/terminalText';
import { STREAM_PHASE, type StreamTabId } from '@shared/schemas';

function streamId(value: string): StreamTabId {
  return value as StreamTabId;
}

function child(init: {
  readonly executionId: string;
  readonly childStreamId: string;
  readonly agentName?: string;
  readonly toolName?: string;
  readonly status?: string;
  readonly active?: boolean;
}): ChildStreamEntryRow {
  return {
    kind: 'subagent',
    executionId: init.executionId,
    agentName: init.agentName ?? '',
    childStreamId: streamId(init.childStreamId),
    toolName: init.toolName,
    status: init.status,
    active: init.active,
  };
}

function slice(
  streamIdValue: string,
  init: Partial<StreamSlice> = {},
): StreamSlice {
  return {
    streamId: streamId(streamIdValue),
    category: undefined,
    status: undefined,
    runStartedAt: undefined,
    description: undefined,
    thinkingActive: false,
    usage: undefined,
    cumulativeUsage: undefined,
    conversation: undefined,
    entries: [],
    queuedFollowUps: 0,
    queuedFollowUpMessages: [],
    activeProcesses: [],
    todos: [],
    plan: null,
    processOutput: new Map(),
    bypass: NO_BYPASS,
    ...init,
  };
}

const EMPTY_CHILD_STREAM_ENTRIES = buildChildStreamEntries({
  parentStreamId: streamId('root'),
});

describe('active stream scope', () => {
  it('owns the active stream child/root projection', () => {
    const root = streamId('root');
    const child1 = streamId('child-1');
    const parentStream = new Map<StreamTabId, StreamTabId>([[child1, root]]);

    expect(
      activeStreamScope({ activeStreamId: undefined, parentStream }),
    ).toEqual({ kind: 'none' });
    expect(activeStreamScope({ activeStreamId: root, parentStream })).toEqual({
      kind: 'root',
      streamId: root,
    });
    expect(activeStreamScope({ activeStreamId: child1, parentStream })).toEqual(
      {
        kind: 'child',
        parentStreamId: root,
        streamId: child1,
      },
    );

    expect(
      activeStreamParentOrSelfId({ activeStreamId: undefined, parentStream }),
    ).toBeUndefined();
    expect(
      activeStreamParentOrSelfId({ activeStreamId: root, parentStream }),
    ).toBe(root);
    expect(
      activeStreamParentOrSelfId({ activeStreamId: child1, parentStream }),
    ).toBe(root);
  });

  it('owns nearest active ancestor traversal', () => {
    const root = streamId('root');
    const child1 = streamId('child-1');
    const child2 = streamId('child-2');
    const grandchild = streamId('grandchild');
    const parentStream = new Map<StreamTabId, StreamTabId>([
      [child1, root],
      [child2, root],
      [grandchild, child1],
    ]);
    const values = new Map([
      [root, { usable: true }],
      [child1, { usable: false }],
      [child2, { usable: true }],
      [grandchild, { usable: false }],
    ]);

    expect(
      nearestActiveStreamAncestor({
        activeStreamId: grandchild,
        parentStream,
        values,
        canUseValue: (value) => value.usable,
      }),
    ).toEqual({ streamId: root, value: { usable: true } });
    expect(
      nearestActiveStreamAncestor({
        activeStreamId: child2,
        parentStream,
        values,
        canUseValue: (value) => value.usable,
      }),
    ).toEqual({ streamId: root, value: { usable: true } });
    expect(
      nearestActiveStreamAncestor({
        activeStreamId: undefined,
        parentStream,
        values,
        canUseValue: (value) => value.usable,
      }),
    ).toBeUndefined();
  });

  it('stops nearest active ancestor traversal at parent cycles', () => {
    const child1 = streamId('child-1');
    const child2 = streamId('child-2');
    const parentStream = new Map<StreamTabId, StreamTabId>([
      [child1, child2],
      [child2, child1],
    ]);
    const values = new Map([
      [child1, { usable: true }],
      [child2, { usable: false }],
    ]);

    expect(
      nearestActiveStreamAncestor({
        activeStreamId: child1,
        parentStream,
        values,
        canUseValue: (value) => value.usable,
      }),
    ).toBeUndefined();
  });
});

describe('CLI stream tabs strip', () => {
  it('suppresses the strip for a single stream', () => {
    const root = streamId('root');
    const streams = new Map([[root, slice('root')]]);

    expect(
      streamTabsDisplayItems({
        activeStreamId: root,
        childStreamEntries: EMPTY_CHILD_STREAM_ENTRIES,
        streams,
        parentStream: new Map(),
        width: 80,
      }),
    ).toEqual([]);
  });

  it('renders parent first and active child in focus-cycle order', () => {
    const root = streamId('root');
    const child1 = streamId('child-1');
    const child2 = streamId('child-2');
    const streams = new Map<StreamTabId, StreamSlice>([
      [root, slice('root', { status: STREAM_PHASE.RUNNING })],
      [child1, slice('child-1', { status: STREAM_PHASE.WAITING })],
      [child2, slice('child-2', { status: STREAM_PHASE.RUNNING })],
    ]);
    const childStreamEntries = buildChildStreamEntries({
      parentStreamId: root,
      activeOnly: [
        child({ executionId: 'r1', childStreamId: child1, agentName: 'setup' }),
        child({ executionId: 'p1', childStreamId: child2, toolName: 'bash' }),
      ],
    });

    const items = streamTabsDisplayItems({
      activeStreamId: child2,
      childStreamEntries,
      streams,
      parentStream: new Map([
        [child1, root],
        [child2, root],
      ]),
      width: 80,
    });

    expect(items.map(streamTabSegmentText)).toEqual([
      'main*',
      '1:setup(waiting for you)',
      '[2:bash]*',
    ]);
  });

  it('projects active stream tree order once for tabs and shortcuts', () => {
    const root = streamId('root');
    const child1 = streamId('child-1');
    const child2 = streamId('child-2');
    const streams = new Map<StreamTabId, StreamSlice>([
      [root, slice('root')],
      [child1, slice('child-1')],
      [child2, slice('child-2')],
    ]);
    const childStreamEntries = buildChildStreamEntries({
      parentStreamId: root,
      activeOnly: [
        child({ executionId: 'r1', childStreamId: child1, agentName: 'setup' }),
        child({ executionId: 'p1', childStreamId: child2, toolName: 'bash' }),
      ],
    });

    expect(
      activeStreamTreeEntries({
        activeStreamId: child2,
        childStreamEntries,
        parentStream: new Map([
          [child1, root],
          [child2, root],
        ]),
        streams,
      }),
    ).toEqual([
      { id: root },
      { id: child1, shortcutIndex: 1 },
      { id: child2, shortcutIndex: 2 },
    ]);
  });

  it('keeps child shortcut labels aligned when the root stream is missing', () => {
    const root = streamId('root');
    const child1 = streamId('child-1');
    const child2 = streamId('child-2');
    const streams = new Map<StreamTabId, StreamSlice>([
      [child1, slice('child-1', { status: STREAM_PHASE.WAITING })],
      [child2, slice('child-2', { status: STREAM_PHASE.WAITING })],
    ]);
    const childStreamEntries = buildChildStreamEntries({
      parentStreamId: root,
      edgeOnly: [child1, child2],
    });

    const items = streamTabsDisplayItems({
      activeStreamId: child2,
      childStreamEntries,
      streams,
      parentStream: new Map([
        [child1, root],
        [child2, root],
      ]),
      width: 80,
    });

    expect(items.map(streamTabSegmentText)).toEqual([
      '1:child-1(waiting for you)',
      '[2:child-2]',
    ]);
  });

  it('keeps inactive subagent pages visible while their transcript slice exists', () => {
    const root = streamId('root');
    const child1 = streamId('child-1');
    const streams = new Map<StreamTabId, StreamSlice>([
      [root, slice('root', { status: STREAM_PHASE.WAITING })],
      [child1, slice('child-1', { status: STREAM_PHASE.WAITING })],
    ]);
    const childStreamEntries = buildChildStreamEntries({
      parentStreamId: root,
      retained: [
        child({
          executionId: 'r1',
          childStreamId: child1,
          agentName: 'polish',
          active: false,
        }),
      ],
    });

    const items = streamTabsDisplayItems({
      activeStreamId: root,
      childStreamEntries,
      streams,
      parentStream: new Map([[child1, root]]),
      width: 80,
    });

    expect(items.map(streamTabSegmentText)).toEqual([
      '[main]',
      '1:polish(waiting for you)',
    ]);
  });

  it('labels the focused stopped stream in the tab strip', () => {
    const root = streamId('root');
    const child1 = streamId('child-1');
    const streams = new Map<StreamTabId, StreamSlice>([
      [root, slice('root', { status: STREAM_PHASE.CANCELLED })],
      [child1, slice('child-1', { status: STREAM_PHASE.CANCELLED })],
    ]);
    const childStreamEntries = buildChildStreamEntries({
      parentStreamId: root,
      retained: [
        child({
          executionId: 'r1',
          childStreamId: child1,
          agentName: 'strategy',
          active: false,
        }),
      ],
    });

    const items = streamTabsDisplayItems({
      activeStreamId: child1,
      childStreamEntries,
      streams,
      parentStream: new Map([[child1, root]]),
      width: 80,
    });

    expect(items.map(streamTabSegmentText)).toEqual([
      'main(stopped)',
      '[1:strategy](stopped)',
    ]);
  });

  it('labels focused failed and completed streams as ended', () => {
    const root = streamId('root');
    const child1 = streamId('child-1');
    const streams = new Map<StreamTabId, StreamSlice>([
      [root, slice('root', { status: STREAM_PHASE.COMPLETED })],
      [child1, slice('child-1', { status: STREAM_PHASE.FAILED })],
    ]);
    const childStreamEntries = buildChildStreamEntries({
      parentStreamId: root,
      retained: [
        child({
          executionId: 'r1',
          childStreamId: child1,
          agentName: 'strategy',
          active: false,
        }),
      ],
    });

    const items = streamTabsDisplayItems({
      activeStreamId: child1,
      childStreamEntries,
      streams,
      parentStream: new Map([[child1, root]]),
      width: 80,
    });

    // The focused failed tab surfaces its status, as every terminal outcome
    // does; completed roots retain their canonical label too.
    expect(items.map(streamTabSegmentText)).toEqual([
      'main(completed)',
      '[1:strategy](error)',
    ]);
  });

  it('labels nested child stream roots with their friendly stream name', () => {
    const root = streamId('root');
    const child1 = streamId('child-1');
    const grandchild1 = streamId('grandchild-1');
    const streams = new Map<StreamTabId, StreamSlice>([
      [root, slice('root')],
      [child1, slice('child-1', { status: STREAM_PHASE.RUNNING })],
      [grandchild1, slice('grandchild-1', { status: STREAM_PHASE.RUNNING })],
    ]);
    const childStreamEntries = new Map([
      ...buildChildStreamEntries({
        parentStreamId: root,
        retained: [
          child({
            executionId: 'r1',
            childStreamId: child1,
            agentName: 'review',
            active: false,
          }),
        ],
      }),
      ...buildChildStreamEntries({
        parentStreamId: child1,
        activeOnly: [
          child({
            executionId: 'r2',
            childStreamId: grandchild1,
            agentName: 'detail-review',
          }),
        ],
      }),
    ]);

    const items = streamTabsDisplayItems({
      activeStreamId: grandchild1,
      childStreamEntries,
      streams,
      parentStream: new Map([
        [child1, root],
        [grandchild1, child1],
      ]),
      width: 80,
    });

    expect(items.map(streamTabSegmentText)).toEqual([
      'review*',
      '[1:detail-review]*',
    ]);
  });

  it('collapses the middle entries under narrow widths while preserving focus', () => {
    const root = streamId('root');
    const childIds = Array.from({ length: 5 }, (_, i) =>
      streamId(`child-${i + 1}`),
    );
    const streams = new Map<StreamTabId, StreamSlice>([
      [root, slice('root')],
      ...childIds.map((id) => [id, slice(id)] as const),
    ]);
    const childStreamEntries = buildChildStreamEntries({
      parentStreamId: root,
      activeOnly: childIds.map((id, i) =>
        child({
          executionId: `r${i}`,
          childStreamId: id,
          agentName: `subagent-${i + 1}`,
        }),
      ),
    });

    const items = streamTabsDisplayItems({
      activeStreamId: childIds[2],
      childStreamEntries,
      streams,
      parentStream: new Map(childIds.map((id) => [id, root] as const)),
      width: 20,
    });

    expect(items.map(streamTabSegmentText)).toEqual([
      'main',
      '…',
      '[3:subagent-3]',
      '…',
      '5:subagent-5',
    ]);
  });

  it('keeps a four-stream child strip within one narrow terminal row', () => {
    const root = streamId('root');
    const strategy = streamId('strategy-stream');
    const leanSolver = streamId('lean-stream');
    const reviewer = streamId('reviewer-stream');
    const streams = new Map<StreamTabId, StreamSlice>([
      [root, slice('root', { status: STREAM_PHASE.RUNNING })],
      [strategy, slice('strategy-stream', { status: STREAM_PHASE.RUNNING })],
      [leanSolver, slice('lean-stream', { status: STREAM_PHASE.WAITING })],
      [reviewer, slice('reviewer-stream', { status: STREAM_PHASE.RUNNING })],
    ]);
    const childStreamEntries = buildChildStreamEntries({
      parentStreamId: root,
      activeOnly: [
        child({
          executionId: 'strategy',
          childStreamId: strategy,
          agentName: 'strategy',
          status: STREAM_PHASE.RUNNING,
        }),
        child({
          executionId: 'lean',
          childStreamId: leanSolver,
          agentName: 'leanSolver',
          status: STREAM_PHASE.WAITING,
        }),
        child({
          executionId: 'review',
          childStreamId: reviewer,
          agentName: 'reviewer',
          status: STREAM_PHASE.RUNNING,
        }),
      ],
    });

    const items = streamTabsDisplayItems({
      activeStreamId: root,
      childStreamEntries,
      streams,
      parentStream: new Map([
        [strategy, root],
        [leanSolver, root],
        [reviewer, root],
      ]),
      width: 40,
    });
    const line = streamTabsLineText(items, 38);

    expect(items.map(streamTabSegmentText)).toEqual([
      '[main]*',
      '1:strategy*',
      '…',
      '3:reviewer*',
    ]);
    expect(line.length).toBeLessThanOrEqual(38);
  });

  it('truncates stream tab text at terminal row edges', () => {
    const items = [
      {
        id: streamId('root'),
        label: 'main',
        active: true,
        running: true,
      },
      {
        id: streamId('strategy'),
        label: 'strategy',
        active: false,
        running: true,
        shortcutIndex: 1,
      },
    ];
    const fullText = streamTabsLineText(items);

    expect(streamTabsLineText(items, 0)).toBe('');
    expect(streamTabsLineText(items, 1)).toBe('…');
    expect(streamTabsLineText(items, fullText.length)).toBe(fullText);
    expect(streamTabsLineText(items, fullText.length - 1)).toHaveLength(
      fullText.length - 1,
    );
    expect(streamTabsLineText(items, fullText.length - 1)).toMatch(/…$/);
  });

  it('fits stream tab text by display width, not character count', () => {
    const line = streamTabsLineText(
      [
        {
          id: streamId('wide'),
          label: '研究',
          active: true,
          running: false,
        },
      ],
      5,
    );

    expect(textDisplayWidth(line)).toBeLessThanOrEqual(5);
    expect(line).toMatch(/…$/);
  });

  it('keeps truncation attached to styled tab segments', () => {
    const active = {
      id: streamId('root'),
      label: 'main',
      active: true,
      running: true,
    };
    const running = {
      id: streamId('strategy'),
      label: 'strategy',
      active: false,
      running: true,
      shortcutIndex: 1,
    };
    const segments = streamTabsLineSegments([active, running], 16);

    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({
      item: active,
      leadingSpace: false,
      text: '[main]*',
    });
    expect(segments[1]?.item).toBe(running);
    expect(segments[1]?.leadingSpace).toBe(true);
    expect(segments[1]?.text).toBe('1:strat…');
    expect(streamTabsLineText([active, running], 16)).toBe('[main]* 1:strat…');
  });

  it('keeps the active tab visible when earlier tabs fill the row', () => {
    const active = {
      id: streamId('active'),
      label: 'active-target',
      active: true,
      running: true,
      shortcutIndex: 2,
    };
    const segments = streamTabsLineSegments(
      [
        {
          id: streamId('root'),
          label: 'main',
          active: false,
          running: true,
        },
        {
          id: streamId('middle'),
          label: 'very-long-middle',
          active: false,
          running: true,
          shortcutIndex: 1,
        },
        active,
      ],
      20,
    );
    const line = segments
      .map((segment) => `${segment.leadingSpace ? ' ' : ''}${segment.text}`)
      .join('');

    expect(segments.some((segment) => segment.item === active)).toBe(true);
    expect(line).toHaveLength(20);
    expect(line).toContain('[2:active');
    expect(line).toContain('…');
  });

  it('collapses a middle tab before an active last tab in tight rows', () => {
    const root = streamId('root');
    const middle = streamId('middle-stream');
    const active = streamId('active-stream');
    const streams = new Map<StreamTabId, StreamSlice>([
      [root, slice('root', { status: STREAM_PHASE.RUNNING })],
      [middle, slice('middle-stream', { status: STREAM_PHASE.RUNNING })],
      [active, slice('active-stream', { status: STREAM_PHASE.RUNNING })],
    ]);
    const childStreamEntries = buildChildStreamEntries({
      parentStreamId: root,
      activeOnly: [
        child({
          executionId: 'middle',
          childStreamId: middle,
          agentName: 'veryLongMiddleAgent',
          status: STREAM_PHASE.RUNNING,
        }),
        child({
          executionId: 'active',
          childStreamId: active,
          agentName: 'activeTarget',
          status: STREAM_PHASE.RUNNING,
        }),
      ],
    });

    const items = streamTabsDisplayItems({
      activeStreamId: active,
      childStreamEntries,
      streams,
      parentStream: new Map([
        [middle, root],
        [active, root],
      ]),
      width: 28,
    });

    expect(items.map(streamTabSegmentText)).toEqual([
      'main*',
      '…',
      '[2:activeTarget]*',
    ]);
  });
});
