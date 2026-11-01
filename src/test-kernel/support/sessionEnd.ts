/**
 * How a test opens and ends sessions through the installed runtime's
 * `SessionOwner`, as a composition root does through its own: a session, or
 * the file's default session, which this
 * module holds as a host's root holds the one it opened. Side-effect free,
 * unlike the default-session setup, so any suite can import it.
 */

import { Effect, Context } from 'effect';

import type { SessionHandleInit } from '@agent/runtime/SessionHandle';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { SessionRoots } from '@platform/rootedFs';
import type { SessionCloseReport } from '@shared/schemas';
import type { SessionOpenError } from '@shared/session/database';

import { testSessionOwner } from './testProcessRuntime';

/** The file's default session, while one is open: the session over the
 *  process roots, as a host's root holds the one it opened. */
let defaultSession: Context.Context<SessionServices> | undefined;

/** Open the session of `init`'s root through the installed owner. */
export const openTestSession = (
  init: SessionHandleInit,
): Effect.Effect<Context.Context<SessionServices>, SessionOpenError> =>
  Effect.flatMap(testSessionOwner, (owner) => owner.open(init));

/** Close the session of a storage root through the installed owner; the
 *  file's default session, when it is that root's, goes with it. */
export const closeTestSession = (
  root: string,
): Effect.Effect<SessionCloseReport> =>
  Effect.flatMap(testSessionOwner, (owner) => {
    if (
      defaultSession !== undefined &&
      Context.get(defaultSession, SessionRoots).storage === root
    )
      defaultSession = undefined;
    return owner.close(root);
  });

/** Close a session through the one close every session takes, for a test
 *  that ends a session it opened. */
export function closeSessionOf(
  session: Context.Context<SessionServices>,
): Effect.Effect<void> {
  return Effect.asVoid(
    closeTestSession(Context.get(session, SessionRoots).storage),
  );
}

/** Open the file's default session: the test kernel's stand-in for a host
 *  opening its window's session. */
export const openTestDefaultSession = (
  init: SessionHandleInit,
): Effect.Effect<Context.Context<SessionServices>, SessionOpenError> =>
  openTestSession(init).pipe(
    Effect.tap((session) =>
      Effect.sync(() => {
        defaultSession = session;
      }),
    ),
  );

/** The file's default session, or `undefined` when none is open. */
export function tryTestDefaultSession():
  Context.Context<SessionServices> | undefined {
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
