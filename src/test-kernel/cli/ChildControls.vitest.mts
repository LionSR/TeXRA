// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - CLI TUI state
import {
  compactPickerOverflowText,
  computePickerListLayout,
  computeTaskDetailLayout,
  emptyPickerText,
  isUltraCompactPickerRows,
  isUltraCompactTaskDetailRows,
  pickerKeyHints,
  pickerKeyHintsForColumns,
  pickerTitle,
  TASK_DETAIL_LABEL_WIDTH,
  taskDetailCommandLabel,
  taskDetailKeyHintsForColumns,
} from '@cli/chat/tui/modals/ChildControlPicker';
import {
  jumpTaskDetailScrollState,
  moveTaskDetailScrollState,
  pageTaskDetailScrollState,
  syncTaskDetailScrollState,
  taskDetailFollowTailScrollOffsetForColumns,
  taskDetailInitialScrollOffset,
  taskDetailScrollableOutputRowCountForColumns,
  taskDetailVisibleLineCountFromOffsetForColumns,
  taskDetailVisibleOutputRowsFromOffsetForColumns,
  taskDetailVisibleScrollOffset,
  taskDetailWrappedRowCount,
} from '@cli/chat/tui/state/taskDetailScroll';
import {
  buildChildControlItems,
  childElapsed,
  childPickerKeyAction,
  hasChildControlItems,
  liveChildExecutionElapsedKey,
  nextPickerIndex,
  numericFocusTargetForActiveStream,
  resolveChildControlDisplayTargets,
  resolveChildControlStreamTarget,
} from '@cli/chat/tui/state/childControls';
import { visibleSubagentRows } from '@cli/chat/tui/state/childExecutions';
import { streamDisplayLabel } from '@cli/chat/tui/state/streamViews';
import {
  NO_BYPASS,
  type ProcessOutputTail,
  type StreamSlice,
} from '@cli/chat/tui/state/cliState';

// Local imports - shared schemas
import {
  STREAM_STATUS,
  TOOL_USE_STATUS,
  type NormalizedToolUse,
} from '@shared/schemas';

function tail(stdout: string, stderr = ''): ProcessOutputTail {
  return { stdout, stderr };
}

function toolUse(
  toolName: string,
  input: unknown,
  overrides: Partial<NormalizedToolUse> = {},
): NormalizedToolUse {
  return {
    parsed: {},
    toolName,
    errorText: '',
    outputText: '',
    userInstructionText: '',
    input,
    isError: false,
    isUserFeedback: false,
    headerSummary: '',
    status: TOOL_USE_STATUS.COMPLETED,
    ...overrides,
  };
}

function slice(
  overrides: Partial<StreamSlice> = {},
): Pick<
  StreamSlice,
  'activeProcesses' | 'activeSubagents' | 'childStreams' | 'processOutput'
> &
  StreamSlice {
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
    activeSubagents: [],
    activeProcesses: [],
    childStreams: [],
    todos: [],
    plan: null,
    processOutput: new Map(),
    bypass: NO_BYPASS,
    ...overrides,
  };
}

describe('CLI child execution controls', () => {
  it('maps Alt-number focus jumps to visible descendant streams', () => {
    const root = slice({
      // Only subagents own a stream tab, so both live-only ("agent-1", still in
      // activeSubagents but not yet retained in childStreams) and
      // retained ("agent-2") subagent rows are valid focus-jump targets —
      // background processes never are.
      activeSubagents: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'critic',
          childStreamId: 'child-a',
        },
        {
          kind: 'subagent',
          executionId: 'agent-3',
          agentName: 'bash',
          childStreamId: 'child-b',
        },
      ],
      childStreams: [
        {
          kind: 'subagent',
          executionId: 'agent-2',
          agentName: 'critic',
          childStreamId: 'child-c',
        },
      ],
    });
    const streams = new Map<StreamSlice['streamId'], StreamSlice>([
      ['root', root],
      ['child-b', slice({ streamId: 'child-b' })],
      ['child-c', slice({ streamId: 'child-c' })],
    ]);

    expect(
      numericFocusTargetForActiveStream({
        activeStreamId: 'root',
        parentStream: new Map(),
        streams,
        zeroBasedIndex: 0,
      }),
    ).toBe('child-c');
    expect(
      numericFocusTargetForActiveStream({
        activeStreamId: 'root',
        parentStream: new Map(),
        streams,
        zeroBasedIndex: 1,
      }),
    ).toBe('child-b');
    expect(
      numericFocusTargetForActiveStream({
        activeStreamId: 'root',
        parentStream: new Map(),
        streams,
        zeroBasedIndex: 2,
      }),
    ).toBeUndefined();
  });

  it('maps Alt-number focus jumps through the focused child stream tree', () => {
    const root = slice({
      activeSubagents: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'critic',
          childStreamId: 'child-a',
        },
      ],
      childStreams: [
        {
          kind: 'subagent',
          executionId: 'agent-2',
          agentName: 'reviewer',
          childStreamId: 'child-b',
        },
      ],
    });
    const streams = new Map<StreamSlice['streamId'], StreamSlice>([
      ['root', root],
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
        parentStream,
        streams,
        zeroBasedIndex: 0,
      }),
    ).toBe('child-b');
    expect(
      numericFocusTargetForActiveStream({
        activeStreamId: 'child-a',
        parentStream,
        streams,
        zeroBasedIndex: 1,
      }),
    ).toBe('child-a');
  });

  it('builds subagent and process picker items with stable labels and tails', () => {
    const state = slice({
      activeSubagents: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'critic',
          childStreamId: 'child-a',
          status: 'running',
          elapsed: '12s',
        },
      ],
      childStreams: [
        {
          kind: 'subagent',
          executionId: 'agent-2',
          agentName: 'reviewer',
          childStreamId: 'child-b',
          status: 'stopped',
          elapsed: '20s',
        },
      ],
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

    expect(buildChildControlItems(state, 'subagents')).toMatchObject([
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
        tailLines: [],
      },
    ]);
    expect(buildChildControlItems(state, 'tasks')).toMatchObject([
      {
        executionId: 'agent-2',
        childStreamId: 'child-b',
        kind: 'subagent',
        label: 'reviewer',
        command: 'reviewer',
        description: 'stopped · 20s',
        killable: false,
      },
      {
        executionId: 'agent-1',
        childStreamId: 'child-a',
        kind: 'subagent',
        label: 'critic',
        command: 'critic',
        killable: true,
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

  it('derives live elapsed text for running child executions', () => {
    const state = slice({
      activeSubagents: [
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

    expect(
      buildChildControlItems(state, 'subagents', new Map(), 62_000),
    ).toMatchObject([
      {
        executionId: 'agent-1',
        description: 'running · 1m 1s',
        elapsed: '1m 1s',
      },
    ]);
    expect(childElapsed(state.activeProcesses[0], 62_000)).toBe('1s');
    expect(
      childElapsed(
        { startedAt: 0, status: STREAM_STATUS.RUNNING, elapsed: '1s' },
        7_501_234,
      ),
    ).toBe('2h 5m');
  });

  it('uses CLI-facing labels in picker descriptions', () => {
    const state = slice({
      activeSubagents: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'review',
          childStreamId: 'child-a',
          status: STREAM_STATUS.WAITING,
          elapsed: '20s',
        },
      ],
      activeProcesses: [
        {
          kind: 'process',
          executionId: 'proc-1',
          agentName: 'bash',
          status: STREAM_STATUS.WAITING,
          elapsed: '3s',
        },
      ],
      processOutput: new Map([['proc-1', tail('last line')]]),
    });

    expect(buildChildControlItems(state, 'subagents')).toMatchObject([
      {
        executionId: 'agent-1',
        description: 'waiting for you · 20s',
        statusLabel: 'waiting for you',
      },
    ]);
    expect(buildChildControlItems(state, 'tasks')).toMatchObject([
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
    expect(liveChildExecutionElapsedKey(undefined)).toBeUndefined();

    const state = slice({
      activeSubagents: [
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
          status: 'initializing',
          startedAt: 1_000,
        },
      ],
      activeProcesses: [
        {
          kind: 'process',
          executionId: 'proc-1',
          agentName: 'latexmk',
          status: 'waiting',
          startedAt: 500,
          elapsed: '1s',
        },
      ],
    });

    expect(liveChildExecutionElapsedKey(state)).toBe(
      'agent-1:1000,agent-2:2000',
    );
    expect(
      liveChildExecutionElapsedKey(
        slice({
          activeSubagents: [
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
      ),
    ).toBeUndefined();
  });

  it('uses stream descriptions as visible task commands', () => {
    const state = slice({
      activeSubagents: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'bash',
          childStreamId: 'child-a',
          status: 'running',
        },
      ],
    });
    const streams = new Map([
      [
        'child-a',
        slice({
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
    ]);

    expect(buildChildControlItems(state, 'tasks', streams)).toMatchObject([
      {
        executionId: 'agent-1',
        label: 'bash',
        command: 'timeout 1800 texra run paper',
        tailLines: ['line one', 'line two'],
      },
    ]);
  });

  it('includes tool and process transcript rows in task details', () => {
    const state = slice({
      activeSubagents: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'bash',
          childStreamId: 'child-a',
          status: 'completed',
        },
      ],
    });
    const streams = new Map([
      [
        'child-a',
        slice({
          entries: [
            {
              id: 'tool-1',
              role: 'tool',
              text: '',
              finalized: true,
              toolUse: toolUse(
                'bash',
                { command: 'pnpm test' },
                {
                  headerSummary: 'pnpm test',
                  outputText: 'ok\nsecond line',
                },
              ),
            },
            {
              id: 'process-1',
              role: 'process',
              text: '',
              finalized: true,
              process: {
                executionId: 'proc-1',
                title: 'latexmk',
                status: 'completed',
                isError: false,
                tailLines: ['built pdf'],
              },
            },
          ],
        }),
      ],
    ]);

    expect(buildChildControlItems(state, 'tasks', streams)).toMatchObject([
      {
        executionId: 'agent-1',
        tailLines: [
          '● bash (pnpm test)',
          '⎿ ok',
          '  second line',
          'latexmk · completed',
          '⎿ built pdf',
        ],
      },
    ]);
  });

  it('keeps retained subagent streams selectable after they leave the active list', () => {
    const state = slice({
      activeSubagents: [
        {
          kind: 'subagent',
          executionId: 'agent-2',
          agentName: 'polisher',
          childStreamId: 'child-b',
          status: 'running',
        },
      ],
      childStreams: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'critic',
          childStreamId: 'child-a',
          status: 'completed',
        },
        {
          kind: 'subagent',
          executionId: 'agent-2',
          agentName: 'polisher',
          childStreamId: 'child-b',
          status: 'waiting',
        },
      ],
    });

    expect(buildChildControlItems(state, 'subagents')).toMatchObject([
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
    const state = slice({
      activeSubagents: [
        {
          kind: 'subagent',
          executionId: 'agent-2',
          agentName: 'polisher',
          childStreamId: 'child-b',
          status: 'running',
        },
      ],
      childStreams: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'critic',
          childStreamId: 'child-a',
          status: 'completed',
        },
        {
          kind: 'subagent',
          executionId: 'agent-2',
          agentName: 'polisher',
          childStreamId: 'child-b',
          status: 'waiting',
        },
      ],
    });

    expect(visibleSubagentRows(state)).toMatchObject([
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
    expect(hasChildControlItems(state, 'tasks')).toBe(true);
  });

  it('keeps stopped subagents in their retained task order', () => {
    const state = slice({
      activeSubagents: [
        {
          kind: 'subagent',
          executionId: 'agent-2',
          agentName: 'polisher',
          childStreamId: 'child-b',
          status: 'running',
        },
      ],
      childStreams: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'critic',
          childStreamId: 'child-a',
          status: 'stopped',
        },
        {
          kind: 'subagent',
          executionId: 'agent-2',
          agentName: 'polisher',
          childStreamId: 'child-b',
          status: 'waiting',
        },
      ],
    });

    expect(buildChildControlItems(state, 'tasks')).toMatchObject([
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
    const state = slice({
      childStreams: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'critic',
          childStreamId: 'child-a',
          status: 'completed',
        },
      ],
    });

    expect(hasChildControlItems(state, 'tasks')).toBe(true);
  });

  it('falls back to the parent subagent list when the focused child is a leaf', () => {
    const parent = slice({
      streamId: 'main',
      activeSubagents: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'review',
          childStreamId: 'review-stream',
          status: 'running',
        },
      ],
    });
    const child = slice({ streamId: 'review-stream' });
    const target = resolveChildControlStreamTarget({
      activeStreamId: 'review-stream',
      mode: 'subagents',
      parentStream: new Map([['review-stream', 'main']]),
      streams: new Map([
        ['main', parent],
        ['review-stream', child],
      ]),
    });

    expect(target.streamId).toBe('main');
    expect(target.fallbackFromStreamId).toBe('review-stream');
    expect(target.hasItems).toBe(true);
    expect(buildChildControlItems(target.slice!, 'subagents')).toMatchObject([
      {
        executionId: 'agent-1',
        childStreamId: 'review-stream',
        kind: 'subagent',
        label: 'review',
      },
    ]);
  });

  it('labels child-control stream scopes with friendly stream names', () => {
    const parent = slice({
      streamId: 'main',
      activeSubagents: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'review',
          childStreamId: 'review-stream',
          status: 'running',
        },
      ],
    });
    const child = slice({ streamId: 'review-stream' });
    const parentStream = new Map([['review-stream', 'main']] as const);
    const streams = new Map([
      ['main', parent],
      ['review-stream', child],
    ] as const);

    expect(
      streamDisplayLabel({
        parentStream,
        streamId: 'main',
        streams,
      }),
    ).toBe('main');
    expect(
      streamDisplayLabel({
        parentStream,
        streamId: 'review-stream',
        streams,
      }),
    ).toBe('review');
  });

  it('resolves child-control display targets with labels and availability', () => {
    const parent = slice({
      streamId: 'main',
      activeSubagents: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'review',
          childStreamId: 'review-stream',
          status: 'running',
        },
      ],
    });
    const child = slice({ streamId: 'review-stream' });
    const parentStream = new Map([['review-stream', 'main']] as const);
    const targets = resolveChildControlDisplayTargets({
      activeStreamId: 'review-stream',
      parentStream,
      streams: new Map([
        ['main', parent],
        ['review-stream', child],
      ] as const),
    });

    expect(targets.subagents).toMatchObject({
      streamId: 'main',
      fallbackFromStreamId: 'review-stream',
      hasItems: true,
      streamLabel: 'main',
      streamScopeDetail: 'review has no subagents',
    });
    expect(targets.tasks).toMatchObject({
      streamId: 'main',
      fallbackFromStreamId: 'review-stream',
      hasItems: true,
      streamLabel: 'main',
      streamScopeDetail: 'review has no tasks or sub-workflows',
    });
  });

  it('keeps subagent controls on the focused child when it has descendants', () => {
    const child = slice({
      streamId: 'review-stream',
      activeSubagents: [
        {
          kind: 'subagent',
          executionId: 'agent-2',
          agentName: 'detail-review',
          childStreamId: 'detail-stream',
          status: 'running',
        },
      ],
    });
    const target = resolveChildControlStreamTarget({
      activeStreamId: 'review-stream',
      mode: 'subagents',
      parentStream: new Map([['review-stream', 'main']]),
      streams: new Map([['review-stream', child]]),
    });

    expect(target.streamId).toBe('review-stream');
    expect(target.hasItems).toBe(true);
    expect(buildChildControlItems(target.slice!, 'subagents')).toMatchObject([
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
    const target = resolveChildControlStreamTarget({
      activeStreamId: 'review-stream',
      mode: 'subagents',
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
    const main = slice({
      streamId: 'main',
      activeSubagents: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'review',
          childStreamId: 'review-stream',
          status: 'running',
        },
      ],
    });
    const child = slice({ streamId: 'review-stream' });
    const grandchild = slice({ streamId: 'detail-stream' });
    const target = resolveChildControlStreamTarget({
      activeStreamId: 'detail-stream',
      mode: 'subagents',
      parentStream: new Map([
        ['review-stream', 'main'],
        ['detail-stream', 'review-stream'],
      ]),
      streams: new Map([
        ['main', main],
        ['review-stream', child],
        ['detail-stream', grandchild],
      ]),
    });

    expect(target.streamId).toBe('main');
    expect(target.fallbackFromStreamId).toBe('detail-stream');
    expect(target.hasItems).toBe(true);
    expect(buildChildControlItems(target.slice!, 'subagents')).toMatchObject([
      {
        executionId: 'agent-1',
        childStreamId: 'review-stream',
        kind: 'subagent',
        label: 'review',
      },
    ]);
  });

  it('falls back to the parent task list when the focused child is a leaf', () => {
    const child = slice({ streamId: 'review-stream' });
    const target = resolveChildControlStreamTarget({
      activeStreamId: 'review-stream',
      mode: 'tasks',
      parentStream: new Map([['review-stream', 'main']]),
      streams: new Map([
        [
          'main',
          slice({
            streamId: 'main',
            activeSubagents: [
              {
                kind: 'subagent',
                executionId: 'agent-1',
                agentName: 'review',
                childStreamId: 'review-stream',
                status: 'running',
              },
            ],
          }),
        ],
        ['review-stream', child],
      ]),
    });

    expect(target.streamId).toBe('main');
    expect(target.fallbackFromStreamId).toBe('review-stream');
    expect(target.hasItems).toBe(true);
    expect(buildChildControlItems(target.slice!, 'tasks')).toMatchObject([
      {
        executionId: 'agent-1',
        childStreamId: 'review-stream',
        kind: 'subagent',
        label: 'review',
      },
    ]);
  });

  it('falls back to retained parent task rows when only stopped child streams remain', () => {
    const child = slice({ streamId: 'review-stream' });
    const target = resolveChildControlStreamTarget({
      activeStreamId: 'review-stream',
      mode: 'tasks',
      parentStream: new Map([['review-stream', 'main']]),
      streams: new Map([
        [
          'main',
          slice({
            streamId: 'main',
            childStreams: [
              {
                kind: 'subagent',
                executionId: 'agent-1',
                agentName: 'review',
                childStreamId: 'review-stream',
                status: 'stopped',
              },
            ],
          }),
        ],
        ['review-stream', child],
      ]),
    });

    expect(target.streamId).toBe('main');
    expect(target.fallbackFromStreamId).toBe('review-stream');
    expect(target.hasItems).toBe(true);
    expect(buildChildControlItems(target.slice!, 'tasks')).toMatchObject([
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
    const target = resolveChildControlStreamTarget({
      activeStreamId: 'review-stream',
      mode: 'tasks',
      parentStream: new Map([['review-stream', 'main']]),
      streams: new Map([
        [
          'main',
          slice({
            streamId: 'main',
            activeSubagents: [
              {
                kind: 'subagent',
                executionId: 'agent-1',
                agentName: 'review',
                childStreamId: 'review-stream',
                status: 'running',
              },
            ],
          }),
        ],
        ['review-stream', child],
      ]),
    });

    expect(target.streamId).toBe('review-stream');
    expect(target.slice).toBe(child);
    expect(target.hasItems).toBe(true);
    expect(buildChildControlItems(target.slice!, 'tasks')).toMatchObject([
      {
        executionId: 'proc-1',
        kind: 'process',
        label: 'latexmk',
      },
    ]);
  });

  it('keeps picker key handling independent of Ink rendering', () => {
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
    expect(childPickerKeyAction({ input: '3' })).toEqual({
      kind: 'jump',
      index: 2,
    });
    expect(nextPickerIndex(0, 3, 'up')).toBe(2);
    expect(nextPickerIndex(2, 3, 'down')).toBe(0);
  });

  it('advertises only applicable keys for child pickers', () => {
    expect(pickerKeyHints('tasks', 0)).toEqual([
      { key: 'Esc', action: 'close' },
    ]);
    expect(pickerKeyHints('tasks', 1)).toEqual([
      { key: '↑/↓', action: 'navigate' },
      { key: 'Enter', action: 'view' },
      { key: 'k', action: 'kill' },
      { key: 'Esc', action: 'close' },
    ]);
    expect(childPickerKeyAction({ input: '3' })).toEqual({
      kind: 'jump',
      index: 2,
    });
    expect(pickerKeyHints('tasks', 3)).toContainEqual({
      key: '1-9',
      action: 'jump',
    });
    expect(pickerKeyHints('subagents', 1)).toContainEqual({
      key: 'Enter',
      action: 'view',
    });
    expect(pickerKeyHints('subagents', 1)).toContainEqual({
      key: 'f',
      action: 'focus',
    });
    expect(pickerKeyHints('subagents', 1, false)).not.toContainEqual({
      key: 'k',
      action: 'kill',
    });
  });

  it('keeps Esc close readable in narrow child picker hints', () => {
    expect(pickerKeyHintsForColumns('subagents', 3, true, 60)).toEqual([
      { key: '↑/↓', action: 'nav' },
      { key: '1-9', action: 'jump' },
      { key: 'Enter', action: 'view' },
      { key: 'f', action: 'focus' },
      { key: 'Esc', action: 'close' },
    ]);
    expect(pickerKeyHintsForColumns('tasks', 3, true, 50)).toEqual([
      { key: '↑/↓', action: 'nav' },
      { key: 'Enter', action: 'view' },
      { key: 'k', action: 'kill' },
      { key: 'Esc', action: 'close' },
    ]);
    expect(pickerKeyHintsForColumns('tasks', 3, true, 40)).toEqual([
      { key: '↑/↓', action: 'nav' },
      { key: 'Enter', action: 'view' },
      { key: 'Esc', action: 'close' },
    ]);
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
    expect(
      taskDetailVisibleLineCountFromOffsetForColumns({
        availableColumns: 80,
        compact: true,
        tailLines: ['x'.repeat(180), 'short 1', 'short 2', 'short 3'],
        visibleRowBudget: 3,
        offset: 0,
      }),
    ).toBe(1);
    expect(
      taskDetailVisibleLineCountFromOffsetForColumns({
        availableColumns: 80,
        compact: true,
        tailLines: ['x'.repeat(180), 'short 1', 'short 2', 'short 3'],
        visibleRowBudget: 3,
        offset: 1,
      }),
    ).toBe(3);
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

  it('labels the task picker as a combined task and sub-workflow view', () => {
    expect(pickerTitle('subagents')).toBe('Subagents');
    expect(pickerTitle('tasks')).toBe('Tasks and sub-workflows');
    expect(emptyPickerText('subagents')).toBe('No active subagents.');
    expect(emptyPickerText('tasks')).toBe('No active tasks or sub-workflows.');
  });

  it('switches child pickers to ultra-compact rendering before bordered content clips', () => {
    expect(isUltraCompactPickerRows(3)).toBe(true);
    expect(isUltraCompactPickerRows(4)).toBe(true);
    expect(isUltraCompactPickerRows(5)).toBe(true);
    expect(isUltraCompactPickerRows(6)).toBe(true);
    expect(isUltraCompactPickerRows(7)).toBe(false);
    expect(isUltraCompactPickerRows(undefined)).toBe(false);
    expect(isUltraCompactTaskDetailRows(4)).toBe(true);
    expect(isUltraCompactTaskDetailRows(5)).toBe(false);
    expect(
      compactPickerOverflowText({
        itemCount: 3,
        selectedIndex: 0,
      }),
    ).toBe('+2 more');
    expect(
      compactPickerOverflowText({
        itemCount: 3,
        selectedIndex: 2,
      }),
    ).toBe('+2 earlier');
    expect(
      compactPickerOverflowText({
        itemCount: 5,
        selectedIndex: 2,
      }),
    ).toBe('+2 earlier, +2 more');
    expect(
      compactPickerOverflowText({
        itemCount: 1,
        selectedIndex: 0,
      }),
    ).toBeUndefined();
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

  it('keeps the highlighted picker item inside the visible window', () => {
    expect(
      computePickerListLayout({
        availableRows: 12,
        highlight: 8,
        itemCount: 12,
        scopeLineCount: 1,
      }),
    ).toMatchObject({
      hiddenAfter: 2,
      hiddenBefore: 7,
      start: 7,
      visibleCount: 3,
    });
  });

  it('reserves extra list rows while allowing dense picker spacing', () => {
    expect(
      computePickerListLayout({
        availableRows: 10,
        extraListRowCount: 1,
        hintsMarginRows: 0,
        highlight: 0,
        itemCount: 3,
        listMarginRows: 0,
        scopeLineCount: 1,
      }),
    ).toMatchObject({
      hiddenAfter: 0,
      hiddenBefore: 0,
      start: 0,
      visibleCount: 3,
    });
  });

  it('keeps empty picker windows empty', () => {
    expect(
      computePickerListLayout({
        availableRows: 10,
        highlight: 0,
        itemCount: 0,
        scopeLineCount: 1,
      }),
    ).toMatchObject({
      hiddenAfter: 0,
      hiddenBefore: 0,
      start: 0,
      visibleCount: 0,
    });
  });
});
