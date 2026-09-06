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

/**
 * Whether a runtime is installed. An entry that may or may not be the first
 * one asks here instead of keeping a latch of its own: a boolean beside the
 * install drifts from the fact the moment a dispose or a raced install lands
 * between the two.
 */
export function hasProcessRuntime(): boolean {
  return processRuntime !== null;
}

/**
 * Forget the installed runtime, so `effectRuntime()` throws "not initialized"
 * rather than handing out a disposed one. Called by `disposeProcessRuntime`
 * as its first step, before the disposal it cannot take back.
 */
export function clearProcessRuntime(): void {
  processRuntime = null;
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
