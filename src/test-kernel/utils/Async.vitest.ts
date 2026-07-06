import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFlushableDebounce, delay } from '@utils/core/async';

describe('async utilities', () => {
  it('resolves after the requested delay', async () => {
    await expect(delay(0)).resolves.toBeUndefined();
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('stop');
    controller.abort(reason);

    await expect(delay(100, { signal: controller.signal })).rejects.toBe(
      reason,
    );
  });

  it('rejects an in-flight delay when the signal aborts', async () => {
    const controller = new AbortController();
    const promise = delay(100, { signal: controller.signal });

    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('createFlushableDebounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('invokes the callback once after the wait elapses', () => {
    const callback = vi.fn();
    const batcher = createFlushableDebounce(callback, 100);

    batcher.schedule();
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(99);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledOnce();
    expect(batcher.pending).toBe(false);
  });

  it('restarts the timer on every schedule() call, like a classic trailing debounce', () => {
    const callback = vi.fn();
    const batcher = createFlushableDebounce(callback, 100);

    batcher.schedule();
    vi.advanceTimersByTime(60);
    batcher.schedule(); // resets the 100ms window
    vi.advanceTimersByTime(60);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(40);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('flush() runs the callback synchronously and clears the pending timer', () => {
    const callback = vi.fn();
    const batcher = createFlushableDebounce(callback, 100);

    batcher.schedule();
    batcher.flush();

    expect(callback).toHaveBeenCalledOnce();
    expect(batcher.pending).toBe(false);

    // The timer was cleared by flush(), so letting it "expire" must not
    // invoke the callback a second time.
    vi.advanceTimersByTime(100);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('flush() is a no-op when nothing is pending', () => {
    const callback = vi.fn();
    const batcher = createFlushableDebounce(callback, 100);

    batcher.flush();

    expect(callback).not.toHaveBeenCalled();
  });

  it('cancel() drops the pending call without invoking the callback', () => {
    const callback = vi.fn();
    const batcher = createFlushableDebounce(callback, 100);

    batcher.schedule();
    batcher.cancel();
    expect(batcher.pending).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(callback).not.toHaveBeenCalled();
  });

  it('cancel() is a no-op when nothing is pending', () => {
    const callback = vi.fn();
    const batcher = createFlushableDebounce(callback, 100);

    expect(() => batcher.cancel()).not.toThrow();
    expect(batcher.pending).toBe(false);
  });

  it('pending reflects schedule/fire/flush/cancel transitions', () => {
    const batcher = createFlushableDebounce(vi.fn(), 50);

    expect(batcher.pending).toBe(false);
    batcher.schedule();
    expect(batcher.pending).toBe(true);
    vi.advanceTimersByTime(50);
    expect(batcher.pending).toBe(false);

    batcher.schedule();
    batcher.cancel();
    expect(batcher.pending).toBe(false);
  });

  it('schedule() after flush() starts a fresh window (flush fully resets state)', () => {
    const callback = vi.fn();
    const batcher = createFlushableDebounce(callback, 100);

    batcher.schedule();
    batcher.flush();
    expect(callback).toHaveBeenCalledOnce();

    batcher.schedule();
    vi.advanceTimersByTime(100);
    expect(callback).toHaveBeenCalledTimes(2);
  });
});
