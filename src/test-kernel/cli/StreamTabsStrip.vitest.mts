import { describe, expect, it } from 'vitest';

import { NO_BYPASS, type StreamSlice } from '@cli/chat/tui/state/cliState';
import {
  streamTabSegmentText,
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
    status: undefined,
    description: undefined,
    usage: undefined,
    conversation: undefined,
    entries: [],
    queuedFollowUps: 0,
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
      'setup(idle)',
      '[bash]*',
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

    expect(items.map(streamTabSegmentText)).toEqual(['[main]', 'polish(idle)']);
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
      '[subagent-3]',
      '…',
      'subagent-5',
    ]);
  });
});
