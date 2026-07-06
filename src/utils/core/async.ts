// Re-export debounce from perfect-debounce for consistent usage across codebase
export { debounce } from 'perfect-debounce';

// AbortSignal-aware sleep shared by extension, CLI, and webview code.
export { default as delay } from 'delay';

/**
 * A trailing-edge timer batcher with a synchronous flush escape hatch —
 * perfect-debounce's `debounce()` only exposes `cancel()` (discard the
 * pending call), with no way to force the trailing call to run early. Several
 * hand-rolled `setTimeout`/`clearTimeout` sites need exactly that: run the
 * pending work synchronously right now (typically just before teardown/
 * dispose), instead of either waiting out the timer or dropping the work.
 *
 * `schedule()` always (re)starts the timer, matching a classic trailing
 * debounce. A call site that instead wants "start once, coalesce further
 * calls until it fires" (a throttle-style batching window) can guard with
 * `pending`: `if (!batcher.pending) batcher.schedule();`.
 *
 * The callback is fixed at creation and takes no arguments — call sites that
 * need per-invocation data close over their own mutable state (as the
 * original hand-rolled versions already did) and read it when the callback
 * fires, rather than threading arguments through the timer.
 */
export interface FlushableDebounce {
  /** (Re)start the timer; invokes the callback after `waitMs` of inactivity. */
  schedule(): void;
  /**
   * If a call is pending, invoke the callback synchronously right now and
   * clear the timer. No-op when nothing is pending.
   */
  flush(): void;
  /** Clear the pending timer without invoking the callback. No-op when nothing is pending. */
  cancel(): void;
  /** True while a call is scheduled and hasn't fired, flushed, or been cancelled yet. */
  readonly pending: boolean;
}

export function createFlushableDebounce(
  callback: () => void,
  waitMs: number,
): FlushableDebounce {
  let timer: ReturnType<typeof setTimeout> | undefined;

  function cancel(): void {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  }

  function schedule(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      callback();
    }, waitMs);
  }

  function flush(): void {
    if (timer === undefined) return;
    cancel();
    callback();
  }

  return {
    schedule,
    flush,
    cancel,
    get pending() {
      return timer !== undefined;
    },
  };
}
