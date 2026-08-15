// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - desktop
import { createDesktopDiffHostDisposeQueue } from '@desktop/main/desktopDiffHostDispose';
// Local imports - test support
import { createDeferred } from '@test/support/asyncTestUtils';

// The actual `window.once('closed', ...)` wiring in
// `packages/desktop/src/main/index.ts` is not exercised here: this suite does
// not instantiate Electron BrowserWindows. These cases cover the queue
// behavior that wiring delegates to, including the start-immediately ordering
// fix from #10492.
describe('createDesktopDiffHostDisposeQueue', () => {
  it('starts each dispose immediately while ordering completion on the previous window', async () => {
    const enqueue = createDesktopDiffHostDisposeQueue();
    const reportAsyncError = vi.fn();

    const firstStarted = createDeferred<void>();
    const firstFinished = createDeferred<void>();
    const firstDispose = vi.fn(async () => {
      firstStarted.resolve();
      await firstFinished.promise;
    });
    const secondDispose = vi.fn(async () => {});

    const first = enqueue(firstDispose, reportAsyncError);
    await firstStarted.promise;

    const second = enqueue(secondDispose, reportAsyncError);
    // The second disposal call must already have run even though the first
    // cleanup is still pending; deferring it would keep its `disposed` flag
    // false and reopen the mid-fallback race.
    expect(secondDispose).toHaveBeenCalledOnce();

    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    firstFinished.resolve();
    await first;
    await second;
    expect(secondSettled).toBe(true);
    expect(reportAsyncError).not.toHaveBeenCalled();
  });

  it('does not let a failed disposal block the next queued completion', async () => {
    const enqueue = createDesktopDiffHostDisposeQueue();
    const reportAsyncError = vi.fn();
    const firstError = new Error('dispose failed');
    const firstDispose = vi.fn(async () => {
      throw firstError;
    });
    const secondDispose = vi.fn(async () => {});

    const first = enqueue(firstDispose, reportAsyncError);
    const second = enqueue(secondDispose, reportAsyncError);

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(secondDispose).toHaveBeenCalledOnce();
    expect(reportAsyncError).toHaveBeenCalledWith(firstError);
  });
});
