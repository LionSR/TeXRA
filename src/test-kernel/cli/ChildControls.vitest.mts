// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - CLI TUI state
import {
  computePickerListLayout,
  computeTaskDetailLayout,
  emptyPickerText,
  pickerKeyHints,
  pickerTitle,
} from '@cli/chat/tui/modals/ChildControlPicker';
import {
  buildChildControlItems,
  childElapsed,
  childPickerKeyAction,
  hasChildExecutionRows,
  liveChildExecutionElapsedKey,
  nextPickerIndex,
  numericFocusTarget,
  resolveChildControlStreamTarget,
} from '@cli/chat/tui/state/childControls';
import { visibleSubagentRows } from '@cli/chat/tui/state/childStreamMerge';
import { NO_BYPASS } from '@cli/chat/tui/state/cliState';
import { streamScopeDisplayLabel } from '@cli/chat/tui/state/streamLabels';
import type {
  ProcessOutputTail,
  StreamSlice,
} from '@cli/chat/tui/state/cliState';

function tail(stdout: string, stderr = ''): ProcessOutputTail {
  return { stdout, stderr };
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
  it('maps Alt-number focus jumps to listed descendant streams', () => {
    const state = slice({
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

    expect(numericFocusTarget(state, 0)).toBe('child-a');
    expect(numericFocusTarget(state, 1)).toBe('child-c');
    expect(numericFocusTarget(state, 2)).toBe('child-b');
    expect(numericFocusTarget(state, 3)).toBeUndefined();
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
      },
      {
        executionId: 'proc-1',
        kind: 'process',
        label: 'latexmk',
        command: 'latexmk',
        description: 'running · 3s · warning',
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
      },
      {
        executionId: 'agent-1',
        childStreamId: 'child-a',
        kind: 'subagent',
        label: 'critic',
        description: 'completed',
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
  });

  it('labels the task picker as a combined task and sub-workflow view', () => {
    expect(pickerTitle('subagents')).toBe('Subagents');
    expect(pickerTitle('tasks')).toBe('Tasks and sub-workflows');
    expect(emptyPickerText('subagents')).toBe('No active subagents.');
    expect(emptyPickerText('tasks')).toBe('No active tasks or sub-workflows.');
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
