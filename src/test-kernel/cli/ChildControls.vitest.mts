// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - CLI TUI state
import {
  buildChildStreamEntries,
  type ChildStreamEntryRow,
} from '@test/support/childStreamEntries';
import {
  computeTaskDetailLayout,
  isUltraCompactTaskDetailRows,
  TASK_DETAIL_LABEL_WIDTH,
  taskDetailCommandLabel,
  taskDetailKeyHintsForColumns,
} from '@cli/chat/tui/modals/TaskDetailView';
import {
  jumpTaskDetailScrollState,
  moveTaskDetailScrollState,
  pageTaskDetailScrollState,
  syncTaskDetailScrollState,
  taskDetailFollowTailScrollOffsetForColumns,
  taskDetailInitialScrollOffset,
  taskDetailScrollableOutputRowCountForColumns,
  taskDetailVisibleOutputRowsFromOffsetForColumns,
  taskDetailVisibleScrollOffset,
  taskDetailWrappedRowCount,
} from '@cli/chat/tui/state/taskDetailScroll';
import {
  buildChildControlItems,
  childElapsed,
  childPickerKeyAction,
  hasChildControlItems,
  latestChildResponseSummary,
  liveChildExecutionElapsedKey,
  numericFocusTargetForActiveStream,
  resolveChildExecutionPanelTarget,
} from '@cli/chat/tui/state/childControls';
import {
  activeSubagentsFor,
  visibleSubagentRows,
  type ChildStreamEntries,
} from '@cli/chat/tui/state/childExecutions';
import { streamDisplayLabel } from '@cli/chat/tui/state/streamViews';
import {
  NO_BYPASS,
  type ProcessOutputTail,
  type StreamSlice,
} from '@cli/chat/tui/state/cliState';

// Local imports - shared schemas
import { MESSAGE_TYPES, STREAM_PHASE, type StreamTabId } from '@shared/schemas';

function tail(stdout: string, stderr = ''): ProcessOutputTail {
  return { stdout, stderr };
}

function slice(
  overrides: Partial<StreamSlice> = {},
): Pick<StreamSlice, 'activeProcesses' | 'processOutput'> & StreamSlice {
  return {
    streamId: 'root',
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
    ...overrides,
  };
}

/** Build a `{ id: StreamSlice }` streams map entry carrying just the status
 *  each `ChildStreamEntryRow` used to embed directly — the new selectors
 *  read status from the child's own `StreamSlice`, not the roster row. */
function childStatusStreams(
  rows: readonly ChildStreamEntryRow[],
): ReadonlyMap<StreamTabId, StreamSlice> {
  return new Map(
    rows.map((row) => [
      row.childStreamId,
      slice({
        streamId: row.childStreamId,
        // ChildStreamEntryRow keeps process status text stringly typed, while
        // subagent StreamSlice status is the canonical StreamPhase.
        status: row.status as StreamSlice['status'],
      }),
    ]),
  );
}

/** Build a `ChildStreamEntries` map for `parentStreamId` plus a merged
 *  `streams` map (parent + each child's own status slice, with `extraStreams`
 *  overlaid last so a test's own per-child slice overrides win). */
function childFixture(
  parentStreamId: StreamTabId,
  init: {
    readonly retained?: readonly ChildStreamEntryRow[];
    readonly activeOnly?: readonly ChildStreamEntryRow[];
    readonly parentSlice?: StreamSlice;
    readonly extraStreams?: ReadonlyMap<StreamTabId, StreamSlice>;
  },
): {
  readonly entries: ChildStreamEntries;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
} {
  const rows = [...(init.retained ?? []), ...(init.activeOnly ?? [])];
  const streams = new Map<StreamTabId, StreamSlice>([
    [parentStreamId, init.parentSlice ?? slice({ streamId: parentStreamId })],
    ...childStatusStreams(rows),
    ...(init.extraStreams ?? []),
  ]);
  return {
    entries: buildChildStreamEntries({
      parentStreamId,
      retained: init.retained,
      activeOnly: init.activeOnly,
    }),
    streams,
  };
}

describe('CLI child execution controls', () => {
  it('maps Alt-number focus jumps to visible descendant streams', () => {
    // Only subagents own a stream tab, so a retained row is a valid
    // focus-jump target only once its own `StreamSlice` exists ("agent-1"
    // has none yet and is skipped); an active-only row with an edge is
    // reachable once its slice exists ("agent-3") — background processes
    // never are.
    const entries = buildChildStreamEntries({
      parentStreamId: 'root' as StreamTabId,
      retained: [
        {
          kind: 'subagent',
          executionId: 'agent-2',
          agentName: 'critic',
          childStreamId: 'child-c' as StreamTabId,
        },
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'critic',
          childStreamId: 'child-a' as StreamTabId,
          active: false,
        },
      ],
      activeOnly: [
        {
          kind: 'subagent',
          executionId: 'agent-3',
          agentName: 'bash',
          childStreamId: 'child-b' as StreamTabId,
        },
      ],
    });
    const streams = new Map<StreamSlice['streamId'], StreamSlice>([
      ['root', slice({ streamId: 'root' })],
      ['child-b', slice({ streamId: 'child-b' })],
      ['child-c', slice({ streamId: 'child-c' })],
    ]);

    expect(
      numericFocusTargetForActiveStream({
        activeStreamId: 'root',
        childStreamEntries: entries,
        parentStream: new Map(),
        streams,
        zeroBasedIndex: 0,
      }),
    ).toBe('child-b');
    expect(
      numericFocusTargetForActiveStream({
        activeStreamId: 'root',
        childStreamEntries: entries,
        parentStream: new Map(),
        streams,
        zeroBasedIndex: 1,
      }),
    ).toBe('child-c');
    expect(
      numericFocusTargetForActiveStream({
        activeStreamId: 'root',
        childStreamEntries: entries,
        parentStream: new Map(),
        streams,
        zeroBasedIndex: 2,
      }),
    ).toBeUndefined();
  });

  it('maps Alt-number focus jumps through the focused child stream tree', () => {
    const { entries } = childFixture('root', {
      retained: [
        {
          kind: 'subagent',
          executionId: 'agent-2',
          agentName: 'reviewer',
          childStreamId: 'child-b',
        },
      ],
      activeOnly: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'critic',
          childStreamId: 'child-a',
        },
      ],
    });
    const streams = new Map<StreamSlice['streamId'], StreamSlice>([
      ['root', slice({ streamId: 'root' })],
      ['child-a', slice({ streamId: 'child-a' })],
      ['child-b', slice({ streamId: 'child-b' })],
    ]);
    const parentStream = new Map<
      StreamSlice['streamId'],
      StreamSlice['streamId']
    >([
      ['child-a', 'root'],
      ['child-b', 'root'],
    ]);

    expect(
      numericFocusTargetForActiveStream({
        activeStreamId: 'child-a',
        childStreamEntries: entries,
        parentStream,
        streams,
        zeroBasedIndex: 0,
      }),
    ).toBe('child-a');
    expect(
      numericFocusTargetForActiveStream({
        activeStreamId: 'child-a',
        childStreamEntries: entries,
        parentStream,
        streams,
        zeroBasedIndex: 1,
      }),
    ).toBe('child-b');
  });

  it('builds subagent and process rows with stable labels and tails', () => {
    const parentSlice = slice({
      activeProcesses: [
        {
          kind: 'process',
          executionId: 'proc-1',
          agentName: 'latexmk',
          status: 'running',
          elapsed: '3s',
        },
      ],
      processOutput: new Map([['proc-1', tail('first\nsecond\n', 'warning')]]),
    });
    const { entries, streams } = childFixture('root', {
      parentSlice,
      retained: [
        {
          kind: 'subagent',
          executionId: 'agent-2',
          agentName: 'reviewer',
          childStreamId: 'child-b',
          status: STREAM_PHASE.CANCELLED,
          elapsed: '20s',
          active: false,
        },
      ],
      activeOnly: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'critic',
          childStreamId: 'child-a',
          status: 'running',
          elapsed: '12s',
        },
      ],
    });

    expect(buildChildControlItems('root', entries, streams)).toMatchObject([
      {
        executionId: 'agent-2',
        childStreamId: 'child-b',
        kind: 'subagent',
        label: 'reviewer',
        command: 'reviewer',
        description: 'stopped · 20s',
        killable: false,
        tailLines: [],
      },
      {
        executionId: 'agent-1',
        childStreamId: 'child-a',
        kind: 'subagent',
        label: 'critic',
        command: 'critic',
        description: 'running · 12s',
        killable: true,
        // Sessions never open TaskDetailView, so subagent rows carry no tail.
        tailLines: [],
      },
      {
        executionId: 'proc-1',
        kind: 'process',
        label: 'latexmk',
        command: 'latexmk',
        description: 'running · 3s · warning',
        killable: true,
        tailLines: ['first', 'second', 'warning'],
      },
    ]);
  });

  it('shows the subagent own final response as the row summary', () => {
    const { entries, streams } = childFixture('root', {
      activeOnly: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'reviewer',
          childStreamId: 'child-a',
          status: STREAM_PHASE.WAITING,
          elapsed: '20s',
        },
      ],
      extraStreams: new Map([
        [
          'child-a',
          slice({
            streamId: 'child-a',
            status: STREAM_PHASE.WAITING,
            entries: [
              {
                id: 'entry-1',
                role: 'user',
                text: 'Review the introduction for clarity.',
                finalized: true,
              },
              {
                id: 'entry-2',
                role: 'assistant',
                messageType: MESSAGE_TYPES.MODEL_RESPONSE,
                text: 'Tightened the opening paragraph and fixed two typos.',
                finalized: true,
              },
            ],
          }),
        ],
      ]),
    });

    expect(buildChildControlItems('root', entries, streams)).toMatchObject([
      {
        executionId: 'agent-1',
        description:
          'waiting for you · 20s · Tightened the opening paragraph and fixed two typos.',
      },
    ]);
    // The same derivation is exported directly for the SubagentList rows.
    expect(latestChildResponseSummary(streams.get('child-a')?.entries)).toBe(
      'Tightened the opening paragraph and fixed two typos.',
    );
  });

  it('falls back to the first user instruction when no final response exists yet', () => {
    const { entries, streams } = childFixture('root', {
      activeOnly: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'reviewer',
          childStreamId: 'child-a',
          status: 'running',
          elapsed: '3s',
        },
      ],
      extraStreams: new Map([
        [
          'child-a',
          slice({
            streamId: 'child-a',
            status: 'running',
            entries: [
              {
                id: 'entry-1',
                role: 'user',
                text: `Review the introduction for clarity and tone. ${'x'.repeat(100)}`,
                finalized: true,
              },
              {
                id: 'entry-2',
                role: 'assistant',
                messageType: MESSAGE_TYPES.MODEL_RESPONSE,
                text: 'Still drafting a response',
                finalized: false,
              },
            ],
          }),
        ],
      ]),
    });

    const [item] = buildChildControlItems('root', entries, streams);
    expect(item?.description).toBe(
      `running · 3s · Review the introduction for clarity and tone. ${'x'.repeat(53)}…`,
    );
  });

  it('uses the latest instruction while a resumed turn is still running', () => {
    const { entries, streams } = childFixture('root', {
      activeOnly: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'reviewer',
          childStreamId: 'child-a',
          status: STREAM_PHASE.RUNNING,
        },
      ],
      extraStreams: new Map([
        [
          'child-a',
          slice({
            streamId: 'child-a',
            status: STREAM_PHASE.RUNNING,
            entries: [
              {
                id: 'turn-1-user',
                role: 'user',
                messageType: MESSAGE_TYPES.USER_MESSAGE,
                text: 'Review the introduction.',
                finalized: true,
              },
              {
                id: 'turn-1-response',
                role: 'assistant',
                messageType: MESSAGE_TYPES.MODEL_RESPONSE,
                text: 'The introduction is clear.',
                finalized: true,
              },
              {
                id: 'turn-1-tokens',
                role: 'assistant',
                messageType: MESSAGE_TYPES.DEFAULT,
                text: 'Tokens',
                finalized: true,
              },
              {
                id: 'turn-2-user',
                role: 'user',
                messageType: MESSAGE_TYPES.USER_MESSAGE,
                text: 'Now check the conclusion.',
                finalized: true,
              },
              {
                id: 'turn-2-response',
                role: 'assistant',
                messageType: MESSAGE_TYPES.MODEL_RESPONSE,
                text: 'Still checking the conclusion.',
                finalized: false,
              },
              {
                id: 'turn-2-duration',
                role: 'assistant',
                messageType: MESSAGE_TYPES.DEFAULT,
                text: 'Turn completed in 2s',
                finalized: false,
              },
            ],
          }),
        ],
      ]),
    });

    expect(buildChildControlItems('root', entries, streams)).toMatchObject([
      {
        description: 'running · Now check the conclusion.',
      },
    ]);
  });

  it('ignores bookkeeping rows after the latest finalized model response', () => {
    const { entries, streams } = childFixture('root', {
      activeOnly: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'reviewer',
          childStreamId: 'child-a',
          status: STREAM_PHASE.WAITING,
        },
      ],
      extraStreams: new Map([
        [
          'child-a',
          slice({
            streamId: 'child-a',
            status: STREAM_PHASE.WAITING,
            entries: [
              {
                id: 'turn-user',
                role: 'user',
                messageType: MESSAGE_TYPES.USER_MESSAGE,
                text: 'Check the conclusion.',
                finalized: true,
              },
              {
                id: 'turn-response',
                role: 'assistant',
                messageType: MESSAGE_TYPES.MODEL_RESPONSE,
                text: 'The conclusion follows from the stated assumptions.',
                finalized: true,
              },
              {
                id: 'turn-tokens',
                role: 'assistant',
                messageType: MESSAGE_TYPES.DEFAULT,
                text: 'Tokens',
                finalized: true,
              },
              {
                id: 'turn-duration',
                role: 'assistant',
                messageType: MESSAGE_TYPES.DEFAULT,
                text: 'Turn completed in 2s',
                finalized: true,
              },
            ],
          }),
        ],
      ]),
    });

    expect(buildChildControlItems('root', entries, streams)).toMatchObject([
      {
        description:
          'waiting for you · The conclusion follows from the stated assumptions.',
      },
    ]);
  });

  it('derives live elapsed text for running child executions', () => {
    const parentSlice = slice({
      activeProcesses: [
        {
          kind: 'process',
          executionId: 'proc-1',
          agentName: 'latexmk',
          status: 'waiting',
          startedAt: 1_000,
          elapsed: '1s',
        },
      ],
    });
    const { entries, streams } = childFixture('root', {
      parentSlice,
      activeOnly: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'critic',
          childStreamId: 'child-a',
          status: 'running',
          startedAt: 1_000,
          elapsed: '1s',
        },
      ],
    });

    expect(
      buildChildControlItems('root', entries, streams, 62_000),
    ).toMatchObject([
      {
        executionId: 'agent-1',
        description: 'running · 1m 1s',
        elapsed: '1m 1s',
      },
      {
        // Non-running process: startedAt is ignored, the roster elapsed wins.
        executionId: 'proc-1',
        elapsed: '1s',
      },
    ]);
    expect(childElapsed(parentSlice.activeProcesses[0], 62_000)).toBe('1s');
    expect(
      childElapsed(
        { startedAt: 0, status: STREAM_PHASE.RUNNING, elapsed: '1s' },
        7_501_234,
      ),
    ).toBe('2h 5m');
  });

  it('uses CLI-facing labels in row descriptions', () => {
    const parentSlice = slice({
      activeProcesses: [
        {
          kind: 'process',
          executionId: 'proc-1',
          agentName: 'bash',
          status: STREAM_PHASE.WAITING,
          elapsed: '3s',
        },
      ],
      processOutput: new Map([['proc-1', tail('last line')]]),
    });
    const { entries, streams } = childFixture('root', {
      parentSlice,
      activeOnly: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'review',
          childStreamId: 'child-a',
          status: STREAM_PHASE.WAITING,
          elapsed: '20s',
        },
      ],
    });

    expect(buildChildControlItems('root', entries, streams)).toMatchObject([
      {
        executionId: 'agent-1',
        description: 'waiting for you · 20s',
        statusLabel: 'waiting for you',
      },
      {
        executionId: 'proc-1',
        description: 'waiting for you · 3s · last line',
        statusLabel: 'waiting for you',
      },
    ]);
  });

  it('keys live child elapsed timers by active execution identity', () => {
    expect(liveChildExecutionElapsedKey([], [])).toBeUndefined();

    const activeSubagents = activeSubagentsFor(
      'root',
      buildChildStreamEntries({
        parentStreamId: 'root',
        activeOnly: [
          {
            kind: 'subagent',
            childStreamId: 'agent-2-stream',
            executionId: 'agent-2',
            agentName: 'critic',
            status: 'running',
            startedAt: 2_000,
          },
          {
            kind: 'subagent',
            childStreamId: 'agent-1-stream',
            executionId: 'agent-1',
            agentName: 'reviewer',
            status: STREAM_PHASE.RUNNING,
            startedAt: 1_000,
          },
        ],
      }),
      new Map([
        [
          'agent-2-stream',
          slice({ streamId: 'agent-2-stream', status: 'running' }),
        ],
        [
          'agent-1-stream',
          slice({
            streamId: 'agent-1-stream',
            status: STREAM_PHASE.RUNNING,
          }),
        ],
      ]),
    );
    const activeProcesses = [
      {
        kind: 'process' as const,
        executionId: 'proc-1',
        agentName: 'latexmk',
        status: 'waiting',
        startedAt: 500,
        elapsed: '1s',
      },
    ];

    expect(liveChildExecutionElapsedKey(activeSubagents, activeProcesses)).toBe(
      'agent-1:1000,agent-2:2000',
    );
    expect(
      liveChildExecutionElapsedKey(
        activeSubagentsFor(
          'root',
          buildChildStreamEntries({
            parentStreamId: 'root',
            activeOnly: [
              {
                kind: 'subagent',
                childStreamId: 'agent-1-stream',
                executionId: 'agent-1',
                agentName: 'critic',
                status: 'completed',
                startedAt: 1_000,
                elapsed: '1s',
              },
            ],
          }),
          new Map([
            [
              'agent-1-stream',
              slice({ streamId: 'agent-1-stream', status: 'completed' }),
            ],
          ]),
        ),
        [],
      ),
    ).toBeUndefined();
  });

  it('uses stream descriptions as visible task commands', () => {
    const { entries, streams } = childFixture('root', {
      activeOnly: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'bash',
          childStreamId: 'child-a',
          status: 'running',
        },
      ],
      extraStreams: new Map([
        [
          'child-a',
          slice({
            streamId: 'child-a',
            status: 'running',
            description: 'timeout 1800 texra run paper',
            entries: [
              {
                id: 'entry-1',
                role: 'assistant',
                text: 'line one\nline two',
                finalized: true,
              },
            ],
          }),
        ],
      ]),
    });

    expect(buildChildControlItems('root', entries, streams)).toMatchObject([
      {
        executionId: 'agent-1',
        label: 'bash',
        command: 'timeout 1800 texra run paper',
        // Subagent transcripts are read by focusing the session, never
        // flattened into a detail tail.
        tailLines: [],
      },
    ]);
  });

  it('keeps retained subagent streams selectable after they leave the active list', () => {
    const { entries, streams } = childFixture('root', {
      retained: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'critic',
          childStreamId: 'child-a',
          status: 'completed',
          active: false,
        },
        {
          kind: 'subagent',
          executionId: 'agent-2',
          agentName: 'polisher',
          childStreamId: 'child-b',
          status: 'running',
        },
      ],
    });

    expect(buildChildControlItems('root', entries, streams)).toMatchObject([
      {
        executionId: 'agent-1',
        childStreamId: 'child-a',
        kind: 'subagent',
        label: 'critic',
        description: 'completed',
        killable: false,
      },
      {
        executionId: 'agent-2',
        childStreamId: 'child-b',
        kind: 'subagent',
        label: 'polisher',
        description: 'running',
        killable: true,
      },
    ]);
  });

  it('keeps retained subagent streams visible in the side-panel row model', () => {
    const { entries, streams } = childFixture('root', {
      retained: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'critic',
          childStreamId: 'child-a',
          status: 'completed',
          active: false,
        },
        {
          kind: 'subagent',
          executionId: 'agent-2',
          agentName: 'polisher',
          childStreamId: 'child-b',
          status: 'running',
        },
      ],
    });

    expect(visibleSubagentRows('root', entries, streams)).toMatchObject([
      {
        kind: 'subagent',
        executionId: 'agent-1',
        childStreamId: 'child-a',
        status: 'completed',
      },
      {
        kind: 'subagent',
        executionId: 'agent-2',
        childStreamId: 'child-b',
        status: 'running',
      },
    ]);
    expect(hasChildControlItems('root', entries, streams)).toBe(true);
  });

  it('keeps stopped subagents in their retained task order', () => {
    const { entries, streams } = childFixture('root', {
      retained: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'critic',
          childStreamId: 'child-a',
          status: STREAM_PHASE.CANCELLED,
          active: false,
        },
        {
          kind: 'subagent',
          executionId: 'agent-2',
          agentName: 'polisher',
          childStreamId: 'child-b',
          status: 'running',
        },
      ],
    });

    expect(buildChildControlItems('root', entries, streams)).toMatchObject([
      {
        kind: 'subagent',
        executionId: 'agent-1',
        childStreamId: 'child-a',
        label: 'critic',
        statusLabel: 'stopped',
        killable: false,
      },
      {
        kind: 'subagent',
        executionId: 'agent-2',
        childStreamId: 'child-b',
        label: 'polisher',
        statusLabel: 'running',
        killable: true,
      },
    ]);
  });

  it('opens the child side panel when only retained subagent streams remain', () => {
    const { entries, streams } = childFixture('root', {
      retained: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'critic',
          childStreamId: 'child-a',
          status: 'completed',
          active: false,
        },
      ],
    });

    expect(hasChildControlItems('root', entries, streams)).toBe(true);
  });

  it('falls back to the parent subagent list when the focused child is a leaf', () => {
    const { entries, streams } = childFixture('main', {
      activeOnly: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'review',
          childStreamId: 'review-stream',
          status: 'running',
        },
      ],
    });
    const target = resolveChildExecutionPanelTarget({
      activeStreamId: 'review-stream',
      childStreamEntries: entries,
      parentStream: new Map([['review-stream', 'main']]),
      streams,
    });

    expect(target.streamId).toBe('main');
    expect(target.fallbackFromStreamId).toBe('review-stream');
    expect(target.hasItems).toBe(true);
    expect(buildChildControlItems('main', entries, streams)).toMatchObject([
      {
        executionId: 'agent-1',
        childStreamId: 'review-stream',
        kind: 'subagent',
        label: 'review',
      },
    ]);
  });

  it('labels child-control stream scopes with friendly stream names', () => {
    const { entries, streams } = childFixture('main', {
      activeOnly: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'review',
          childStreamId: 'review-stream',
          status: 'running',
        },
      ],
    });
    const parentStream = new Map([['review-stream', 'main']] as const);

    expect(
      streamDisplayLabel({
        childStreamEntries: entries,
        parentStream,
        streamId: 'main',
        streams,
      }),
    ).toBe('main');
    expect(
      streamDisplayLabel({
        childStreamEntries: entries,
        parentStream,
        streamId: 'review-stream',
        streams,
      }),
    ).toBe('review');
  });

  it('keeps subagent controls on the focused child when it has descendants', () => {
    const { entries, streams } = childFixture('review-stream', {
      activeOnly: [
        {
          kind: 'subagent',
          executionId: 'agent-2',
          agentName: 'detail-review',
          childStreamId: 'detail-stream',
          status: 'running',
        },
      ],
    });
    const target = resolveChildExecutionPanelTarget({
      activeStreamId: 'review-stream',
      childStreamEntries: entries,
      parentStream: new Map([['review-stream', 'main']]),
      streams,
    });

    expect(target.streamId).toBe('review-stream');
    expect(target.hasItems).toBe(true);
    expect(
      buildChildControlItems('review-stream', entries, streams),
    ).toMatchObject([
      {
        executionId: 'agent-2',
        childStreamId: 'detail-stream',
        kind: 'subagent',
        label: 'detail-review',
      },
    ]);
  });

  it('keeps a leaf child selected when the parent has no visible subagents', () => {
    const child = slice({ streamId: 'review-stream' });
    const target = resolveChildExecutionPanelTarget({
      activeStreamId: 'review-stream',
      childStreamEntries: new Map(),
      parentStream: new Map([['review-stream', 'main']]),
      streams: new Map([
        ['main', slice({ streamId: 'main' })],
        ['review-stream', child],
      ]),
    });

    expect(target.streamId).toBe('review-stream');
    expect(target.slice).toBe(child);
    expect(target.hasItems).toBe(false);
  });

  it('falls back to the nearest ancestor subagent list when a focused grandchild is a leaf', () => {
    const { entries, streams: mainFixtureStreams } = childFixture('main', {
      activeOnly: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'review',
          childStreamId: 'review-stream',
          status: 'running',
        },
      ],
    });
    const streams = new Map([
      ...mainFixtureStreams,
      ['review-stream', slice({ streamId: 'review-stream' })],
      ['detail-stream', slice({ streamId: 'detail-stream' })],
    ]);
    const target = resolveChildExecutionPanelTarget({
      activeStreamId: 'detail-stream',
      childStreamEntries: entries,
      parentStream: new Map([
        ['review-stream', 'main'],
        ['detail-stream', 'review-stream'],
      ]),
      streams,
    });

    expect(target.streamId).toBe('main');
    expect(target.fallbackFromStreamId).toBe('detail-stream');
    expect(target.hasItems).toBe(true);
    expect(buildChildControlItems('main', entries, streams)).toMatchObject([
      {
        executionId: 'agent-1',
        childStreamId: 'review-stream',
        kind: 'subagent',
        label: 'review',
      },
    ]);
  });

  it('falls back to retained parent task rows when only stopped child streams remain', () => {
    const { entries, streams } = childFixture('main', {
      retained: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'review',
          childStreamId: 'review-stream',
          status: STREAM_PHASE.CANCELLED,
          active: false,
        },
      ],
    });
    const target = resolveChildExecutionPanelTarget({
      activeStreamId: 'review-stream',
      childStreamEntries: entries,
      parentStream: new Map([['review-stream', 'main']]),
      streams,
    });

    expect(target.streamId).toBe('main');
    expect(target.fallbackFromStreamId).toBe('review-stream');
    expect(target.hasItems).toBe(true);
    expect(buildChildControlItems('main', entries, streams)).toMatchObject([
      {
        executionId: 'agent-1',
        childStreamId: 'review-stream',
        kind: 'subagent',
        label: 'review',
        statusLabel: 'stopped',
        killable: false,
      },
    ]);
  });

  it('keeps task controls scoped to the focused child stream when it has work', () => {
    const child = slice({
      streamId: 'review-stream',
      activeProcesses: [
        {
          kind: 'process',
          executionId: 'proc-1',
          agentName: 'latexmk',
          status: 'running',
        },
      ],
    });
    const { entries, streams: mainFixtureStreams } = childFixture('main', {
      activeOnly: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'review',
          childStreamId: 'review-stream',
          status: 'running',
        },
      ],
    });
    const streams = new Map([...mainFixtureStreams, ['review-stream', child]]);
    const target = resolveChildExecutionPanelTarget({
      activeStreamId: 'review-stream',
      childStreamEntries: entries,
      parentStream: new Map([['review-stream', 'main']]),
      streams,
    });

    expect(target.streamId).toBe('review-stream');
    expect(target.slice).toBe(child);
    expect(target.hasItems).toBe(true);
    expect(
      buildChildControlItems('review-stream', entries, streams),
    ).toMatchObject([
      {
        executionId: 'proc-1',
        kind: 'process',
        label: 'latexmk',
      },
    ]);
  });

  it('keeps task detail key handling independent of Ink rendering', () => {
    expect(childPickerKeyAction({ input: '', escape: true })).toEqual({
      kind: 'close',
    });
    expect(childPickerKeyAction({ input: '\u001B' })).toEqual({
      kind: 'close',
    });
    expect(childPickerKeyAction({ input: '\u001Bp' })).toEqual({
      kind: 'ignore',
    });
    expect(childPickerKeyAction({ input: '', return: true })).toEqual({
      kind: 'select',
    });
    expect(childPickerKeyAction({ input: 'k' })).toEqual({ kind: 'kill' });
    // Digit jumps retired with the picker; Alt/Esc-1..9 focuses streams now.
    expect(childPickerKeyAction({ input: '3' })).toEqual({ kind: 'ignore' });
  });

  it('keeps Esc back readable in narrow task detail hints', () => {
    expect(
      taskDetailKeyHintsForColumns({
        availableColumns: 40,
        canFocusStream: true,
        canKill: true,
        showScrollHint: true,
      }),
    ).toEqual([
      { key: '↑/↓', action: 'scroll' },
      { key: 'f', action: 'focus' },
      { key: 'Esc', action: 'back' },
    ]);
    expect(
      taskDetailKeyHintsForColumns({
        availableColumns: 50,
        canFocusStream: true,
        canKill: true,
        showScrollHint: true,
      }),
    ).toEqual([
      { key: '↑/↓', action: 'scroll' },
      { key: 'f', action: 'focus' },
      { key: 'k', action: 'kill' },
      { key: 'Esc', action: 'back' },
    ]);
    expect(
      taskDetailKeyHintsForColumns({
        availableColumns: 60,
        canFocusStream: true,
        canKill: true,
        showScrollHint: true,
      }),
    ).toEqual([
      { key: '↑/↓', action: 'scroll' },
      { key: 'f', action: 'focus stream' },
      { key: 'k', action: 'kill' },
      { key: 'Esc', action: 'back' },
    ]);
  });

  it('surfaces PgUp/PgDn and g/G hints once the terminal is wide enough', () => {
    expect(
      taskDetailKeyHintsForColumns({
        availableColumns: 60,
        canFocusStream: true,
        canKill: true,
        showScrollHint: true,
      }),
    ).not.toContainEqual({ key: 'PgUp/PgDn', action: 'page' });
    expect(
      taskDetailKeyHintsForColumns({
        availableColumns: 84,
        canFocusStream: true,
        canKill: true,
        showScrollHint: true,
      }),
    ).toEqual([
      { key: '↑/↓', action: 'scroll' },
      { key: 'PgUp/PgDn', action: 'page' },
      { key: 'g/G', action: 'top/bottom' },
      { key: 'f', action: 'focus stream' },
      { key: 'k', action: 'kill' },
      { key: 'Esc', action: 'back' },
    ]);
    expect(
      taskDetailKeyHintsForColumns({
        availableColumns: undefined,
        canFocusStream: true,
        canKill: true,
        showScrollHint: true,
      }),
    ).toEqual([
      { key: '↑/↓', action: 'scroll' },
      { key: 'PgUp/PgDn', action: 'page' },
      { key: 'g/G', action: 'top/bottom' },
      { key: 'f', action: 'focus stream' },
      { key: 'k', action: 'kill' },
      { key: 'Esc', action: 'back' },
    ]);
    // No content to page/jump through: the paging hints stay hidden even
    // when there's plenty of width, same as the arrow-key scroll hint.
    expect(
      taskDetailKeyHintsForColumns({
        availableColumns: 84,
        canFocusStream: true,
        canKill: true,
        showScrollHint: false,
      }),
    ).not.toContainEqual({ key: 'PgUp/PgDn', action: 'page' });
  });

  it('budgets compact task detail output by wrapped terminal rows', () => {
    expect(taskDetailWrappedRowCount('abcd', 4)).toBe(1);
    expect(taskDetailWrappedRowCount('abcde', 4)).toBe(2);
    const mixedLines = ['x'.repeat(180), 'short 1', 'short 2', 'short 3'];
    expect(
      taskDetailVisibleOutputRowsFromOffsetForColumns({
        availableColumns: 80,
        compact: true,
        tailLines: mixedLines,
        visibleRowBudget: 3,
        offset: 0,
      }),
    ).toEqual(['x'.repeat(76), 'x'.repeat(76), 'x'.repeat(28)]);
    expect(
      taskDetailVisibleOutputRowsFromOffsetForColumns({
        availableColumns: 80,
        compact: true,
        tailLines: mixedLines,
        visibleRowBudget: 3,
        offset: 3,
      }),
    ).toEqual(['short 1', 'short 2', 'short 3']);
    const wrappedRows = taskDetailVisibleOutputRowsFromOffsetForColumns({
      availableColumns: 48,
      compact: true,
      tailLines: [
        'strategy detail line 01 wide output wraps wide output wraps wide output wraps',
      ],
      visibleRowBudget: 2,
      offset: 0,
    });
    expect(wrappedRows).toHaveLength(2);
    expect(wrappedRows.join('\n')).toContain('wide output wraps');
    const singleLongLine = ['abcdefghijklmnop'];
    expect(
      taskDetailScrollableOutputRowCountForColumns({
        availableColumns: 10,
        compact: true,
        tailLines: singleLongLine,
      }),
    ).toBe(3);
    expect(
      taskDetailFollowTailScrollOffsetForColumns({
        availableColumns: 10,
        compact: true,
        tailLines: singleLongLine,
        visibleRowBudget: 1,
      }),
    ).toBe(2);
    expect(
      taskDetailVisibleOutputRowsFromOffsetForColumns({
        availableColumns: 10,
        compact: true,
        tailLines: singleLongLine,
        visibleRowBudget: 1,
        offset: 0,
      }),
    ).toEqual(['abcdef']);
    expect(
      taskDetailVisibleOutputRowsFromOffsetForColumns({
        availableColumns: 10,
        compact: true,
        tailLines: singleLongLine,
        visibleRowBudget: 1,
        offset: 2,
      }),
    ).toEqual(['mnop']);
    expect(
      taskDetailVisibleOutputRowsFromOffsetForColumns({
        availableColumns: 10,
        compact: true,
        tailLines: singleLongLine,
        visibleRowBudget: 1,
        offset: taskDetailFollowTailScrollOffsetForColumns({
          availableColumns: 10,
          compact: true,
          tailLines: singleLongLine,
          visibleRowBudget: 1,
        }),
      }),
    ).toEqual(['mnop']);
  });

  it('switches task detail to ultra-compact rendering before bordered content clips', () => {
    expect(isUltraCompactTaskDetailRows(4)).toBe(true);
    expect(isUltraCompactTaskDetailRows(5)).toBe(false);
  });

  it('labels task detail metadata by execution type', () => {
    expect(taskDetailCommandLabel('process')).toBe('Command');
    expect(taskDetailCommandLabel('subagent')).toBe('Description');
    expect(TASK_DETAIL_LABEL_WIDTH).toBeGreaterThanOrEqual(
      'Description:'.length,
    );
  });

  it('preserves output rows in compact task detail views', () => {
    expect(
      computeTaskDetailLayout({
        availableRows: 12,
        hasTailLines: true,
        metaRows: 4,
      }),
    ).toMatchObject({
      compact: true,
      showCommand: true,
      showHints: true,
      visibleLineCount: 5,
    });
  });

  it('reserves tiny task detail rows for controls before labels', () => {
    expect(
      computeTaskDetailLayout({
        availableRows: 5,
        hasTailLines: true,
        metaRows: 4,
      }),
    ).toMatchObject({
      compact: true,
      showHints: true,
      showOutputLabel: false,
      showTitle: false,
      visibleLineCount: 1,
    });
    expect(
      computeTaskDetailLayout({
        availableRows: 6,
        hasTailLines: true,
        metaRows: 4,
      }),
    ).toMatchObject({
      compact: true,
      showHints: true,
      showOutputLabel: false,
      showTitle: false,
      visibleLineCount: 2,
    });
  });

  it('does not lose compact task detail output rows as height grows', () => {
    const outputRowsByHeight = [6, 7, 8, 9, 10, 11, 12].map(
      (availableRows) =>
        computeTaskDetailLayout({
          availableRows,
          hasTailLines: true,
          metaRows: 4,
        }).visibleLineCount,
    );

    expect(outputRowsByHeight).toEqual([2, 3, 4, 4, 4, 5, 5]);
  });

  it('opens long task detail output at the latest visible tail', () => {
    expect(taskDetailInitialScrollOffset(2, 5)).toBe(0);
    expect(taskDetailInitialScrollOffset(12, 5)).toBe(7);
    expect(taskDetailInitialScrollOffset(12, 0)).toBe(12);
  });

  it('preserves manual task detail scrolling while new output arrives', () => {
    const tailing = { executionId: 'task-1', followsTail: true, offset: 7 };
    expect(syncTaskDetailScrollState(tailing, 'task-1', 8)).toEqual({
      executionId: 'task-1',
      followsTail: true,
      offset: 8,
    });
    expect(taskDetailVisibleScrollOffset(tailing, 8)).toBe(8);
    expect(syncTaskDetailScrollState(tailing, 'task-1', 8, 4)).toEqual({
      executionId: 'task-1',
      followsTail: true,
      offset: 4,
    });
    expect(taskDetailVisibleScrollOffset(tailing, 8, 4)).toBe(4);

    const scrolled = moveTaskDetailScrollState(tailing, 7, 'up');
    expect(scrolled).toEqual({
      executionId: 'task-1',
      followsTail: false,
      offset: 6,
    });
    expect(taskDetailVisibleScrollOffset(scrolled, 8)).toBe(6);
    expect(syncTaskDetailScrollState(scrolled, 'task-1', 8)).toEqual({
      executionId: 'task-1',
      followsTail: false,
      offset: 6,
    });
    expect(syncTaskDetailScrollState(scrolled, 'task-2', 3)).toEqual({
      executionId: 'task-2',
      followsTail: true,
      offset: 3,
    });
  });

  it('anchors manual task detail scrolling when earlier output rewraps', () => {
    const availableColumns = 20;
    const visibleRowBudget = 1;
    const beforeLines = ['intro', 'target marker', 'after'];
    const beforeContext = {
      availableColumns,
      compact: true,
      tailLines: beforeLines,
    };
    const beforeScrollableRows =
      taskDetailScrollableOutputRowCountForColumns(beforeContext);
    const beforeMaxOffset = taskDetailInitialScrollOffset(
      beforeScrollableRows,
      visibleRowBudget,
    );
    const beforeFollowOffset = taskDetailFollowTailScrollOffsetForColumns({
      ...beforeContext,
      visibleRowBudget,
    });

    const manual = moveTaskDetailScrollState(
      { executionId: 'task-1', followsTail: true, offset: beforeFollowOffset },
      beforeMaxOffset,
      'up',
      beforeFollowOffset,
      beforeContext,
    );

    expect(manual).toEqual({
      anchor: { lineIndex: 1, wrappedRowOffset: 0 },
      executionId: 'task-1',
      followsTail: false,
      offset: 1,
    });

    const afterLines = [
      'intro expanded before anchor '.repeat(2),
      'target marker',
      'after',
    ];
    const afterContext = {
      availableColumns,
      compact: true,
      tailLines: afterLines,
    };
    const afterMaxOffset = taskDetailInitialScrollOffset(
      taskDetailScrollableOutputRowCountForColumns(afterContext),
      visibleRowBudget,
    );
    const afterFollowOffset = taskDetailFollowTailScrollOffsetForColumns({
      ...afterContext,
      visibleRowBudget,
    });
    const synced = syncTaskDetailScrollState(
      manual,
      'task-1',
      afterMaxOffset,
      afterFollowOffset,
      afterContext,
    );
    const visibleOffset = taskDetailVisibleScrollOffset(
      synced,
      afterMaxOffset,
      afterFollowOffset,
      afterContext,
    );

    expect(visibleOffset).toBeGreaterThan(manual.offset);
    expect(
      taskDetailVisibleOutputRowsFromOffsetForColumns({
        ...afterContext,
        offset: visibleOffset,
        visibleRowBudget,
      }),
    ).toEqual(['target marker']);
  });

  it('moves task detail scroll from the visible tail position', () => {
    const tailing = { executionId: 'task-1', followsTail: true, offset: 7 };
    expect(moveTaskDetailScrollState(tailing, 9, 'up')).toEqual({
      executionId: 'task-1',
      followsTail: false,
      offset: 8,
    });
    expect(moveTaskDetailScrollState(tailing, 9, 'down')).toEqual({
      executionId: 'task-1',
      followsTail: true,
      offset: 9,
    });
    expect(moveTaskDetailScrollState(tailing, 9, 'down', 4)).toEqual({
      executionId: 'task-1',
      followsTail: false,
      offset: 5,
    });
    expect(
      moveTaskDetailScrollState(
        { executionId: 'task-1', followsTail: false, offset: 5 },
        9,
        'up',
        4,
      ),
    ).toEqual({
      executionId: 'task-1',
      followsTail: true,
      offset: 4,
    });
    expect(
      moveTaskDetailScrollState(
        { executionId: 'task-1', followsTail: false, offset: 8 },
        9,
        'down',
        4,
      ),
    ).toEqual({
      executionId: 'task-1',
      followsTail: false,
      offset: 9,
    });
    expect(
      taskDetailVisibleScrollOffset(
        { executionId: 'task-1', followsTail: false, offset: 9 },
        9,
        4,
      ),
    ).toBe(9);
  });

  it('clamps task detail scroll movement at output boundaries', () => {
    const top = { executionId: 'task-1', followsTail: false, offset: 0 };
    expect(moveTaskDetailScrollState(top, 9, 'up')).toEqual({
      executionId: 'task-1',
      followsTail: false,
      offset: 0,
    });

    const bottom = { executionId: 'task-1', followsTail: true, offset: 9 };
    expect(moveTaskDetailScrollState(bottom, 9, 'down')).toEqual({
      executionId: 'task-1',
      followsTail: true,
      offset: 9,
    });
  });

  it('pages task detail scroll by the visible row budget (PgUp/PgDn)', () => {
    const tailing = { executionId: 'task-1', followsTail: true, offset: 9 };
    expect(pageTaskDetailScrollState(tailing, 9, 'up', 3)).toEqual({
      executionId: 'task-1',
      followsTail: false,
      offset: 6,
    });
    expect(
      pageTaskDetailScrollState(
        { executionId: 'task-1', followsTail: false, offset: 6 },
        9,
        'up',
        3,
      ),
    ).toEqual({
      executionId: 'task-1',
      followsTail: false,
      offset: 3,
    });
    expect(
      pageTaskDetailScrollState(
        { executionId: 'task-1', followsTail: false, offset: 3 },
        9,
        'down',
        3,
      ),
    ).toEqual({
      executionId: 'task-1',
      followsTail: false,
      offset: 6,
    });

    // Clamps at the boundaries instead of overshooting.
    const top = { executionId: 'task-1', followsTail: false, offset: 1 };
    expect(pageTaskDetailScrollState(top, 9, 'up', 3)).toEqual({
      executionId: 'task-1',
      followsTail: false,
      offset: 0,
    });
    expect(
      pageTaskDetailScrollState(
        { executionId: 'task-1', followsTail: false, offset: 8 },
        9,
        'down',
        3,
        9,
      ),
    ).toEqual({
      executionId: 'task-1',
      followsTail: true,
      offset: 9,
    });

    // A page landing exactly on the follow offset re-arms tail-following.
    expect(
      pageTaskDetailScrollState(
        { executionId: 'task-1', followsTail: false, offset: 3 },
        9,
        'down',
        3,
        6,
      ),
    ).toEqual({
      executionId: 'task-1',
      followsTail: true,
      offset: 6,
    });

    // A zero/negative page size still advances by at least one row.
    expect(pageTaskDetailScrollState(tailing, 9, 'up', 0)).toEqual({
      executionId: 'task-1',
      followsTail: false,
      offset: 8,
    });
  });

  it('jumps task detail scroll to the top and back to the tail (g/G)', () => {
    const manual = { executionId: 'task-1', followsTail: false, offset: 4 };
    expect(jumpTaskDetailScrollState(manual, 9, 'top')).toEqual({
      executionId: 'task-1',
      followsTail: false,
      offset: 0,
    });
    expect(jumpTaskDetailScrollState(manual, 9, 'bottom')).toEqual({
      executionId: 'task-1',
      followsTail: true,
      offset: 9,
    });
    expect(jumpTaskDetailScrollState(manual, 9, 'bottom', 4)).toEqual({
      executionId: 'task-1',
      followsTail: true,
      offset: 4,
    });

    const tailing = { executionId: 'task-1', followsTail: true, offset: 9 };
    expect(jumpTaskDetailScrollState(tailing, 9, 'top')).toEqual({
      executionId: 'task-1',
      followsTail: false,
      offset: 0,
    });
  });

  it('anchors a PgUp jump when earlier output rewraps, like manual scrolling', () => {
    const availableColumns = 20;
    const visibleRowBudget = 1;
    const beforeLines = ['intro', 'target marker', 'after'];
    const beforeContext = {
      availableColumns,
      compact: true,
      tailLines: beforeLines,
    };
    const beforeMaxOffset = taskDetailInitialScrollOffset(
      taskDetailScrollableOutputRowCountForColumns(beforeContext),
      visibleRowBudget,
    );
    const beforeFollowOffset = taskDetailFollowTailScrollOffsetForColumns({
      ...beforeContext,
      visibleRowBudget,
    });

    const paged = pageTaskDetailScrollState(
      { executionId: 'task-1', followsTail: true, offset: beforeFollowOffset },
      beforeMaxOffset,
      'up',
      1,
      beforeFollowOffset,
      beforeContext,
    );

    expect(paged).toEqual({
      anchor: { lineIndex: 1, wrappedRowOffset: 0 },
      executionId: 'task-1',
      followsTail: false,
      offset: 1,
    });

    const afterLines = [
      'intro expanded before anchor '.repeat(2),
      'target marker',
      'after',
    ];
    const afterContext = {
      availableColumns,
      compact: true,
      tailLines: afterLines,
    };
    const afterMaxOffset = taskDetailInitialScrollOffset(
      taskDetailScrollableOutputRowCountForColumns(afterContext),
      visibleRowBudget,
    );
    const afterFollowOffset = taskDetailFollowTailScrollOffsetForColumns({
      ...afterContext,
      visibleRowBudget,
    });
    const synced = syncTaskDetailScrollState(
      paged,
      'task-1',
      afterMaxOffset,
      afterFollowOffset,
      afterContext,
    );
    const visibleOffset = taskDetailVisibleScrollOffset(
      synced,
      afterMaxOffset,
      afterFollowOffset,
      afterContext,
    );

    expect(visibleOffset).toBeGreaterThan(paged.offset);
    expect(
      taskDetailVisibleOutputRowsFromOffsetForColumns({
        ...afterContext,
        offset: visibleOffset,
        visibleRowBudget,
      }),
    ).toEqual(['target marker']);
  });
});
