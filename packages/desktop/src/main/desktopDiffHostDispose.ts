// Third-party imports
import PQueue from 'p-queue';

/**
 * Builds the diff-host disposal chain used by each window's `closed` handler.
 *
 * `dispose()` is invoked immediately so a closing window flips its
 * `disposed` flag before the previous window's cleanup settles; only the
 * returned lifecycle promise is queued. `concurrency: 1` keeps the quit drain
 * ordered across macOS reopen/close cycles without re-implementing a
 * hand-rolled `.then()` chain, and the non-rejecting current promise means a
 * failed disposal never blocks the next enqueued window.
 */
export function createDesktopDiffHostDisposeQueue(): (
  dispose: () => Promise<void>,
  reportAsyncError: (error: unknown) => void,
) => Promise<void> {
  const queue = new PQueue({ concurrency: 1 });
  return (dispose, reportAsyncError) => {
    const current = dispose().catch(reportAsyncError);
    return queue.add(() => current);
  };
}
