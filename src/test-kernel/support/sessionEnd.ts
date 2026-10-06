/**
 * How a test opens and ends sessions through the installed runtime's
 * `SessionOwner`, as a composition root does through its own: a session, a
 * run's handle registration, or the file's default session, which this
 * module holds as a host's root holds the one it opened. Side-effect free,
 * unlike the default-session setup, so any suite can import it.
 */

import { Effect } from 'effect';

import type { RunRegistry } from '@agent/runtime/runRegistry';
import type {
  SessionHandle,
  SessionHandleInit,
} from '@agent/runtime/SessionHandle';
import type { RunId, SessionCloseReport } from '@shared/schemas';
import type { SessionOpenError } from '@shared/session/database';

import { testSessionOwner } from './testProcessRuntime';

/** The file's default session, while one is open: the session over the
 *  process roots, as a host's root holds the one it opened. */
let defaultSession: SessionHandle | undefined;

/** End a tracked run's handle registration the way its lifecycle does at
 *  its terminal, for a test that stands in for that lifecycle. */
export function untrackRun(runs: RunRegistry, runId: RunId): void {
  const handle = runs.getHandle(runId);
  if (handle) runs.untrackIfCurrent(handle);
}

/** Open the session of `init`'s root through the installed owner. */
export const openTestSession = (
  init: SessionHandleInit,
): Effect.Effect<SessionHandle, SessionOpenError> =>
  Effect.flatMap(testSessionOwner, (owner) => owner.open(init));

/** Close the session of a storage root through the installed owner; the
 *  file's default session, when it is that root's, goes with it. */
export const closeTestSession = (
  root: string,
): Effect.Effect<SessionCloseReport> =>
  Effect.flatMap(testSessionOwner, (owner) => {
    if (defaultSession?.roots.storage === root) defaultSession = undefined;
    return owner.close(root);
  });

/** Every session the installed owner holds. */
export const listTestSessions: Effect.Effect<readonly SessionHandle[]> =
  Effect.flatMap(testSessionOwner, (owner) => owner.list);

/** Close every session the installed owner holds, as a host's shutdown does. */
export const closeAllTestSessions: Effect.Effect<
  readonly SessionCloseReport[]
> = Effect.flatMap(testSessionOwner, (owner) => owner.closeAll);

/** Close a session through the one close every session takes, for a test
 *  that ends a session it opened. */
export function closeSessionOf(session: SessionHandle): Effect.Effect<void> {
  return Effect.asVoid(closeTestSession(session.roots.storage));
}

/** Open the file's default session: the test kernel's stand-in for a host
 *  opening its window's session. */
export const openTestDefaultSession = (
  init: SessionHandleInit,
): Effect.Effect<SessionHandle, SessionOpenError> =>
  openTestSession(init).pipe(
    Effect.tap((session) =>
      Effect.sync(() => {
        defaultSession = session;
      }),
    ),
  );

/** The file's default session, or `undefined` when none is open. */
export function tryTestDefaultSession(): SessionHandle | undefined {
  return defaultSession;
}

/** Close the file's default session; nothing to do when none is open. */
export const closeTestDefaultSession: Effect.Effect<void> = Effect.suspend(
  () => {
    const session = defaultSession;
    defaultSession = undefined;
    return session === undefined ? Effect.void : closeSessionOf(session);
  },
);
