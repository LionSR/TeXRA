import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const writeMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('clipboardy', () => ({
  default: { write: writeMock },
}));

// `clipboardText` reaps wedged clipboard helpers through
// `promisify(execFile)`, so the mock must carry `promisify.custom` for the
// promisified call to route here.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFile = Object.assign(
    (...args: unknown[]) => execFileMock(...args),
    { [promisify.custom]: (...args: unknown[]) => execFileMock(...args) },
  );
  return { ...actual, execFile };
});

import { writeClipboardText } from '@cli/runtime/clipboardText';

describe('CLI clipboard text writer', () => {
  beforeEach(() => {
    execFileMock.mockResolvedValue({ stdout: '', stderr: '' });
    vi.spyOn(process, 'kill').mockReturnValue(true);
  });

  afterEach(() => {
    writeMock.mockReset();
    execFileMock.mockReset();
    vi.restoreAllMocks();
  });

  it('normalizes to CRLF line endings for Windows writes', async () => {
    writeMock.mockResolvedValue(undefined);

    const result = await writeClipboardText('alpha π\nbeta 🚀', {
      platform: 'win32',
    });

    expect(result).toEqual({ ok: true });
    expect(writeMock).toHaveBeenCalledWith('alpha π\r\nbeta 🚀');
  });

  it('normalizes to LF line endings on non-Windows platforms', async () => {
    writeMock.mockResolvedValue(undefined);

    const result = await writeClipboardText('alpha\r\nbeta\rgamma', {
      platform: 'darwin',
    });

    expect(result).toEqual({ ok: true });
    expect(writeMock).toHaveBeenCalledWith('alpha\nbeta\ngamma');
  });

  it('reports failure when the platform clipboard write rejects', async () => {
    writeMock.mockRejectedValue(new Error('pbcopy not found'));

    const result = await writeClipboardText('question', {
      platform: 'darwin',
    });

    expect(result).toEqual({ ok: false, reason: 'pbcopy not found' });
    // Only a timeout reaps helpers; an ordinary rejection means the helper
    // already exited.
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('reports failure instead of hanging when the write never settles', async () => {
    vi.useFakeTimers();
    try {
      writeMock.mockReturnValue(new Promise<void>(() => {}));

      const resultPromise = writeClipboardText('question', {
        platform: 'darwin',
      });
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await resultPromise;

      expect(result).toEqual({
        ok: false,
        reason: 'Clipboard write timed out after 5000ms',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('kills wedged copy helpers it spawned on timeout, and only those', async () => {
    vi.useFakeTimers();
    try {
      writeMock.mockReturnValue(new Promise<void>(() => {}));
      execFileMock.mockResolvedValue({
        stdout: [
          '  101      1 /usr/bin/pbcopy', // someone else's child
          `  202 ${process.pid} vim`, // our child, not a copy helper
          `  303 ${process.pid} /usr/bin/pbcopy`, // wedged helper
          `  404 ${process.pid} wl-copy`, // stray from an earlier attempt
        ].join('\n'),
        stderr: '',
      });

      const resultPromise = writeClipboardText('question', {
        platform: 'darwin',
      });
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await resultPromise;

      expect(result).toEqual({
        ok: false,
        reason: 'Clipboard write timed out after 5000ms',
      });
      expect(execFileMock).toHaveBeenCalledWith(
        'ps',
        ['-Ao', 'pid=,ppid=,comm='],
        expect.objectContaining({ timeout: 2_000 }),
      );
      expect(process.kill).toHaveBeenCalledTimes(2);
      expect(process.kill).toHaveBeenCalledWith(303, 'SIGKILL');
      expect(process.kill).toHaveBeenCalledWith(404, 'SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reaps Windows copy helpers through a parent-pid-bounded Stop-Process', async () => {
    vi.useFakeTimers();
    try {
      writeMock.mockReturnValue(new Promise<void>(() => {}));

      const resultPromise = writeClipboardText('question', {
        platform: 'win32',
      });
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await resultPromise;

      expect(result).toEqual({
        ok: false,
        reason: 'Clipboard write timed out after 5000ms',
      });
      expect(execFileMock).toHaveBeenCalledTimes(1);
      const [command, args] = execFileMock.mock.calls[0] as [
        string,
        readonly string[],
      ];
      expect(command).toBe('powershell');
      expect(args.at(-1)).toContain(`ParentProcessId=${process.pid}`);
      expect(args.at(-1)).toContain('Stop-Process');
      expect(process.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still reports the timeout when helper reaping itself fails', async () => {
    vi.useFakeTimers();
    try {
      writeMock.mockReturnValue(new Promise<void>(() => {}));
      execFileMock.mockRejectedValue(new Error('ps exploded'));

      const resultPromise = writeClipboardText('question', {
        platform: 'darwin',
      });
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await resultPromise;

      expect(result).toEqual({
        ok: false,
        reason: 'Clipboard write timed out after 5000ms',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
