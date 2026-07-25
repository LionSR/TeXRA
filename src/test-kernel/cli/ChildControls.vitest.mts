import { describe, expect, it } from 'vitest';

import {
  childElapsed,
  numericFocusTargetForActiveStream,
  resolveChildListTarget,
} from '@cli/chat/tui/state/childControls';
import { NO_BYPASS, type StreamSlice } from '@cli/chat/tui/state/cliState';
import { streamTreeViews } from '@cli/chat/tui/state/streamViews';
import { STREAM_PHASE, type StreamTabId } from '@shared/schemas';
import { buildChildStreamEntries } from '@test/support/childStreamEntries';

const root = 'root' as StreamTabId;
const child = 'child' as StreamTabId;
const leaf = 'leaf' as StreamTabId;

function slice(overrides: Partial<StreamSlice> = {}): StreamSlice {
  return {
    streamId: root,
    category: undefined,
    status: undefined,
    runStartedAt: undefined,
    description: undefined,
    thinkingActive: false,
    compactingActive: false,
    usage: undefined,
    cumulativeUsage: undefined,
    conversation: undefined,
    entries: [],
    queuedFollowUpMessages: [],
    todos: [],
    plan: null,
    bypass: NO_BYPASS,
    ...overrides,
  };
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
        {
          kind: 'subagent',
          executionId: 'child-exec',
          agentName: 'critic',
          childStreamId: child,
          status: STREAM_PHASE.COMPLETED,
        },
      ],
    });
    const streams = new Map<StreamTabId, StreamSlice>([
      [root, slice({ streamId: root })],
      [child, slice({ streamId: child, status: STREAM_PHASE.COMPLETED })],
      [leaf, slice({ streamId: leaf })],
    ]);
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
        retained: [
          {
            kind: 'subagent' as const,
            executionId: 'child-exec',
            agentName: 'child',
            childStreamId: child,
            status: STREAM_PHASE.RUNNING,
          },
        ],
      }),
      ...buildChildStreamEntries({
        parentStreamId: child,
        retained: [
          {
            kind: 'subagent' as const,
            executionId: 'leaf-exec',
            agentName: 'leaf',
            childStreamId: leaf,
            status: STREAM_PHASE.RUNNING,
          },
        ],
      }),
    ]);
    const streams = new Map<StreamTabId, StreamSlice>([
      [root, slice({ streamId: root })],
      [child, slice({ streamId: child, status: STREAM_PHASE.RUNNING })],
      [leaf, slice({ streamId: leaf, status: STREAM_PHASE.RUNNING })],
    ]);
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

  it('preserves Alt/Esc-number stream focus order', () => {
    const entries = buildChildStreamEntries({
      parentStreamId: root,
      retained: [
        {
          kind: 'subagent',
          executionId: 'child-exec',
          agentName: 'critic',
          childStreamId: child,
          status: STREAM_PHASE.RUNNING,
        },
      ],
    });
    const streams = new Map<StreamTabId, StreamSlice>([
      [root, slice({ streamId: root })],
      [child, slice({ streamId: child, status: STREAM_PHASE.RUNNING })],
    ]);

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
