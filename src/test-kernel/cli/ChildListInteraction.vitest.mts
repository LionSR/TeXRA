import stripAnsi from 'strip-ansi';
import { describe, expect, it, vi } from 'vitest';

import { SubagentList } from '@cli/chat/tui/panes/SubagentList';
import {
  childStreamListValue,
  type ChildListValue,
} from '@cli/chat/tui/state/childListSelection';
import { NO_BYPASS } from '@cli/chat/tui/state/cliState';
import type { StreamView } from '@cli/chat/tui/state/streamViews';
import { POINTER } from '@cli/chat/tui/ui/glyphs';
import type { StreamTabId } from '@shared/schemas';
import {
  FakeStdin,
  FakeStdout,
  loadInk,
} from '@test/support/inkTestHarness.mts';
import { waitForCondition as waitFor } from '@test/support/asyncTestUtils';

function session(id: StreamTabId, active = false): StreamView {
  return { id, label: id, slice: undefined, active };
}

describe('CLI child list interaction', () => {
  it('renders no row highlight before the list receives a selection', async () => {
    const { ink, React } = await loadInk();
    const output = ink.renderToString(
      React.createElement(SubagentList, {
        sessions: [session('latexmk' as StreamTabId)],
        keyboardActive: false,
        maxRows: 3,
      }),
      { columns: 100 },
    );

    expect(output).toContain('latexmk');
    expect(output).not.toContain(POINTER);
  });

  it('prints and kills only the selected active session, then focuses it', async () => {
    const { ink, React } = await loadInk();
    const root = 'root' as StreamTabId;
    const child = 'child' as StreamTabId;
    const onFocusStream = vi.fn();
    const onKillExecution = vi.fn();
    const onPrintStream = vi.fn();
    const onCancel = vi.fn();
    let selected = childStreamListValue(root);

    function Harness() {
      const [value, setValue] = React.useState(selected) as [
        ChildListValue,
        (next: ChildListValue) => void,
      ];
      return React.createElement(SubagentList, {
        activeSubagentExecutionIds: new Map([[child, 'child-exec']]),
        keyboardActive: true,
        maxRows: 5,
        onCancel,
        onFocusStream,
        onKillExecution,
        onSelectionChange: (next: ChildListValue) => {
          selected = next;
          setValue(next);
        },
        onPrintStream,
        selectedValue: value,
        sessions: [session(root, true), session(child)],
      });
    }

    const stdin = new FakeStdin();
    const instance = ink.render(React.createElement(Harness), {
      stdin,
      stdout: new FakeStdout(100),
      interactive: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write('\u001B[B');
      await waitFor(() => selected === childStreamListValue(child));
      stdin.write('v');
      await waitFor(() => onPrintStream.mock.calls.length === 1);
      stdin.write('k');
      await waitFor(() => onKillExecution.mock.calls.length === 1);
      stdin.write('\r');
      await waitFor(() => onFocusStream.mock.calls.length === 1);
      stdin.write('\u001B');
      await waitFor(() => onCancel.mock.calls.length === 1);

      expect(onPrintStream).toHaveBeenCalledWith(child);
      expect(onKillExecution).toHaveBeenCalledWith('child-exec');
      expect(onFocusStream).toHaveBeenCalledWith(child);
      expect(onCancel).toHaveBeenCalledOnce();
    } finally {
      instance.unmount();
    }
  });

  it('skips and retries the focused subagent grandchild by execution id', async () => {
    const { ink, React } = await loadInk();
    const root = 'root' as StreamTabId;
    const child = 'child' as StreamTabId;
    const onSkipExecution = vi.fn();
    const onRetryExecution = vi.fn();

    const stdin = new FakeStdin();
    const instance = ink.render(
      React.createElement(SubagentList, {
        activeSubagentExecutionIds: new Map([[child, 'child-exec']]),
        keyboardActive: true,
        maxRows: 5,
        onCancel: vi.fn(),
        onSkipExecution,
        onRetryExecution,
        onSelectionChange: vi.fn(),
        selectedValue: childStreamListValue(child),
        sessions: [session(root, true), session(child)],
      }),
      {
        stdin,
        stdout: new FakeStdout(100),
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write('s');
      await waitFor(() => onSkipExecution.mock.calls.length === 1);
      stdin.write('r');
      await waitFor(() => onRetryExecution.mock.calls.length === 1);

      expect(onSkipExecution).toHaveBeenCalledWith('child-exec');
      expect(onRetryExecution).toHaveBeenCalledWith('child-exec');
    } finally {
      instance.unmount();
    }
  });

  it('hands focus back to the input instead of wrapping past the last row', async () => {
    const { ink, React } = await loadInk();
    const root = 'root' as StreamTabId;
    const child = 'child' as StreamTabId;
    const onCancel = vi.fn();
    const onSelectionChange = vi.fn();

    const stdin = new FakeStdin();
    const instance = ink.render(
      React.createElement(SubagentList, {
        keyboardActive: true,
        maxRows: 5,
        onCancel,
        onSelectionChange,
        selectedValue: childStreamListValue(child),
        sessions: [session(root, true), session(child)],
      }),
      {
        stdin,
        stdout: new FakeStdout(100),
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write('[B');
      await waitFor(() => onCancel.mock.calls.length === 1);

      expect(onSelectionChange).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('clamps instead of wrapping when ↑ is pressed at the first row', async () => {
    const { ink, React } = await loadInk();
    const root = 'root' as StreamTabId;
    const child = 'child' as StreamTabId;
    const onCancel = vi.fn();
    const onSelectionChange = vi.fn();

    const stdin = new FakeStdin();
    const instance = ink.render(
      React.createElement(SubagentList, {
        keyboardActive: true,
        maxRows: 5,
        onCancel,
        onSelectionChange,
        selectedValue: childStreamListValue(root),
        sessions: [session(root, true), session(child)],
      }),
      {
        stdin,
        stdout: new FakeStdout(100),
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write('[A');
      // No state change to await for a no-op; give the event loop a turn.
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(onCancel).not.toHaveBeenCalled();
      expect(onSelectionChange).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });
});

const workflowRun = 'workflow-run' as StreamTabId;
const mapChild = 'map-child' as StreamTabId;
const reduceChild = 'reduce-child' as StreamTabId;

/** The focused run's own row: it owns the phase dividers and the task cards
 *  the group headers fold, and it is the list root so it shows no summary. */
function workflowRunSession(): StreamView {
  return {
    id: workflowRun,
    label: 'workflow-script',
    active: true,
    slice: {
      streamId: workflowRun,
      category: undefined,
      status: undefined,
      runStartedAt: undefined,
      description: undefined,
      thinkingActive: false,
      compactingActive: false,
      usage: undefined,
      cumulativeUsage: undefined,
      conversation: undefined,
      entries: [
        {
          id: 'phase-map',
          text: 'Map',
          finalized: true,
          role: 'phase',
          phaseLabel: 'Map',
          phaseIndex: 0,
          phaseTotal: 2,
        },
        {
          id: 'task-extract',
          text: 'Finished: Extract claims',
          finalized: true,
          role: 'workflowTask',
          task: {
            id: 'extract',
            label: 'Extract claims',
            phase: 'Map',
            status: 'completed',
          },
        },
        {
          id: 'task-rank',
          text: 'Running: Rank questions',
          finalized: false,
          role: 'workflowTask',
          task: {
            id: 'rank',
            label: 'Rank questions',
            phase: 'Map',
            status: 'running',
          },
        },
      ],
      queuedFollowUpMessages: [],
      todos: [],
      plan: null,
      bypass: NO_BYPASS,
    },
  };
}

function phasedChild(id: StreamTabId, workflowPhase: string): StreamView {
  return { id, label: id, slice: undefined, active: false, workflowPhase };
}

/** `useWindowSize` reads the Ink stdout context rather than `renderToString`'s
 *  layout width, so the metadata width gate can only be exercised through a
 *  real render against a stdout of that width. */
async function renderWorkflowListLines(
  ink: Awaited<ReturnType<typeof loadInk>>['ink'],
  React: Awaited<ReturnType<typeof loadInk>>['React'],
  columns: number,
): Promise<readonly string[]> {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout(columns);
  const instance = ink.render(
    React.createElement(SubagentList, {
      keyboardActive: false,
      maxRows: 8,
      listRootStreamId: workflowRun,
      selectedValue: childStreamListValue(workflowRun),
      sessions: [
        workflowRunSession(),
        phasedChild(mapChild, 'Map'),
        phasedChild(reduceChild, 'Reduce'),
      ],
    }),
    {
      stdin,
      stdout,
      interactive: true,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  try {
    await waitFor(() => stdout.output.includes('Reduce'));
    return stripAnsi(stdout.output).split('\n');
  } finally {
    instance.unmount();
  }
}

/** Last frame's rendering of the one line matching `text`. */
function lastLineWith(
  lines: readonly string[],
  text: string,
): string | undefined {
  return lines.findLast((line) => line.includes(text))?.trimEnd();
}

describe('CLI child list phase headers', () => {
  it('heads each group and right-aligns its done/total at full width', async () => {
    const { ink, React } = await loadInk();
    const lines = await renderWorkflowListLines(ink, React, 100);

    // `done/total` folds the run's own task cards for that phase, right-aligned
    // into the same column the rows put their metadata in.
    const mapHeader = lastLineWith(lines, 'Map (1/2)');
    expect(mapHeader?.startsWith('     ◆ Map (1/2)')).toBe(true);
    expect(mapHeader?.endsWith('1/2')).toBe(true);
    expect(mapHeader).not.toContain('· 1/2');
    // A phase with no task cards gets a header but no progress figure.
    expect(lastLineWith(lines, '◆ Reduce')).toBe('     ◆ Reduce');
  });

  it('falls back to an inline done/total below the metadata width gate', async () => {
    const { ink, React } = await loadInk();
    const lines = await renderWorkflowListLines(ink, React, 56);

    expect(lastLineWith(lines, 'Map (1/2)')).toBe('     ◆ Map (1/2) · 1/2');
  });

  it('never highlights or selects a phase header while navigating', async () => {
    const { ink, React } = await loadInk();
    const onFocusStream = vi.fn();
    const onSelectionChange = vi.fn();
    let selected: ChildListValue = childStreamListValue(workflowRun);

    function Harness() {
      const [value, setValue] = React.useState(selected) as [
        ChildListValue,
        (next: ChildListValue) => void,
      ];
      return React.createElement(SubagentList, {
        keyboardActive: true,
        maxRows: 8,
        listRootStreamId: workflowRun,
        onCancel: vi.fn(),
        onFocusStream,
        onSelectionChange: (next: ChildListValue) => {
          selected = next;
          onSelectionChange(next);
          setValue(next);
        },
        selectedValue: value,
        sessions: [
          workflowRunSession(),
          phasedChild(mapChild, 'Map'),
          phasedChild(reduceChild, 'Reduce'),
        ],
      });
    }

    const stdin = new FakeStdin();
    const instance = ink.render(React.createElement(Harness), {
      stdin,
      stdout: new FakeStdout(100),
      interactive: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      // Row order is run, ◆ Map, map-child, ◆ Reduce, reduce-child: two Downs
      // step over both dividers onto the two agent rows.
      stdin.write('[B');
      await waitFor(() => selected === childStreamListValue(mapChild));
      stdin.write('[B');
      await waitFor(() => selected === childStreamListValue(reduceChild));
      stdin.write('\r');
      await waitFor(() => onFocusStream.mock.calls.length === 1);

      expect(onFocusStream).toHaveBeenCalledWith(reduceChild);
      for (const [value] of onSelectionChange.mock.calls) {
        expect(value).toMatch(/^stream:/);
      }
    } finally {
      instance.unmount();
    }
  });
});
