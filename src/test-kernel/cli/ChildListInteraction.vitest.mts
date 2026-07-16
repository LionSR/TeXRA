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
  readonly firstWrite: Promise<void>;
  private resolveFirstWrite: (() => void) | undefined;

  constructor() {
    super();
    this.firstWrite = new Promise((resolve) => {
      this.resolveFirstWrite = resolve;
    });
  }

  write(chunk: string): boolean {
    this.output += chunk;
    this.resolveFirstWrite?.();
    this.resolveFirstWrite = undefined;
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
    const stdout = new FakeStdout();
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
        keyboardActive: false,
        maxRows: 3,
      }),
      {
        stdout,
        patchConsole: false,
      },
    );

    try {
      await stdout.firstWrite;
      expect(stdout.output).toContain('latexmk');
      expect(stdout.output).not.toContain(POINTER);
    } finally {
      instance.unmount();
    }
  });

  it('views and kills only the selected active session, then focuses it', async () => {
    const ink = (await import(cliRequire.resolve('ink'))) as any;
    const React = ((await import(cliRequire.resolve('react'))) as any).default;
    const root = 'root' as StreamTabId;
    const child = 'child' as StreamTabId;
    const onFocusStream = vi.fn();
    const onKillExecution = vi.fn();
    const onViewStream = vi.fn();
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
        onViewStream,
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
      await waitFor(() => onViewStream.mock.calls.length === 1);
      stdin.write('k');
      await waitFor(() => onKillExecution.mock.calls.length === 1);
      stdin.write('\r');
      await waitFor(() => onFocusStream.mock.calls.length === 1);
      stdin.write('\u001B');
      await waitFor(() => onCancel.mock.calls.length === 1);

      expect(onViewStream).toHaveBeenCalledWith(child);
      expect(onKillExecution).toHaveBeenCalledWith('child-exec');
      expect(onFocusStream).toHaveBeenCalledWith(child);
      expect(onCancel).toHaveBeenCalledOnce();
    } finally {
      instance.unmount();
    }
  });

  it('opens and kills a selected process without viewing a transcript', async () => {
    const ink = (await import(cliRequire.resolve('ink'))) as any;
    const React = ((await import(cliRequire.resolve('react'))) as any).default;
    const processValue = childProcessListValue('process-exec');
    const onKillExecution = vi.fn();
    const onOpenProcessDetail = vi.fn();
    const onViewStream = vi.fn();

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
        onViewStream,
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

      expect(onViewStream).not.toHaveBeenCalled();
      expect(onKillExecution).toHaveBeenCalledWith('process-exec');
      expect(onOpenProcessDetail).toHaveBeenCalledWith('process-exec');
    } finally {
      instance.unmount();
    }
  });
});
