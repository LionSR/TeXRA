import { describe, expect, it } from 'vitest';

import {
  computeTaskDetailLayout,
  isUltraCompactTaskDetailRows,
  TASK_DETAIL_LABEL_WIDTH,
  taskDetailKeyHintsForColumns,
} from '@cli/chat/tui/modals/TaskDetailView';
import {
  childElapsed,
  liveChildExecutionElapsedKey,
  numericFocusTargetForActiveStream,
  processTailLines,
  resolveChildListTarget,
} from '@cli/chat/tui/state/childControls';
import {
  taskDetailFollowTailScrollOffsetForColumns,
  taskDetailVisibleOutputRowsFromOffsetForColumns,
} from '@cli/chat/tui/state/taskDetailScroll';
import {
  NO_BYPASS,
  type ProcessOutputTail,
  type StreamSlice,
} from '@cli/chat/tui/state/cliState';
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
    usage: undefined,
    cumulativeUsage: undefined,
    conversation: undefined,
    entries: [],
    queuedFollowUpMessages: [],
    activeProcesses: [],
    todos: [],
    plan: null,
    processOutput: new Map(),
    bypass: NO_BYPASS,
    ...overrides,
  };
}

describe('CLI child controls', () => {
  it('keeps process output tails compact and cached by immutable tail object', () => {
    const tail: ProcessOutputTail = {
      stdout: 'first\nsecond\n',
      stderr: 'warning\n',
    };
    const lines = processTailLines(tail);

    expect(lines).toEqual(['first', 'second', 'warning']);
    expect(processTailLines(tail)).toBe(lines);
    expect(processTailLines(undefined)).toEqual([]);
  });

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
    expect(
      liveChildExecutionElapsedKey(
        [],
        [
          {
            kind: 'process',
            executionId: 'process-1',
            agentName: 'latexmk',
            startedAt: 1_000,
            status: STREAM_PHASE.RUNNING,
          },
        ],
      ),
    ).toBe('process-1:1000');
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

  it('keeps TaskDetailView process-only hints and compact layouts', () => {
    expect(TASK_DETAIL_LABEL_WIDTH).toBe(13);
    expect(isUltraCompactTaskDetailRows(4)).toBe(true);
    expect(
      taskDetailKeyHintsForColumns({
        availableColumns: 90,
        canKill: true,
        showScrollHint: true,
      }),
    ).toEqual([
      { key: '↑/↓', action: 'scroll' },
      { key: 'PgUp/PgDn', action: 'page' },
      { key: 'g/G', action: 'top/bottom' },
      { key: 'k', action: 'kill' },
      { key: 'Esc', action: 'back' },
    ]);
    expect(
      computeTaskDetailLayout({
        availableRows: 8,
        hasTailLines: true,
        metaRows: 4,
      }),
    ).toMatchObject({ compact: true, showCommand: false, showTitle: false });
  });

  it('follows and windows the process tail by rendered rows', () => {
    const tailLines = ['one', 'two', 'three', 'four'];
    const offset = taskDetailFollowTailScrollOffsetForColumns({
      availableColumns: 80,
      compact: true,
      tailLines,
      visibleRowBudget: 2,
    });
    expect(offset).toBe(2);
    expect(
      taskDetailVisibleOutputRowsFromOffsetForColumns({
        availableColumns: 80,
        compact: true,
        offset,
        tailLines,
        visibleRowBudget: 2,
      }),
    ).toEqual(['three', 'four']);
  });
});
