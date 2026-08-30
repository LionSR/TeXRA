import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it, vi } from 'vitest';

import { SubagentList } from '@cli/chat/tui/panes/SubagentList';
import type { ChildListValue } from '@cli/chat/tui/state/childListSelection';
import { emptySlice, type StreamSlice } from '@cli/chat/tui/state/cliState';
import type { StreamView } from '@cli/chat/tui/state/streamViews';
import { POINTER } from '@cli/tui/ui/glyphs';
import { type StreamTabId, type WorkflowCallProgress } from '@shared/schemas';
import type { PhaseRow, WorkflowTaskRow } from '@shared/transcript';
import {
  loadInk,
  renderInteractive,
  renderOutputAtTerminalSize,
  type FakeStdin,
  type InkRenderHandles,
} from '@test/support/inkTestHarness.ts';
import { waitForCondition as waitFor } from '@test/support/asyncTestUtils';
import { workflowPhaseGrouping } from '@test/support/transcriptRowFixtures';

const root = 'root' as StreamTabId;
const child = 'child' as StreamTabId;

function session(id: StreamTabId, active = false): StreamView {
  return { id, label: id, slice: undefined, active };
}

/** Every mount in this suite renders the child list at 100 columns. */
function renderChildList(ink: any, node: any): InkRenderHandles {
  return renderInteractive(ink, node, { columns: 100 });
}

/** Wait until the mounted list has attached its stdin input listener. */
function waitForInput(stdin: FakeStdin): Promise<void> {
  return waitFor(() => stdin.listenerCount('readable') > 0);
}

/**
 * A controlled SubagentList whose selection lives in React state, mirroring
 * the app's wiring. `current()` reads the latest selection.
 */
function controlledList(
  React: any,
  initial: ChildListValue,
  props: Record<string, unknown>,
): {
  Harness: () => any;
  current: () => ChildListValue;
} {
  let selected = initial;
  function Harness() {
    const [value, setValue] = React.useState(selected) as [
      ChildListValue,
      (next: ChildListValue) => void,
    ];
    return React.createElement(SubagentList, {
      ...props,
      onSelectionChange: (next: ChildListValue) => {
        (
          props.onSelectionChange as ((v: ChildListValue) => void) | undefined
        )?.(next);
        selected = next;
        setValue(next);
      },
      selectedValue: value,
      // `App` resolves the highlighted row to a stream once and hands the
      // result down; a plain session row resolves to its own stream.
      selectedChildStreamId:
        value ?? (props.selectedChildStreamId as StreamTabId | undefined),
    });
  }
  return { Harness, current: () => selected };
}

function workflowRootSlice(rows: StreamSlice['entries']): StreamSlice {
  const { taskGroups, entries } = workflowPhaseGrouping(rows);
  return {
    ...emptySlice(root),
    taskGroups,
    entries,
  };
}

function phaseRow(
  id: string,
  phaseLabel: string,
  phaseIndex: number,
  phaseTotal: number,
): PhaseRow {
  return {
    kind: 'phase',
    id,
    timestamp: 0,
    level: 'info',
    heading: phaseLabel,
    phaseLabel,
    phaseIndex,
    phaseTotal,
  };
}

function taskRow(id: string, call: WorkflowCallProgress): WorkflowTaskRow {
  const statusLabel = call.status === 'running' ? 'Running' : 'Planned';
  return {
    kind: 'workflowTask',
    id,
    timestamp: 0,
    level: 'info',
    call,
    line: `${statusLabel}: ${call.label}`,
    statusLabel,
    metadataParts: [],
  };
}

describe('CLI child list interaction', () => {
  it('renders no row highlight before the list receives a selection', async () => {
    const { ink, React } = await loadInk();
    const output = await renderOutputAtTerminalSize(
      ink,
      React.createElement(SubagentList, {
        sessions: [session('latexmk' as StreamTabId)],
        keyboardActive: false,
        maxRows: 3,
      }),
      100,
      { until: (frame) => frame.includes('latexmk') },
    );

    expect(output).toContain('latexmk');
    expect(output).not.toContain(POINTER);
  });

  it('kills the selected active session, then focuses it', async () => {
    const { ink, React } = await loadInk();
    const onFocusStream = vi.fn();
    const onKillExecution = vi.fn();
    const onCancel = vi.fn();
    const { Harness, current } = controlledList(React, root, {
      activeSubagentExecutionIds: new Map([[child, 'child-exec']]),
      keyboardActive: true,
      maxRows: 5,
      onCancel,
      onFocusStream,
      onKillExecution,
      sessions: [session(root, true), session(child)],
    });

    const { instance, stdin } = renderChildList(
      ink,
      React.createElement(Harness),
    );

    try {
      await waitForInput(stdin);
      stdin.write('\u001B[B');
      await waitFor(() => current() === child);
      stdin.write('k');
      await waitFor(() => onKillExecution.mock.calls.length === 1);
      stdin.write('\r');
      await waitFor(() => onFocusStream.mock.calls.length === 1);
      stdin.write('\u001B');
      await waitFor(() => onCancel.mock.calls.length === 1);

      expect(onKillExecution).toHaveBeenCalledWith('child-exec');
      expect(onFocusStream).toHaveBeenCalledWith(child);
      expect(onCancel).toHaveBeenCalledOnce();
    } finally {
      instance.unmount();
    }
  });

  it('walks to the child row and clamps at the selectable boundaries', async () => {
    const { ink, React } = await loadInk();
    const onCancel = vi.fn();
    const onFocusStream = vi.fn();
    const onSelectionChange = vi.fn();
    const { Harness, current } = controlledList(React, root, {
      keyboardActive: true,
      listRootStreamId: root,
      maxRows: 5,
      onCancel,
      onFocusStream,
      onSelectionChange,
      sessions: [session(root, true), { ...session(child), parentId: root }],
    });

    const { instance, stdin, stdout } = renderChildList(
      ink,
      React.createElement(Harness),
    );

    try {
      await waitFor(
        () =>
          stdin.listenerCount('readable') > 0 && stdout.output.includes(child),
      );
      stdin.write('\u001B[A');
      stdin.write('\u001B[A');
      await sleep(30);
      expect(current()).toBe(root);
      expect(onSelectionChange).not.toHaveBeenCalled();

      stdin.write('\u001B[B');
      await waitFor(() => current() === child);
      expect(onSelectionChange).toHaveBeenCalledOnce();
      stdin.write('\u001B[B');
      stdin.write('\u001B[B');
      await sleep(30);
      expect(current()).toBe(child);
      expect(onSelectionChange).toHaveBeenCalledOnce();
      expect(onCancel).not.toHaveBeenCalled();

      stdin.write('\r');
      await waitFor(() => onFocusStream.mock.calls.length === 1);
      expect(onFocusStream).toHaveBeenCalledWith(child);
    } finally {
      instance.unmount();
    }
  });

  it.each([
    { direction: '↓', key: '\u001B[B', boundary: child },
    { direction: '↑', key: '\u001B[A', boundary: root },
  ])(
    'clamps repeated $direction presses at the boundary row without cancelling',
    async ({ key, boundary }) => {
      const { ink, React } = await loadInk();
      const onCancel = vi.fn();
      const onSelectionChange = vi.fn();

      const { instance, stdin } = renderChildList(
        ink,
        React.createElement(SubagentList, {
          keyboardActive: true,
          maxRows: 5,
          onCancel,
          onSelectionChange,
          selectedValue: boundary,
          sessions: [session(root, true), session(child)],
        }),
      );

      try {
        await waitForInput(stdin);
        stdin.write(key);
        stdin.write(key);
        stdin.write(key);
        // No state change to await for a no-op; give the event loop a turn.
        await sleep(30);

        expect(onCancel).not.toHaveBeenCalled();
        expect(onSelectionChange).not.toHaveBeenCalled();
      } finally {
        instance.unmount();
      }
    },
  );
});
