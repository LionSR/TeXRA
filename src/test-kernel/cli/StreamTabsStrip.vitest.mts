import { describe, expect, it } from 'vitest';

import { NO_BYPASS, type StreamSlice } from '@cli/chat/tui/state/cliState';
import {
  streamTabSegmentText,
  streamTabsLineSegments,
  streamTabsLineText,
  streamTabsDisplayItems,
} from '@cli/chat/tui/panes/StreamTabsStrip';
import {
  STREAM_STATUS,
  type ActiveChildInfo,
  type StreamTabId,
} from '@shared/schemas';

function streamId(value: string): StreamTabId {
  return value as StreamTabId;
}

function child(init: {
  readonly executionId: string;
  readonly childStreamId: string;
  readonly agentName?: string;
  readonly toolName?: string;
  readonly status?: string;
}): ActiveChildInfo {
  return {
    executionId: init.executionId,
    agentName: init.agentName ?? '',
    childStreamId: init.childStreamId,
    toolName: init.toolName,
    status: init.status,
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
    usage: undefined,
    conversation: undefined,
    entries: [],
    queuedFollowUps: 0,
    queuedFollowUpMessages: [],
    activeSubagents: [],
    activeProcesses: [],
    childStreams: [],
    todos: [],
    plan: null,
    processOutput: new Map(),
    bypass: NO_BYPASS,
    ...init,
  };
}

describe('CLI stream tabs strip', () => {
  it('suppresses the strip for a single stream', () => {
    const root = streamId('root');
    const streams = new Map([[root, slice('root')]]);

    expect(
      streamTabsDisplayItems({
        activeStreamId: root,
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
      [
        root,
        slice('root', {
          status: STREAM_STATUS.RUNNING,
          activeSubagents: [
            child({
              executionId: 'r1',
              childStreamId: child1,
              agentName: 'setup',
            }),
          ],
          activeProcesses: [
            child({
              executionId: 'p1',
              childStreamId: child2,
              toolName: 'bash',
            }),
          ],
        }),
      ],
      [child1, slice('child-1', { status: STREAM_STATUS.WAITING })],
      [child2, slice('child-2', { status: STREAM_STATUS.RUNNING })],
    ]);

    const items = streamTabsDisplayItems({
      activeStreamId: child2,
      streams,
      parentStream: new Map([
        [child1, root],
        [child2, root],
      ]),
      width: 80,
    });

    expect(items.map(streamTabSegmentText)).toEqual([
      'main*',
      '1:setup(idle)',
      '[2:bash]*',
    ]);
  });

  it('keeps child shortcut labels aligned when the root stream is missing', () => {
    const root = streamId('root');
    const child1 = streamId('child-1');
    const child2 = streamId('child-2');
    const streams = new Map<StreamTabId, StreamSlice>([
      [child1, slice('child-1', { status: STREAM_STATUS.WAITING })],
      [child2, slice('child-2', { status: STREAM_STATUS.WAITING })],
    ]);

    const items = streamTabsDisplayItems({
      activeStreamId: child2,
      streams,
      parentStream: new Map([
        [child1, root],
        [child2, root],
      ]),
      width: 80,
    });

    expect(items.map(streamTabSegmentText)).toEqual([
      '1:child-1(idle)',
      '[2:child-2]',
    ]);
  });

  it('keeps inactive subagent pages visible while their transcript slice exists', () => {
    const root = streamId('root');
    const child1 = streamId('child-1');
    const streams = new Map<StreamTabId, StreamSlice>([
      [
        root,
        slice('root', {
          status: STREAM_STATUS.WAITING,
          childStreams: [
            child({
              executionId: 'r1',
              childStreamId: child1,
              agentName: 'polish',
            }),
          ],
        }),
      ],
      [child1, slice('child-1', { status: STREAM_STATUS.WAITING })],
    ]);

    const items = streamTabsDisplayItems({
      activeStreamId: root,
      streams,
      parentStream: new Map([[child1, root]]),
      width: 80,
    });

    expect(items.map(streamTabSegmentText)).toEqual([
      '[main]',
      '1:polish(idle)',
    ]);
  });

  it('labels the focused stopped stream in the tab strip', () => {
    const root = streamId('root');
    const child1 = streamId('child-1');
    const streams = new Map<StreamTabId, StreamSlice>([
      [
        root,
        slice('root', {
          status: STREAM_STATUS.STOPPED,
          childStreams: [
            child({
              executionId: 'r1',
              childStreamId: child1,
              agentName: 'strategy',
            }),
          ],
        }),
      ],
      [child1, slice('child-1', { status: STREAM_STATUS.STOPPED })],
    ]);

    const items = streamTabsDisplayItems({
      activeStreamId: child1,
      streams,
      parentStream: new Map([[child1, root]]),
      width: 80,
    });

    expect(items.map(streamTabSegmentText)).toEqual([
      'main(stopped)',
      '[1:strategy](stopped)',
    ]);
  });

  it('labels nested child stream roots with their friendly stream name', () => {
    const root = streamId('root');
    const child1 = streamId('child-1');
    const grandchild1 = streamId('grandchild-1');
    const streams = new Map<StreamTabId, StreamSlice>([
      [
        root,
        slice('root', {
          childStreams: [
            child({
              executionId: 'r1',
              childStreamId: child1,
              agentName: 'review',
            }),
          ],
        }),
      ],
      [
        child1,
        slice('child-1', {
          status: STREAM_STATUS.RUNNING,
          activeSubagents: [
            child({
              executionId: 'r2',
              childStreamId: grandchild1,
              agentName: 'detail-review',
            }),
          ],
        }),
      ],
      [grandchild1, slice('grandchild-1', { status: STREAM_STATUS.RUNNING })],
    ]);

    const items = streamTabsDisplayItems({
      activeStreamId: grandchild1,
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
      [
        root,
        slice('root', {
          activeSubagents: childIds.map((id, i) =>
            child({
              executionId: `r${i}`,
              childStreamId: id,
              agentName: `subagent-${i + 1}`,
            }),
          ),
        }),
      ],
      ...childIds.map((id) => [id, slice(id)] as const),
    ]);

    const items = streamTabsDisplayItems({
      activeStreamId: childIds[2],
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
      [
        root,
        slice('root', {
          status: STREAM_STATUS.RUNNING,
          activeSubagents: [
            child({
              executionId: 'strategy',
              childStreamId: strategy,
              agentName: 'strategy',
              status: STREAM_STATUS.RUNNING,
            }),
            child({
              executionId: 'lean',
              childStreamId: leanSolver,
              agentName: 'leanSolver',
              status: STREAM_STATUS.WAITING,
            }),
            child({
              executionId: 'review',
              childStreamId: reviewer,
              agentName: 'reviewer',
              status: STREAM_STATUS.RUNNING,
            }),
          ],
        }),
      ],
      [strategy, slice('strategy-stream', { status: STREAM_STATUS.RUNNING })],
      [leanSolver, slice('lean-stream', { status: STREAM_STATUS.WAITING })],
      [reviewer, slice('reviewer-stream', { status: STREAM_STATUS.RUNNING })],
    ]);

    const items = streamTabsDisplayItems({
      activeStreamId: root,
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
      [
        root,
        slice('root', {
          status: STREAM_STATUS.RUNNING,
          activeSubagents: [
            child({
              executionId: 'middle',
              childStreamId: middle,
              agentName: 'veryLongMiddleAgent',
              status: STREAM_STATUS.RUNNING,
            }),
            child({
              executionId: 'active',
              childStreamId: active,
              agentName: 'activeTarget',
              status: STREAM_STATUS.RUNNING,
            }),
          ],
        }),
      ],
      [middle, slice('middle-stream', { status: STREAM_STATUS.RUNNING })],
      [active, slice('active-stream', { status: STREAM_STATUS.RUNNING })],
    ]);

    const items = streamTabsDisplayItems({
      activeStreamId: active,
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
