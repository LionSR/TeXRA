/** Who owns a storage root's session in this process: one session per root
 *  in a composition (`SessionOwner`), one composition per root in the
 *  process (`holdProcessRoot`). */
import { Context, Effect, Path, type Scope } from 'effect';
import type { SessionCloseReport } from '@shared/schemas';
import {
  DatabaseOpenFailed,
  type SessionOpenError,
} from '@shared/session/database';

import type { SessionHandle, SessionHandleInit } from './SessionHandle';

/**
 * The budget one session close spends waiting for its runs to end before it
 * ends the ones still live itself (`SessionOwner.close`). A hung run must
 * not wedge desktop quit, eat the extension's ~5s deactivate budget, or
 * stall a CLI SIGTERM indefinitely. The closes of a process's sessions start
 * together, so they finish under one deadline for the process, not one each.
 */
export const SESSION_CLOSE_DEADLINE_MS = 5_000;

/**
 * The process's session owner: one session per workspace storage root,
 * served by `processLayer` over the `LayerMap` that owns every session's
 * lifetime. Every opener reaches it
 * from context: the hosts' default sessions, the desktop's projects, the
 * service's tasks and the SDK's `Sessions`.
 *
 * A handle `open` returns is borrowed access: holding it carries no
 * disposal obligation; `close` is how a session ends, and the process
 * layer's own release closes whatever is still open.
 */
export class SessionOwner extends Context.Service<
  SessionOwner,
  {
    /** The session of `init.roots`' storage root: the one already open there,
     *  or built now over what `init` supplies. What `init` supplies beyond
     *  the roots is read only when the root's session is built: a later
     *  opener of the same root gets the session the first opener built. */
    readonly open: (
      init: SessionHandleInit,
    ) => Effect.Effect<SessionHandle, SessionOpenError>;
    /** Every session the owner holds, waiting within the close budget. */
    readonly list: Effect.Effect<readonly SessionHandle[]>;
    /** Whether it still holds `session`: its own root's entry, never another's. */
    readonly holds: (session: SessionHandle) => Effect.Effect<boolean>;
    /** Close the session of a storage root: refuse new runs, interrupt the
     *  ones it owns and wait for them inside {@link SESSION_CLOSE_DEADLINE_MS},
     *  end the ones still live, flush, release. A root with no open
     *  session reports `settled`. Never touches another root's session. */
    readonly close: (root: string) => Effect.Effect<SessionCloseReport>;
    /** A process shutdown's close: drain what the plugins' pollers admitted,
     *  then close every held session at once, under one deadline. */
    readonly closeAll: Effect.Effect<readonly SessionCloseReport[]>;
  }
>()('@texra-ai/harness/SessionOwner') {}

/** A root's holder (one composition) and how many of its sessions hold it. */
type RootHold = { readonly holder: object; count: number };
const PROCESS_ROOTS = Symbol.for('@texra-ai/harness/processRoots');
const openRoots = (): Map<string, RootHold> => {
  // cast: globalThis carries this one well-known symbol key, set only here.
  const process = globalThis as { [PROCESS_ROOTS]?: Map<string, RootHold> };
  // On globalThis: one per PROCESS, not per copy of this module (an app
  // bundle beside an SDK consumer or a jiti-loaded plugin each load one).
  return (process[PROCESS_ROOTS] ??= new Map());
};

/**
 * The process's one guard on a root's owner: a composition (one
 * `processLayer` build, so one `Sessions.layer` build) holds a root, for the
 * scope of one of its sessions, only if no other composition in this process
 * holds it, since both would own its runs under one process identity. The
 * root is keyed by its resolved path, so a trailing slash or a `..` names the
 * same root. A refusal is the open's failure.
 */
export const holdProcessRoot = Effect.fn('sessionOwner.holdProcessRoot')(
  function* (
    root: string,
    holder: object,
  ): Effect.fn.Return<void, DatabaseOpenFailed, Path.Path | Scope.Scope> {
    // Resolved without I/O: a session opens synchronously (`runSync`).
    const canonical = (yield* Path.Path).resolve(root);
    const take = Effect.suspend(() => {
      const held = openRoots().get(canonical);
      if (held === undefined) openRoots().set(canonical, { holder, count: 1 });
      else if (held.holder === holder) held.count += 1;
      else
        return Effect.fail(
          new DatabaseOpenFailed({
            path: root,
            cause: new Error(
              `The session at ${root} is already open in this process; share that session instead of opening it from a second composition (Sessions.layer build).`,
            ),
          }),
        );
      return Effect.void;
    });
    // Counted, so a reopen racing a close of the same root keeps its hold.
    yield* Effect.acquireRelease(take, () =>
      Effect.sync(() => {
        const held = openRoots().get(canonical);
        if (held !== undefined && --held.count === 0)
          openRoots().delete(canonical);
      }),
    );
  },
);
