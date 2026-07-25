import { describe, expect, it, vi } from 'vitest';

import { SubagentList } from '@cli/chat/tui/panes/SubagentList';
import {
  childPhaseListValue,
  childStreamListValue,
  type ChildListValue,
} from '@cli/chat/tui/state/childListSelection';
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

  it('skips disabled phase headers during arrow navigation', async () => {
    const { ink, React } = await loadInk();
    const root = 'root' as StreamTabId;
    const child = 'child' as StreamTabId;
    const onFocusStream = vi.fn();
    let selected = childStreamListValue(root);

    function Harness() {
      const [value, setValue] = React.useState(selected) as [
        ChildListValue,
        (next: ChildListValue) => void,
      ];
      return React.createElement(SubagentList, {
        keyboardActive: true,
        listRootStreamId: root,
        maxRows: 5,
        onCancel: vi.fn(),
        onFocusStream,
        onSelectionChange: (next: ChildListValue) => {
          selected = next;
          setValue(next);
        },
        selectedValue: value,
        sessions: [
          session(root, true),
          {
            ...session(child),
            parentId: root,
            workflowPhase: 'Map:review|draft',
          },
        ],
      });
    }

    const stdin = new FakeStdin();
    const stdout = new FakeStdout(100);
    const instance = ink.render(React.createElement(Harness), {
      stdin,
      stdout,
      interactive: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    try {
      await waitFor(
        () =>
          stdin.listenerCount('readable') > 0 &&
          stdout.output.includes('◆ Map:review|draft'),
      );
      expect(stdout.output).toContain('◆ Map:review|draft');
      stdin.write('\u001B[B');
      await waitFor(() => selected === childStreamListValue(child));
      stdin.write('\r');
      await waitFor(() => onFocusStream.mock.calls.length === 1);

      expect(onFocusStream).toHaveBeenCalledWith(child);
    } finally {
      instance.unmount();
    }
  });

  it('keeps a controlled phase-header selection inert', async () => {
    const { ink, React } = await loadInk();
    const root = 'root' as StreamTabId;
    const child = 'child' as StreamTabId;
    const callbacks = {
      onFocusStream: vi.fn(),
      onKillExecution: vi.fn(),
      onPrintStream: vi.fn(),
      onRetryExecution: vi.fn(),
      onSkipExecution: vi.fn(),
    };
    const stdin = new FakeStdin();
    const instance = ink.render(
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
      for (const input of ['v', 'k', 's', 'r', '\r']) stdin.write(input);
      await new Promise((resolve) => setTimeout(resolve, 30));

      for (const callback of Object.values(callbacks)) {
        expect(callback).not.toHaveBeenCalled();
      }
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
