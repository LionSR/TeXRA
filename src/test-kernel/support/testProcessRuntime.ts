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
 * Two writers, in the order the harness runs them: `installFakeHost` builds
 * the bare runtime over the fake host's process services, and
 * `sessionGraphTestSetup` replaces it with the session graph family when the
 * suite that imported it needs one — the same order, and the same last
 * install wins, that the production slot gave them. `installFakeHost`
 * imports this module dynamically, for the same reason it imports the
 * platform modules that way: a suite that calls `vi.resetModules()` gets
 * fresh module instances, and the install has to land in the instance the
 * code under test will import next.
 */
import { Context, Effect, References } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { SessionOwner } from '@platform/processRuntime';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { OpenOptions, Session, Sessions } from '@texra-ai/harness';

let runtime: ProcessRuntime | undefined;
let installedSessions: Effect.Effect<Sessions['Service']> | undefined;

/** Install the harness's runtime, and the sessions it serves when it holds
 *  the session graph (`installTestSessionGraph`). */
export function initTestProcessRuntime(
  instance: ProcessRuntime,
  sessions?: Effect.Effect<Sessions['Service']>,
): void {
  runtime = instance;
  installedSessions = sessions;
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

/** The installed runtime's session owner, as a composition root reads it
 *  from its runtime's context; the bare runtime's dies on every member. */
export const testSessionOwner: Effect.Effect<SessionOwner['Service']> =
  Effect.suspend(() =>
    Effect.map(testRuntime().contextEffect, Context.get(SessionOwner)),
  );

/** The sessions the harness's session graph serves. */
export const testSessions: Effect.Effect<Sessions['Service']> = Effect.suspend(
  () =>
    installedSessions ??
    Effect.die(new Error('No test session graph is installed.')),
);

/** `handle`'s session as every host drives it (`Session`), over the store
 *  `handle` holds; the root is open, so the open answers at once. */
export function testSessionOf(
  handle: SessionHandle,
  options: OpenOptions = {},
): Session {
  return Effect.runSync(
    Effect.flatMap(testSessions, (installed) =>
      installed.open(handle.roots, options),
    ).pipe(Effect.provideService(References.PreventSchedulerYield, true)),
  );
}
