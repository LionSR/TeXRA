/**
 * The process's Effect runtime (PRD one-fold-three-renderers, 7.7): one
 * `ManagedRuntime` per process, made at the composition root beside
 * `initPlatform()` and disposed on the existing shutdown path. `runPromise`,
 * `runFork`, and `runSync` appear at the entries and at the outermost
 * Promise-facing methods; inside, cancellation is fiber interruption.
 * Installed like the process roots: exactly once, by the entry.
 */
import type { ManagedRuntime } from 'effect';

export type ProcessRuntime = ManagedRuntime.ManagedRuntime<never, never>;

let processRuntime: ProcessRuntime | null = null;

/** Install the process runtime. Called by a composition root exactly once at
 *  startup, right beside `initPlatform()`. */
export function initProcessRuntime(runtime: ProcessRuntime): void {
  processRuntime = runtime;
}

/** The process runtime, for the Promise-facing boundaries that run fibers. */
export function effectRuntime(): ProcessRuntime {
  if (!processRuntime) {
    throw new Error(
      'Process runtime not initialized: call initProcessRuntime() before running Effect code.',
    );
  }
  return processRuntime;
}
