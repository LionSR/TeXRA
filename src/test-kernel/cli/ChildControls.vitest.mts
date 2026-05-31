// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - CLI TUI state
import {
  computePickerListLayout,
  computeTaskDetailLayout,
  emptyPickerText,
  isUltraCompactPickerRows,
  moveTaskDetailScrollState,
  pickerKeyHints,
  pickerKeyHintsForColumns,
  pickerTitle,
  syncTaskDetailScrollState,
  TASK_DETAIL_LABEL_WIDTH,
  taskDetailCommandLabel,
  taskDetailInitialScrollOffset,
  taskDetailVisibleScrollOffset,
} from '@cli/chat/tui/modals/ChildControlPicker';
import {
  buildChildControlItems,
  childElapsed,
  childPickerKeyAction,
  hasChildExecutionRows,
  liveChildExecutionElapsedKey,
  nextPickerIndex,
  numericFocusTargetForActiveStream,
  resolveChildControlStreamTarget,
} from '@cli/chat/tui/state/childControls';
import { visibleSubagentRows } from '@cli/chat/tui/state/childStreamMerge';
import { NO_BYPASS } from '@cli/chat/tui/state/cliState';
import { streamScopeDisplayLabel } from '@cli/chat/tui/state/streamLabels';
import type {
  ProcessOutputTail,
  StreamSlice,
} from '@cli/chat/tui/state/cliState';

// Local imports - shared schemas
import { TOOL_USE_STATUS, type NormalizedToolUse } from '@shared/schemas';

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
    ...overrides,
  };
}

describe('CLI child execution controls', () => {
  it('maps Alt-number focus jumps to visible descendant streams', () => {
    const root = slice({
      activeSubagents: [
        {
          executionId: 'agent-1',
          agentName: 'critic',
          childStreamId: 'child-a',
        },
      ],
      activeProcesses: [
        {
          executionId: 'proc-1',
          agentName: 'bash',
          childStreamId: 'child-b',
        },
      ],
      childStreams: [
        {
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
          executionId: 'agent-1',
          agentName: 'critic',
          childStreamId: 'child-a',
        },
      ],
      childStreams: [
        {
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
        zeroBasedIndex: 1,
      }),
    ).toBe('child-b');
  });

  it('builds subagent and process picker items with stable labels and tails', () => {
    const state = slice({
      activeSubagents: [
        {
          executionId: 'agent-1',
          agentName: 'critic',
          childStreamId: 'child-a',
          status: 'running',
          elapsed: '12s',
        },
      ],
      activeProcesses: [
        {
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
        description: 'running · 1min, 1sec',
        elapsed: '1min, 1sec',
      },
    ]);
    expect(childElapsed(state.activeProcesses[0], 62_000)).toBe('1s');
  });

  it('keys live child elapsed timers by active execution identity', () => {
    expect(liveChildExecutionElapsedKey(undefined)).toBeUndefined();

    const state = slice({
      activeSubagents: [
        {
          executionId: 'agent-2',
          agentName: 'critic',
          status: 'running',
          startedAt: 2_000,
        },
        {
          executionId: 'agent-1',
          agentName: 'reviewer',
          status: 'initializing',
          startedAt: 1_000,
        },
      ],
      activeProcesses: [
        {
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
          executionId: 'agent-2',
          agentName: 'polisher',
          childStreamId: 'child-b',
          status: 'running',
        },
      ],
      childStreams: [
        {
          executionId: 'agent-1',
          agentName: 'critic',
          childStreamId: 'child-a',
          status: 'completed',
        },
        {
          executionId: 'agent-2',
          agentName: 'polisher',
          childStreamId: 'child-b',
          status: 'waiting',
        },
      ],
    });

    expect(buildChildControlItems(state, 'subagents')).toMatchObject([
      {
        executionId: 'agent-2',
        childStreamId: 'child-b',
        kind: 'subagent',
        label: 'polisher',
        description: 'running',
        killable: true,
      },
      {
        executionId: 'agent-1',
        childStreamId: 'child-a',
        kind: 'subagent',
        label: 'critic',
        description: 'completed',
        killable: false,
      },
    ]);
  });

  it('keeps retained subagent streams visible in the side-panel row model', () => {
    const state = slice({
      activeSubagents: [
        {
          executionId: 'agent-2',
          agentName: 'polisher',
          childStreamId: 'child-b',
          status: 'running',
        },
      ],
      childStreams: [
        {
          executionId: 'agent-1',
          agentName: 'critic',
          childStreamId: 'child-a',
          status: 'completed',
        },
        {
          executionId: 'agent-2',
          agentName: 'polisher',
          childStreamId: 'child-b',
          status: 'waiting',
        },
      ],
    });

    expect(visibleSubagentRows(state)).toMatchObject([
      {
        executionId: 'agent-2',
        childStreamId: 'child-b',
        status: 'running',
      },
      {
        executionId: 'agent-1',
        childStreamId: 'child-a',
        status: 'completed',
      },
    ]);
    expect(hasChildExecutionRows(state)).toBe(true);
  });

  it('opens the child side panel when only retained subagent streams remain', () => {
    const state = slice({
      childStreams: [
        {
          executionId: 'agent-1',
          agentName: 'critic',
          childStreamId: 'child-a',
          status: 'completed',
        },
      ],
    });

    expect(hasChildExecutionRows(state)).toBe(true);
  });

  it('falls back to the parent subagent list when the focused child is a leaf', () => {
    const parent = slice({
      streamId: 'main',
      activeSubagents: [
        {
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
      streamScopeDisplayLabel({
        parentStream,
        streamId: 'main',
        streams,
      }),
    ).toBe('main');
    expect(
      streamScopeDisplayLabel({
        parentStream,
        streamId: 'review-stream',
        streams,
      }),
    ).toBe('review');
  });

  it('keeps subagent controls on the focused child when it has descendants', () => {
    const child = slice({
      streamId: 'review-stream',
      activeSubagents: [
        {
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
    expect(buildChildControlItems(target.slice!, 'tasks')).toMatchObject([
      {
        executionId: 'agent-1',
        childStreamId: 'review-stream',
        kind: 'subagent',
        label: 'review',
      },
    ]);
  });

  it('keeps task controls scoped to the focused child stream when it has work', () => {
    const child = slice({
      streamId: 'review-stream',
      activeProcesses: [
        {
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
      { key: 'Enter', action: 'focus' },
      { key: 'k', action: 'kill' },
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

  it('labels the task picker as a combined task and sub-workflow view', () => {
    expect(pickerTitle('subagents')).toBe('Subagents');
    expect(pickerTitle('tasks')).toBe('Tasks and sub-workflows');
    expect(emptyPickerText('subagents')).toBe('No active subagents.');
    expect(emptyPickerText('tasks')).toBe('No active tasks or sub-workflows.');
  });

  it('switches child pickers to ultra-compact rendering only at very small budgets', () => {
    expect(isUltraCompactPickerRows(3)).toBe(true);
    expect(isUltraCompactPickerRows(4)).toBe(true);
    expect(isUltraCompactPickerRows(5)).toBe(false);
    expect(isUltraCompactPickerRows(undefined)).toBe(false);
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
});
