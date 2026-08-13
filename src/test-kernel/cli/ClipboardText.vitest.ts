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

  describe('when the write never settles', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    // Drives a wedged `clipboardy.write` past the 5s deadline and asserts the
    // reported timeout; per-test expectations then cover the helper reaping.
    async function expectWriteToTimeOut(
      platform: NodeJS.Platform,
    ): Promise<void> {
      writeMock.mockReturnValue(new Promise<void>(() => {}));

      const resultPromise = writeClipboardText('question', { platform });
      await vi.advanceTimersByTimeAsync(6_000);

      expect(await resultPromise).toEqual({
        ok: false,
        reason: 'Clipboard write timed out after 5000ms',
      });
    }

    it('reports failure instead of hanging', async () => {
      await expectWriteToTimeOut('darwin');
    });

    it('kills wedged copy helpers it spawned on timeout, and only those', async () => {
      execFileMock.mockResolvedValueOnce({
        stdout: [
          '  101      1 /usr/bin/pbcopy', // someone else's child
          `  202 ${process.pid} vim`, // our child, not a copy helper
          `  303 ${process.pid} /usr/bin/pbcopy`, // wedged helper
          `  404 ${process.pid} wl-copy`, // stray from an earlier attempt
          `  505 ${process.pid} termux-clipboar`, // TASK_COMM_LEN-truncated
        ].join('\n'),
        stderr: '',
      });

      await expectWriteToTimeOut('darwin');

      expect(execFileMock).toHaveBeenCalledWith(
        'ps',
        ['-Ao', 'pid=,ppid=,comm='],
        expect.objectContaining({ timeout: 2_000 }),
      );
      expect(process.kill).toHaveBeenCalledTimes(3);
      expect(process.kill).toHaveBeenCalledWith(303, 'SIGKILL');
      expect(process.kill).toHaveBeenCalledWith(404, 'SIGKILL');
      expect(process.kill).toHaveBeenCalledWith(505, 'SIGKILL');
    });

    it('sweeps again after a delay to catch the fallback helper a kill can spawn', async () => {
      execFileMock.mockResolvedValueOnce({
        stdout: `  303 ${process.pid} xsel`, // wedged system helper
        stderr: '',
      });
      // Killing the system helper makes clipboardy retry with its bundled
      // fallback binary, which here wedges too.
      execFileMock.mockResolvedValueOnce({
        stdout: `  606 ${process.pid} /repo/node_modules/clipboardy/fallbacks/linux/xsel`,
        stderr: '',
      });

      await expectWriteToTimeOut('linux');

      expect(execFileMock).toHaveBeenCalledTimes(2);
      expect(process.kill).toHaveBeenCalledTimes(2);
      expect(process.kill).toHaveBeenCalledWith(303, 'SIGKILL');
      expect(process.kill).toHaveBeenCalledWith(606, 'SIGKILL');
    });

    it('reaps Windows copy helpers through a parent-pid-bounded Stop-Process', async () => {
      await expectWriteToTimeOut('win32');

      // One sweep for the wedged helper, one for the fallback a kill spawns.
      expect(execFileMock).toHaveBeenCalledTimes(2);
      const [command, args] = execFileMock.mock.calls[0] as [
        string,
        readonly string[],
      ];
      expect(command).toBe('powershell');
      const script = args.at(-1) ?? '';
      expect(script).toContain(`ParentProcessId=${process.pid}`);
      expect(script).toContain('Stop-Process');
      // The reap script must not match itself: it excludes its own PID and
      // its command line never contains the literal it greps for.
      expect(script).toContain('$_.ProcessId -ne $PID');
      expect(script).not.toContain('-EncodedCommand');
      expect(process.kill).not.toHaveBeenCalled();
    });

    it('still reports the timeout when helper reaping itself fails', async () => {
      execFileMock.mockRejectedValue(new Error('ps exploded'));

      await expectWriteToTimeOut('darwin');
    });
  });
});
