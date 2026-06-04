import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeClipboardText } from '@cli/runtime/clipboardText';
import type { spawn } from 'node:child_process';

type SpawnCommand = typeof spawn;

interface ChildScenario {
  readonly closeCode?: number;
  readonly hang?: boolean;
  readonly stderr?: string;
}

class FakeClipboardChild extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly stdin: EventEmitter & {
    end: (chunk?: string | Buffer, encoding?: BufferEncoding) => void;
  };
  readonly kill = vi.fn(() => true);
  input = '';
  inputEncoding: BufferEncoding | undefined;

  constructor(private readonly scenario: ChildScenario) {
    super();
    const stdin = new EventEmitter() as FakeClipboardChild['stdin'];
    stdin.end = (chunk, encoding): void => {
      this.input += Buffer.isBuffer(chunk)
        ? chunk.toString('utf8')
        : (chunk ?? '');
      this.inputEncoding = encoding;
      if (this.scenario.hang) return;
      queueMicrotask(() => {
        if (this.scenario.stderr) {
          this.stderr.emit('data', this.scenario.stderr);
        }
        this.emit('close', this.scenario.closeCode ?? 0);
      });
    };
    this.stdin = stdin;
  }
}

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: unknown;
  readonly child: FakeClipboardChild;
}

function spawnStub(scenarios: readonly ChildScenario[]): {
  readonly calls: readonly SpawnCall[];
  readonly spawnCommand: SpawnCommand;
} {
  const calls: SpawnCall[] = [];
  const spawnMock = vi.fn(
    (command: string, args: readonly string[], options) => {
      const child = new FakeClipboardChild(scenarios[calls.length] ?? {});
      calls.push({ command, args, options, child });
      return child;
    },
  );
  return {
    calls,
    spawnCommand: spawnMock as unknown as SpawnCommand,
  };
}

describe('CLI clipboard text writer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a Unicode-safe PowerShell command for Windows text copies', async () => {
    const { calls, spawnCommand } = spawnStub([{ closeCode: 0 }]);

    const result = await writeClipboardText('alpha π\nbeta 🚀', {
      platform: 'win32',
      spawnCommand,
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('powershell.exe');
    expect(calls[0]?.command).not.toBe('clip.exe');
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining(['-NoProfile', '-NonInteractive', '-Command']),
    );
    expect(calls[0]?.args.join(' ')).toContain('InputEncoding');
    expect(calls[0]?.args.join(' ')).toContain('Set-Clipboard');
    expect(calls[0]?.child.input).toBe('alpha π\r\nbeta 🚀');
    expect(calls[0]?.child.inputEncoding).toBe('utf8');
  });

  it('kills a hung command and falls back to the next Linux clipboard tool', async () => {
    vi.useFakeTimers();
    const { calls, spawnCommand } = spawnStub([
      { hang: true },
      { closeCode: 0 },
    ]);

    const resultPromise = writeClipboardText('question', {
      platform: 'linux',
      spawnCommand,
      timeoutMs: 25,
    });

    expect(calls.map((call) => call.command)).toEqual(['wl-copy']);
    await vi.advanceTimersByTimeAsync(25);

    await expect(resultPromise).resolves.toEqual({ ok: true });
    expect(calls.map((call) => call.command)).toEqual(['wl-copy', 'xclip']);
    expect(calls[0]?.child.kill).toHaveBeenCalledTimes(1);
    expect(calls[1]?.child.kill).not.toHaveBeenCalled();
  });

  it('reports timeout failure when the platform clipboard command hangs', async () => {
    vi.useFakeTimers();
    const { calls, spawnCommand } = spawnStub([{ hang: true }]);

    const resultPromise = writeClipboardText('question', {
      platform: 'darwin',
      spawnCommand,
      timeoutMs: 10,
    });

    await vi.advanceTimersByTimeAsync(10);

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      reason: 'pbcopy timed out after 10ms',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.child.kill).toHaveBeenCalledTimes(1);
  });
});
