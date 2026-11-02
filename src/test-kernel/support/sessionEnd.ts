/**
 * How a test opens the file's default session and ends sessions through the
 * calling fiber's `SessionOwner`, as a composition root does through its
 * own; this module holds the default session as a host's root holds the one
 * it opened. Side-effect free, unlike the default-session setup, so any
 * suite can import it.
 */

import { Effect, Context } from 'effect';

import type { SessionHandleInit } from '@agent/runtime/SessionHandle';
import { SessionOwner, type SessionServices } from '@agent/runtime/rootLaunch';
import { SessionRoots } from '@platform/rootedFs';
import type { SessionCloseReport } from '@shared/schemas';
import type { SessionOpenError } from '@shared/session/database';

/** The file's default session, while one is open: the session over the
 *  process roots, as a host's root holds the one it opened. */
let defaultSession: Context.Context<SessionServices> | undefined;

/** Close the session of a storage root through the owner; the file's
 *  default session, when it is that root's, goes with it. */
export const closeTestSession = (
  root: string,
): Effect.Effect<SessionCloseReport, never, SessionOwner> =>
  Effect.flatMap(SessionOwner, (owner) => {
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
): Effect.Effect<void, never, SessionOwner> {
  return Effect.asVoid(
    closeTestSession(Context.get(session, SessionRoots).storage),
  );
}

/** Open the file's default session through the owner: the test kernel's
 *  stand-in for a host opening its window's session. */
export const openTestDefaultSession = (
  init: SessionHandleInit,
): Effect.Effect<
  Context.Context<SessionServices>,
  SessionOpenError,
  SessionOwner
> =>
  Effect.flatMap(SessionOwner, (owner) => owner.open(init)).pipe(
    Effect.tap((session) =>
      Effect.sync(() => {
        defaultSession = session;
      }),
    ),
  );

/** Close the file's default session; nothing to do when none is open. */
export const closeTestDefaultSession: Effect.Effect<void, never, SessionOwner> =
  Effect.suspend(() => {
    const session = defaultSession;
    defaultSession = undefined;
    return session === undefined ? Effect.void : closeSessionOf(session);
  });
