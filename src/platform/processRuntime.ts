/**
 * The process's Effect runtime (PRD one-fold-three-renderers, 7.7): one
 * `ManagedRuntime` per process, made at the composition root beside
 * `initPlatform()` and disposed on the existing shutdown path. `runPromise`,
 * `runFork`, and `runSync` appear at the entries and at the outermost
 * Promise-facing methods; inside, cancellation is fiber interruption.
 * Installed like the process roots: exactly once, by the entry.
 */
import type { ManagedRuntime } from 'effect';
import type { HttpClient } from 'effect/unstable/http';

export type ProcessRuntime = ManagedRuntime.ManagedRuntime<
  HttpClient.HttpClient,
  never
>;

let processRuntime: ProcessRuntime | null = null;

/** Install the process runtime. Called by a composition root exactly once at
 *  startup, right beside `initPlatform()`. */
export function initProcessRuntime(runtime: ProcessRuntime): void {
  processRuntime = runtime;
}

/**
 * The installed runtime, or `null` — the non-throwing read, like
 * `tryPlatform()` beside `platform()`. An entry that may or may not be the
 * first one, and a shutdown that may or may not be the first one, ask here
 * instead of keeping a latch of their own: a boolean beside the install
 * drifts from the fact the moment a dispose or a raced install lands between
 * the two.
 */
export function tryProcessRuntime(): ProcessRuntime | null {
  return processRuntime;
}

/**
 * Forget `runtime`, but only while it is still the installed one. Called by
 * `disposeProcessRuntime` AFTER its disposal, never before: the layer
 * finalizers unwinding inside `dispose()` still publish through
 * `effectRuntime()`, and a runtime installed to replace this one while it was
 * unwinding must survive the clear that ends its predecessor.
 */
export function clearProcessRuntime(runtime: ProcessRuntime): void {
  if (processRuntime === runtime) processRuntime = null;
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
