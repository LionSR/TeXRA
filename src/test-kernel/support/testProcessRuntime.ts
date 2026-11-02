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
 * Two writers: `sessionGraphTestSetup` installs the session graph family
 * while the suite that imported it loads, and `installFakeHost`, which the
 * setup file runs once the suite is collected, builds the bare runtime over
 * the fake host's process services only when no runtime is installed yet.
 * `installFakeHost`
 * imports this module dynamically, for the same reason it imports the
 * platform modules that way: a suite that calls `vi.resetModules()` gets
 * fresh module instances, and the install has to land in the instance the
 * code under test will import next.
 */
import { Context, Effect, type ManagedRuntime } from 'effect';

import { SessionOwner } from '@agent/runtime/rootLaunch';
import type { Sessions } from '@texra-ai/harness';
import type { ProcessServices } from '@texra-ai/harness/host';

/** The harness's runtime: a host's, with the internal session owner a root
 *  launch the suites drive directly asks for. */
type TestProcessRuntime = ManagedRuntime.ManagedRuntime<
  ProcessServices | Sessions | SessionOwner,
  never
>;

let runtime: TestProcessRuntime | undefined;

/** Install the harness's runtime. */
export function initTestProcessRuntime(
  instance:
    | TestProcessRuntime
    | ManagedRuntime.ManagedRuntime<ProcessServices | SessionOwner, never>,
): void {
  // cast: the bare runtime serves no `Sessions`, as before it had none; a
  // suite that opens sessions installs the session graph, whose runtime does.
  runtime = instance as TestProcessRuntime;
}

/** The harness's runtime, or `undefined` — the non-throwing read, which
 *  `installFakeHost` uses to keep the first install of a module instance. */
export function tryTestProcessRuntime(): TestProcessRuntime | undefined {
  return runtime;
}

/** The harness's runtime, for a suite that runs a program on the fake host's
 *  process services. */
export function testRuntime(): TestProcessRuntime {
  if (!runtime) {
    throw new Error(
      'No test process runtime is installed: the harness builds one with the first fake host.',
    );
  }
  return runtime;
}

/** The installed runtime's session owner, as a composition root reads it
 *  from its runtime's context; the bare runtime's dies on every member. */
export const testSessionOwner: Effect.Effect<SessionOwner['Service']> =
  Effect.suspend(() =>
    Effect.map(testRuntime().contextEffect, Context.get(SessionOwner)),
  );
