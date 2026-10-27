import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFlushableDebounce,
  type FlushableDebounce,
} from '@texra/utils/core/flushableDebounce';
import { deriveRunId } from '@utils/core/idHash';

describe('deriveRunId', () => {
  it('is stable across identity field order', () => {
    expect(deriveRunId({ parent: 'abc', attempt: 2 })).toBe(
      deriveRunId({ attempt: 2, parent: 'abc' }),
    );
  });
});

describe('createFlushableDebounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // The CLI transcript sync re-schedules from inside its own callback (its
  // trace flush writes to the store, which fires the change subscription
  // synchronously). An implementation that invokes and then cancels drops that
  // reschedule and leaves `pending` stuck true, freezing every later sync.
  it('keeps a reschedule made from inside the callback', () => {
    const inner = vi.fn();
    let rescheduleOnce = true;
    const batcher: FlushableDebounce = createFlushableDebounce(() => {
      inner();
      if (!rescheduleOnce) return;
      rescheduleOnce = false;
      batcher.schedule();
    }, 100);

    batcher.schedule();
    vi.advanceTimersByTime(100);
    expect(inner).toHaveBeenCalledOnce();
    expect(batcher.pending).toBe(true);

    vi.advanceTimersByTime(100);
    expect(inner).toHaveBeenCalledTimes(2);
    expect(batcher.pending).toBe(false);
  });
});
