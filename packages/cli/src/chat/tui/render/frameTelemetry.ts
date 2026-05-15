// Ink frame timings + SIGWINCH coalescing (R13).
//
// Subscribes via ink's `onFrame` hook. Emits per-phase timings to the
// platform logger at trace level so post-launch jank is debuggable without
// re-instrumenting. Resize bursts are coalesced via a microtask gate so a
// drag along the window edge doesn't tear `<Static>` content.

import { tryPlatform } from '@platform/platform';

interface FrameSample {
  readonly renderMs: number;
  readonly diffMs: number;
  readonly writeMs: number;
  readonly yogaLayoutMs: number;
}

let resizeQueued = false;

/**
 * Coalesce a SIGWINCH callback so multiple resize events inside the same
 * microtask collapse into one. The actual resize handler (re-measure stdout,
 * trigger Ink re-render) runs once on the next microtask drain.
 */
export function coalesceResize(handler: () => void): () => void {
  return () => {
    if (resizeQueued) return;
    resizeQueued = true;
    queueMicrotask(() => {
      resizeQueued = false;
      handler();
    });
  };
}

export function logFrameSample(sample: FrameSample): void {
  const log = tryPlatform()?.log;
  if (!log) return;
  log.debug(
    'cli-tui',
    `frame render=${sample.renderMs.toFixed(2)} diff=${sample.diffMs.toFixed(2)} write=${sample.writeMs.toFixed(2)} yoga=${sample.yogaLayoutMs.toFixed(2)}`,
  );
}

/**
 * Track Date.now() between Ink's `onFrame` events. Ink doesn't break out
 * the render → diff → write → yoga phases yet; this scaffold logs the
 * total inter-frame delta so the line-by-line breakdown can land when ink
 * exposes them.
 */
export function makeFrameLogger(): (now: number) => void {
  let last = 0;
  return (now: number) => {
    if (last !== 0) {
      logFrameSample({
        renderMs: now - last,
        diffMs: 0,
        writeMs: 0,
        yogaLayoutMs: 0,
      });
    }
    last = now;
  };
}
