import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it, vi } from 'vitest';

import { SubagentList } from '@cli/chat/tui/panes/SubagentList';
import {
  childPhaseListValue,
  childStreamListValue,
  workflowPhaseListValue,
  workflowTaskListValue,
  type ChildListValue,
} from '@cli/chat/tui/state/childListSelection';
import { emptySlice, type StreamSlice } from '@cli/chat/tui/state/cliState';
import type { StreamView } from '@cli/chat/tui/state/streamViews';
import { POINTER } from '@cli/tui/ui/glyphs';
import { AgentCategory, type StreamTabId } from '@shared/schemas';
import {
  loadInk,
  renderInteractive,
  renderOutputAtTerminalSize,
  type FakeStdin,
  type InkRenderHandles,
} from '@test/support/inkTestHarness.ts';
import { waitForCondition as waitFor } from '@test/support/asyncTestUtils';

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
 * the app's wiring. `current()` reads the latest selection; `reset()` moves
 * the initial value before a remount.
 */
function controlledList(
  React: any,
  initial: ChildListValue,
  props: Record<string, unknown>,
): {
  Harness: () => any;
  current: () => ChildListValue;
  reset: (next: ChildListValue) => void;
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
    });
  }
  return {
    Harness,
    current: () => selected,
    reset: (next: ChildListValue) => {
      selected = next;
    },
  };
}

function workflowRootSlice(entries: StreamSlice['entries']): StreamSlice {
  return {
    ...emptySlice(root),
    agent: 'workflow',
    identity: {
      kind: 'multiAgentWorkflow' as const,
      workflowName: 'workflow',
    },
    category: AgentCategory.Workflow,
    entries,
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
    const { Harness, current } = controlledList(
      React,
      childStreamListValue(root),
      {
        activeSubagentExecutionIds: new Map([[child, 'child-exec']]),
        keyboardActive: true,
        maxRows: 5,
        onCancel,
        onFocusStream,
        onKillExecution,
        sessions: [session(root, true), session(child)],
      },
    );

    const { instance, stdin } = renderChildList(
      ink,
      React.createElement(Harness),
    );

    try {
      await waitForInput(stdin);
      stdin.write('\u001B[B');
      await waitFor(() => current() === childStreamListValue(child));
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

  it('skips and retries the focused subagent grandchild by execution id', async () => {
    const { ink, React } = await loadInk();
    const onSkipExecution = vi.fn();
    const onRetryExecution = vi.fn();

    const { instance, stdin } = renderChildList(
      ink,
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
    );

    try {
      await waitForInput(stdin);
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

  it('skips disabled phase headers and clamps at selectable boundaries', async () => {
    const { ink, React } = await loadInk();
    const onCancel = vi.fn();
    const onFocusStream = vi.fn();
    const onSelectionChange = vi.fn();
    const { Harness, current } = controlledList(
      React,
      childStreamListValue(root),
      {
        keyboardActive: true,
        listRootStreamId: root,
        maxRows: 5,
        onCancel,
        onFocusStream,
        onSelectionChange,
        sessions: [
          session(root, true),
          {
            ...session(child),
            parentId: root,
            workflowPhase: 'Map:review|draft',
          },
        ],
      },
    );

    const { instance, stdin, stdout } = renderChildList(
      ink,
      React.createElement(Harness),
    );

    try {
      await waitFor(
        () =>
          stdin.listenerCount('readable') > 0 &&
          stdout.output.includes('◆ Map:review|draft'),
      );
      expect(stdout.output).toContain('◆ Map:review|draft');
      stdin.write('\u001B[A');
      stdin.write('\u001B[A');
      await sleep(30);
      expect(current()).toBe(childStreamListValue(root));
      expect(onSelectionChange).not.toHaveBeenCalled();

      stdin.write('\u001B[B');
      await waitFor(() => current() === childStreamListValue(child));
      expect(onSelectionChange).toHaveBeenCalledOnce();
      stdin.write('\u001B[B');
      stdin.write('\u001B[B');
      await sleep(30);
      expect(current()).toBe(childStreamListValue(child));
      expect(onSelectionChange).toHaveBeenCalledOnce();
      expect(onCancel).not.toHaveBeenCalled();

      stdin.write('\r');
      await waitFor(() => onFocusStream.mock.calls.length === 1);
      expect(onFocusStream).toHaveBeenCalledWith(child);
    } finally {
      instance.unmount();
    }
  });

  it('keeps a controlled phase-header selection inert', async () => {
    const { ink, React } = await loadInk();
    const callbacks = {
      onFocusStream: vi.fn(),
      onKillExecution: vi.fn(),
      onRetryExecution: vi.fn(),
      onSkipExecution: vi.fn(),
    };
    const { instance, stdin } = renderChildList(
      ink,
      React.createElement(SubagentList, {
        activeSubagentExecutionIds: new Map([[child, 'child-exec']]),
        keyboardActive: true,
        listRootStreamId: root,
        maxRows: 5,
        onCancel: vi.fn(),
        selectedValue: childPhaseListValue(0),
        sessions: [
          session(root, true),
          { ...session(child), parentId: root, workflowPhase: 'Map' },
        ],
        ...callbacks,
      }),
    );

    try {
      await waitForInput(stdin);
      for (const input of ['k', 's', 'r', '\r']) stdin.write(input);
      await sleep(30);

      for (const callback of Object.values(callbacks)) {
        expect(callback).not.toHaveBeenCalled();
      }
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
          selectedValue: childStreamListValue(boundary),
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

  it('enters and leaves wide workflow tasks and ignores no-child Enter', async () => {
    const { ink, React } = await loadInk();
    const onFocusStream = vi.fn();
    const phaseValue = workflowPhaseListValue('phase-map');
    const childTaskValue = workflowTaskListValue('task-child');
    const plannedTaskValue = workflowTaskListValue('task-planned');
    const rootSlice = workflowRootSlice([
      {
        id: 'phase-map',
        role: 'phase',
        text: 'Map',
        finalized: true,
        phaseLabel: 'Map',
        phaseIndex: 0,
        phaseTotal: 1,
      },
      {
        id: 'task-child',
        role: 'workflowTask',
        text: 'Running: Inspect',
        finalized: false,
        task: {
          id: 'inspect',
          label: 'Inspect',
          phase: 'Map',
          status: 'running',
          childStreamId: child,
        },
      },
      {
        id: 'task-planned',
        role: 'workflowTask',
        text: 'Planned: Summarize',
        finalized: false,
        task: {
          id: 'summarize',
          label: 'Summarize',
          phase: 'Map',
          status: 'planned',
        },
      },
    ]);
    const { Harness, current, reset } = controlledList(React, phaseValue, {
      keyboardActive: true,
      listRootStreamId: root,
      listRootSlice: rootSlice,
      maxRows: 6,
      onCancel: vi.fn(),
      onFocusStream,
      sessions: [
        { id: root, label: 'workflow', active: true, slice: rootSlice },
      ],
      streams: new Map([
        [root, rootSlice],
        [child, emptySlice(child)],
      ]),
    });

    const { instance, stdin } = renderChildList(
      ink,
      React.createElement(Harness),
    );
    try {
      await waitForInput(stdin);
      stdin.write('\u001B[C');
      await waitFor(() => current() === childTaskValue);
      stdin.write('\u001B[D');
      await waitFor(() => current() === phaseValue);
      stdin.write('\r');
      await waitFor(() => current() === childTaskValue);
      stdin.write('\r');
      await waitFor(() => onFocusStream.mock.calls.length === 1);
      expect(onFocusStream).toHaveBeenCalledWith(child);

      stdin.write('\u001B[B');
      await waitFor(() => current() === plannedTaskValue);
      stdin.write('\r');
      await sleep(30);
      expect(onFocusStream).toHaveBeenCalledOnce();
    } finally {
      instance.unmount();
    }

    reset(childTaskValue);
    onFocusStream.mockClear();
    const narrow = renderInteractive(ink, React.createElement(Harness), {
      columns: 99,
    });
    try {
      await waitForInput(narrow.stdin);
      narrow.stdin.write('\u001B[B');
      await waitFor(() => current() === plannedTaskValue);
      narrow.stdin.write('\r');
      await sleep(30);
      expect(onFocusStream).not.toHaveBeenCalled();

      narrow.stdin.write('\u001B[A');
      await waitFor(() => current() === childTaskValue);
      narrow.stdin.write('\r');
      await waitFor(() => onFocusStream.mock.calls.length === 1);
      expect(onFocusStream).toHaveBeenCalledWith(child);
    } finally {
      narrow.instance.unmount();
    }
  });

  it('keeps detail and controls inert when workflow tasks reuse a child id', async () => {
    const { ink, React } = await loadInk();
    const onFocusStream = vi.fn();
    const onSkipExecution = vi.fn();
    const rootSlice = workflowRootSlice([
      ...['first', 'second'].map((id) => ({
        id: `task-${id}`,
        role: 'workflowTask' as const,
        text: `Running: ${id}`,
        finalized: false,
        task: {
          id,
          label: id,
          status: 'running' as const,
          childStreamId: child,
        },
      })),
      {
        id: 'task-missing',
        role: 'workflowTask',
        text: 'Running: missing',
        finalized: false,
        task: {
          id: 'missing',
          label: 'missing',
          status: 'running',
          childStreamId: 'missing-child' as StreamTabId,
        },
      },
    ]);

    async function expectControlsInert(
      props: Record<string, unknown>,
    ): Promise<void> {
      const { instance, stdin } = renderChildList(
        ink,
        React.createElement(SubagentList, {
          keyboardActive: true,
          listRootStreamId: root,
          listRootSlice: rootSlice,
          maxRows: 6,
          onCancel: vi.fn(),
          onFocusStream,
          onSkipExecution,
          sessions: [],
          ...props,
        }),
      );
      try {
        await waitForInput(stdin);
        for (const input of ['\r', 's']) stdin.write(input);
        await sleep(30);
        expect(onFocusStream).not.toHaveBeenCalled();
        expect(onSkipExecution).not.toHaveBeenCalled();
      } finally {
        instance.unmount();
      }
    }

    await expectControlsInert({
      activeSubagentExecutionIds: new Map([[child, 'shared-exec']]),
      selectedValue: workflowTaskListValue('task-first'),
      streams: new Map([
        [root, rootSlice],
        [child, emptySlice(child)],
      ]),
    });

    await expectControlsInert({
      selectedValue: workflowTaskListValue('task-missing'),
      streams: new Map([[root, rootSlice]]),
    });
  });
});
