/**
 * The kernel harness's process runtime, held where the harness composes it.
 *
 * Production has no process-runtime slot: each composition root holds its
 * `ManagedRuntime` in a local and threads it to the surfaces that run on it
 * (rulings ledger, #12720). The harness is a composition root too — it
 * installs a fake host before every test and builds one bare runtime over
 * that host's process services — but its "entry" is spread across a setup
 * file, a `beforeEach` and whichever suite runs next, so its local lives
 * here rather than in a closure none of the three share.
 *
 * `installFakeHost` is the one writer. It imports this module dynamically,
 * for the same reason it imports the platform modules that way: a suite that
 * calls `vi.resetModules()` gets fresh module instances, and the install has
 * to land in the instance the code under test will import next.
 */
import type { ProcessRuntime } from '@platform/processRuntime';

let runtime: ProcessRuntime | undefined;

/** Install the harness's runtime. Called by `installFakeHost` only. */
export function initTestProcessRuntime(instance: ProcessRuntime): void {
  runtime = instance;
}

/** The harness's runtime, or `undefined` — the non-throwing read, which
 *  `installFakeHost` uses to keep the first install of a module instance. */
export function tryTestProcessRuntime(): ProcessRuntime | undefined {
  return runtime;
}

/** The harness's runtime, for a suite that runs a program on the fake host's
 *  process services. */
export function testRuntime(): ProcessRuntime {
  if (!runtime) {
    throw new Error(
      'No test process runtime is installed: the harness builds one with the first fake host.',
    );
  }
  return runtime;
}
