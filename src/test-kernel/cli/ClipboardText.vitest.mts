import { afterEach, describe, expect, it, vi } from 'vitest';

const writeMock = vi.hoisted(() => vi.fn());

vi.mock('clipboardy', () => ({
  default: { write: writeMock },
}));

import { writeClipboardText } from '@cli/runtime/clipboardText';

describe('CLI clipboard text writer', () => {
  afterEach(() => {
    writeMock.mockReset();
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
});
