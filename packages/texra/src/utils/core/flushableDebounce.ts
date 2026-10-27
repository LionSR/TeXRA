/**
 * A trailing-edge timer batcher with a synchronous flush escape hatch. The
 * library debounce this replaced exposed only `cancel()` (discard the pending
 * call), with no way to force the trailing call to run early.
 * Several call sites need exactly that: run the pending work synchronously
 * right now (typically just before teardown/dispose), instead of either
 * waiting out the timer or dropping the work.
 *
 * `schedule()` always (re)starts the timer, matching a classic trailing
 * debounce.
 *
 * The timer handle is cleared *before* the callback runs, so a `schedule()`
 * made from inside the callback opens a fresh window that this invocation's
 * own cleanup cannot cancel. Re-entrancy is not hypothetical: the CLI's
 * transcript sync flushes buffered trace chunks into the store from inside
 * its own callback, which synchronously re-schedules. A library debounce
 * that invokes and then cancels (es-toolkit's does) silently drops that
 * reschedule, freezing every later update.
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

  function invoke(): void {
    timer = undefined;
    callback();
  }

  return {
    schedule() {
      cancel();
      timer = setTimeout(invoke, waitMs);
    },
    flush() {
      if (timer === undefined) return;
      cancel();
      invoke();
    },
    cancel,
  };
}
