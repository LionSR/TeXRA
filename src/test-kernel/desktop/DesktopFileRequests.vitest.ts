import { afterEach, describe, expect, it, vi } from 'vitest';

import { DESKTOP_WORKSPACE_COMMANDS } from '@desktop/shared/desktopWorkspaceMessages';

const mocks = vi.hoisted(() => ({ postMessage: vi.fn() }));

vi.mock('@shared/hostBridge', () => ({ postMessage: mocks.postMessage }));

import {
  disposePendingFileRequests,
  requestFileRead,
  requestFileWrite,
  requestFiles,
  takePendingFileRequest,
} from '@desktop/renderer/fileRequests';

describe('desktop file requests', () => {
  afterEach(() => {
    disposePendingFileRequests();
    mocks.postMessage.mockReset();
  });

  it('rejects every pending request when its renderer is disposed', async () => {
    const read = requestFileRead('main.tex');
    const list = requestFiles('.');

    disposePendingFileRequests();

    await expect(read).rejects.toThrow('desktop renderer was disposed');
    await expect(list).rejects.toThrow('desktop renderer was disposed');
    expect(mocks.postMessage).toHaveBeenCalledWith(
      DESKTOP_WORKSPACE_COMMANDS.READ_FILE,
      expect.objectContaining({ path: 'main.tex' }),
    );
  });

  it('rejects immediately and unregisters when posting throws', async () => {
    mocks.postMessage.mockImplementationOnce(() => {
      throw new Error('desktop bridge unavailable');
    });

    const read = requestFileRead('main.tex');
    const request = mocks.postMessage.mock.calls[0]?.[1] as
      { requestId: string } | undefined;
    if (!request) throw new Error('Expected a desktop file request');

    await expect(read).rejects.toThrow('desktop bridge unavailable');
    expect(takePendingFileRequest(request.requestId)).toBeUndefined();
  });

  it('clears the timeout when a read response resolves', async () => {
    vi.useFakeTimers();
    try {
      const read = requestFileRead('main.tex');
      const rejected = vi.fn();
      void read.catch(rejected);
      const request = mocks.postMessage.mock.calls[0]?.[1] as
        { requestId: string } | undefined;
      if (!request) throw new Error('Expected a desktop file request');
      const pending = takePendingFileRequest(request.requestId);
      if (pending?.kind !== 'read') {
        throw new Error('Expected a pending desktop file read');
      }

      pending.resolve('contents');

      await expect(read).resolves.toBe('contents');
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(rejected).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out reads after 60 seconds and ignores a late response', async () => {
    vi.useFakeTimers();
    try {
      const read = requestFileRead('main.tex');
      const request = mocks.postMessage.mock.calls[0]?.[1] as
        { requestId: string } | undefined;
      if (!request) throw new Error('Expected a desktop file request');
      const rejection = expect(read).rejects.toThrow(
        'desktop file request timed out',
      );

      await vi.advanceTimersByTimeAsync(60_000);

      await rejection;
      expect(takePendingFileRequest(request.requestId)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps waiting for writes that may still complete in the main process', async () => {
    vi.useFakeTimers();
    try {
      const write = requestFileWrite('main.tex', 'revised');
      const settled = vi.fn();
      void write.then(settled, settled);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(settled).not.toHaveBeenCalled();
      disposePendingFileRequests();
      await expect(write).rejects.toThrow('desktop renderer was disposed');
    } finally {
      vi.useRealTimers();
    }
  });
});
