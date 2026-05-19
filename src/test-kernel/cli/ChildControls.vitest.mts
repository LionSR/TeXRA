// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - CLI TUI state
import {
  computePickerListLayout,
  computeTaskDetailLayout,
} from '../../../packages/cli/src/chat/tui/modals/ChildControlPicker';
import {
  buildChildControlItems,
  childPickerKeyAction,
  nextPickerIndex,
  numericFocusTarget,
} from '../../../packages/cli/src/chat/tui/state/childControls';
import { NO_BYPASS } from '../../../packages/cli/src/chat/tui/state/cliState';
import type {
  ProcessOutputTail,
  StreamSlice,
} from '../../../packages/cli/src/chat/tui/state/cliState';

function tail(stdout: string, stderr = ''): ProcessOutputTail {
  return { stdout, stderr };
}

function slice(
  overrides: Partial<StreamSlice> = {},
): Pick<StreamSlice, 'activeProcesses' | 'activeSubagents' | 'processOutput'> &
  StreamSlice {
  return {
    streamId: 'root',
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
    });

    expect(numericFocusTarget(state, 0)).toBe('child-a');
    expect(numericFocusTarget(state, 1)).toBe('child-b');
    expect(numericFocusTarget(state, 2)).toBeUndefined();
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
        hasParentStream: true,
        highlight: 8,
        itemCount: 12,
      }),
    ).toMatchObject({
      hiddenAfter: 2,
      hiddenBefore: 7,
      start: 7,
      visibleCount: 3,
    });
  });
});
