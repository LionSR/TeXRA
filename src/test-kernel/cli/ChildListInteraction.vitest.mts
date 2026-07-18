import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

import { describe, expect, it, vi } from 'vitest';

import { SubagentList } from '@cli/chat/tui/panes/SubagentList';
import {
  childProcessListValue,
  childStreamListValue,
  type ChildListValue,
} from '@cli/chat/tui/state/childListSelection';
import type { StreamView } from '@cli/chat/tui/state/streamViews';
import { POINTER } from '@cli/chat/tui/ui/glyphs';
import type { StreamTabId } from '@shared/schemas';

const cliRequire = createRequire(
  new URL('../../../packages/cli/package.json', import.meta.url),
);

class FakeStdout extends EventEmitter {
  readonly isTTY = true;
  readonly columns = 100;
  readonly rows = 24;
  output = '';

  write(chunk: string): boolean {
    this.output += chunk;
    return true;
  }

  getColorDepth(): number {
    return 24;
  }
}

class FakeStdin extends EventEmitter {
  readonly isTTY = true;
  private readonly chunks: string[] = [];

  write(chunk: string): void {
    this.chunks.push(chunk);
    this.emit('readable');
  }

  read(): string | null {
    return this.chunks.shift() ?? null;
  }

  ref(): void {}
  unref(): void {}
  pause(): void {}
  resume(): void {}
  setEncoding(): void {}
  setRawMode(): void {}
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for child-list input');
}

function session(id: StreamTabId, active = false): StreamView {
  return { id, label: id, slice: undefined, active };
}

describe('CLI child list interaction', () => {
  it('renders no process highlight before the list receives a selection', async () => {
    const ink = (await import(cliRequire.resolve('ink'))) as any;
    const React = ((await import(cliRequire.resolve('react'))) as any).default;
    const output = ink.renderToString(
      React.createElement(SubagentList, {
        activeProcesses: [
          {
            kind: 'process',
            executionId: 'process-exec',
            agentName: 'latexmk',
            status: 'running',
          },
        ],
        keyboardActive: false,
        maxRows: 3,
      }),
      { columns: 100 },
    );

    expect(output).toContain('latexmk');
    expect(output).not.toContain(POINTER);
  });

  it('prints and kills only the selected active session, then focuses it', async () => {
    const ink = (await import(cliRequire.resolve('ink'))) as any;
    const React = ((await import(cliRequire.resolve('react'))) as any).default;
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
      stdout: new FakeStdout(),
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
    const ink = (await import(cliRequire.resolve('ink'))) as any;
    const React = ((await import(cliRequire.resolve('react'))) as any).default;
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
        stdout: new FakeStdout(),
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

  it('opens and kills a selected process without printing stream output', async () => {
    const ink = (await import(cliRequire.resolve('ink'))) as any;
    const React = ((await import(cliRequire.resolve('react'))) as any).default;
    const processValue = childProcessListValue('process-exec');
    const onKillExecution = vi.fn();
    const onOpenProcessDetail = vi.fn();
    const onPrintStream = vi.fn();

    const stdin = new FakeStdin();
    const instance = ink.render(
      React.createElement(SubagentList, {
        activeProcesses: [
          {
            kind: 'process',
            executionId: 'process-exec',
            agentName: 'latexmk',
            status: 'running',
          },
        ],
        keyboardActive: true,
        maxRows: 3,
        onCancel: vi.fn(),
        onKillExecution,
        onOpenProcessDetail,
        onSelectionChange: vi.fn(),
        onPrintStream,
        selectedValue: processValue,
      }),
      {
        stdin,
        stdout: new FakeStdout(),
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write('v');
      stdin.write('k');
      await waitFor(() => onKillExecution.mock.calls.length === 1);
      stdin.write('\r');
      await waitFor(() => onOpenProcessDetail.mock.calls.length === 1);

      expect(onPrintStream).not.toHaveBeenCalled();
      expect(onKillExecution).toHaveBeenCalledWith('process-exec');
      expect(onOpenProcessDetail).toHaveBeenCalledWith('process-exec');
    } finally {
      instance.unmount();
    }
  });
});
