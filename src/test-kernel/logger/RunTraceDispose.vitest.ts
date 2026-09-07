import { afterEach, describe, expect, it, vi } from 'vitest';

import * as logUtils from '@logger/logUtils';
import { createRunTrace } from '@transcript';

describe('createRunTrace dispose', () => {
  afterEach(() => logUtils.setOutputChannelFactory(null));

  it('disposes the per-run output channel and residency lease once', () => {
    const dispose = vi.fn();
    const close = vi.fn();
    logUtils.setOutputChannelFactory(() => ({ appendLine: vi.fn(), dispose }));
    const handle = createRunTrace('channel-stream', { close });
    handle.dispose();
    handle.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('releases residency even when the output channel cannot close', () => {
    const failure = new Error('channel disposal failed');
    const close = vi.fn();
    logUtils.setOutputChannelFactory(() => ({
      appendLine: vi.fn(),
      dispose: () => {
        throw failure;
      },
    }));
    const handle = createRunTrace('failed-stream', { close });
    expect(() => handle.dispose()).toThrow(failure);
    expect(close).toHaveBeenCalledOnce();
    expect(() => handle.dispose()).not.toThrow();
  });
});
