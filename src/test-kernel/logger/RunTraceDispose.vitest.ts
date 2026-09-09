import { afterEach, describe, expect, it, vi } from 'vitest';

import { setLogSink } from '@logger/logSink';
import { createRunTrace } from '@transcript';

describe('createRunTrace dispose', () => {
  afterEach(() => setLogSink(null));

  it('releases the per-run host surface and residency lease once', () => {
    const disposeRun = vi.fn();
    const close = vi.fn();
    setLogSink({ write: vi.fn(), disposeRun });
    const handle = createRunTrace('channel-stream', { close });
    handle.dispose();
    handle.dispose();
    expect(disposeRun).toHaveBeenCalledExactlyOnceWith('channel-stream');
    expect(close).toHaveBeenCalledOnce();
  });

  it('releases residency even when the host surface cannot close', () => {
    const failure = new Error('channel disposal failed');
    const close = vi.fn();
    setLogSink({
      write: vi.fn(),
      disposeRun: () => {
        throw failure;
      },
    });
    const handle = createRunTrace('failed-stream', { close });
    expect(() => handle.dispose()).toThrow(failure);
    expect(close).toHaveBeenCalledOnce();
    expect(() => handle.dispose()).not.toThrow();
  });
});
