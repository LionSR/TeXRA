/**
 * The session owner port: how `src/agent` opens and closes sessions through
 * the process's one session owner (PRD one-fold-three-renderers, 7.2, 7.3,
 * 7.7) without importing it. The owner is the `Sessions` map in
 * `src/controllers/session/sessionLayer.ts`, keyed by workspace storage
 * root: it builds each root's Effect graph and the `SessionHandle` over it
 * on the one `ManagedRuntime` the process makes at its entry
 * (`installProcessRuntime`), which installs the owner here beside
 * `initPlatform()`, exactly as it installs the process roots. `src/agent`
 * never imports `src/controllers`, so the owner arrives through this port
 * rather than by import; the runtime itself is reached through
 * `effectRuntime()` (`@platform/processRuntime`).
 */

import {
  Effect,
  type Context,
  type Stream,
  type SubscriptionRef,
} from 'effect';
import {
  processWorkspaceRoots,
  tryProcessWorkspaceRoots,
  type WorkspaceRoots,
} from '@platform/workspaceRoots';
import type {
  CommitOrdinal,
  LocalRuntimeState,
  SessionCloseReport,
  SessionEvent,
  TranscriptSubscription,
} from '@shared/schemas';
import type { RequestError } from '@shared/session/requestErrors';
import type { Outcome, RuntimeRequest } from '@shared/session/runtimeRequest';
import type { SessionView } from '@shared/session/sessionView';
import type { SessionEventsShape } from '@shared/session/sessionEvents';
import type { SessionInputs } from '@shared/session/sessionInputs';
import type { SessionHandle, SessionHandleInit } from './SessionHandle';

/** What a session holds of its graph, resolved once at construction. */
export interface SessionGraph {
  /** The plane's reads. Publishing is the session's alone (`publish`
   *  below), so nothing holding a session can append past its bookkeeping. */
  readonly events: Omit<SessionEventsShape, 'publish'>;
  readonly publish: SessionEventsShape['publish'];
  /** The one session state every renderer reads: the fold fiber's level. */
  readonly view: SubscriptionRef.SubscriptionRef<SessionView>;
  /** `view` as a level stream (PRD 7.2): ends as the fold does, with its
   *  defect when the fold died, so a reader waiting on a view never hangs. */
  readonly viewChanges: Stream.Stream<SessionView>;
  /** The plane's tail as `view` has folded it (PRD 7.2): every row above
   *  `fromCommit`, released once the view holds the state that folded it,
   *  for a reader that reads the view beside each row. */
  readonly folded: (fromCommit: CommitOrdinal) => Stream.Stream<SessionEvent>;
  /** This process's local truth; the status machine writes `unreadable`. */
  readonly local: SubscriptionRef.SubscriptionRef<LocalRuntimeState>;
  /** Ordered fold inputs: complete replay, then events before live text. */
  readonly inputs: Context.Service.Shape<typeof SessionInputs>['read'];
  /** The transcript subscription set, one set per port (PRD 7.2). */
  readonly subscriptions: {
    readonly set: (
      port: string,
      set: readonly TranscriptSubscription[],
    ) => Effect.Effect<void>;
  };
  /** The one handler of every request a surface issues to this session
   *  (PRD 7.6, 8.2): answered exactly once, an outcome or a request error. */
  readonly requests: {
    readonly request: (
      req: RuntimeRequest,
    ) => Effect.Effect<Outcome, RequestError>;
  };
  /** The session's current commit ordinal: where a reader attaching now
   *  starts its `all` read (PRD 10.3). */
  readonly now: () => CommitOrdinal;
  /** Release the session from its owner: the owner unwinds the session and
   *  frees the root's graph after it. */
  readonly close: () => void;
}

/** What opening a session supplies, with its roots resolved. */
export type SessionOpen = SessionHandleInit & {
  readonly roots: WorkspaceRoots;
};

/** The process's session owner, as `installProcessRuntime` installs it. */
export interface SessionOwner {
  /** The hosts' synchronous face of {@link SessionOwner.open}: the
   *  extension, the desktop, and the CLI still open from Promise-native
   *  code. It is scheduled for deletion when those lanes convert, and no
   *  new caller may take it. */
  openSync(open: SessionOpen): SessionHandle;
  /** The session of `open.roots`' storage root: the one already open there,
   *  or built now over what `open` supplies. The root's entry is registered
   *  with the owner before this Effect's first yield, so a close issued
   *  after it finds the session and waits for its build. */
  open(open: SessionOpen): Effect.Effect<SessionHandle>;
  /** The session open on a storage root, if one is; never builds one. */
  current(root: string): SessionHandle | undefined;
  /** Every session the owner holds, in no particular order. */
  list(): Effect.Effect<readonly SessionHandle[]>;
  /** Close the session of a storage root, settling what it owns inside
   *  `signal`'s budget, or the runtime's own when the caller passes none. */
  close(root: string, signal?: AbortSignal): Effect.Effect<SessionCloseReport>;
}

let owner: SessionOwner | undefined;

/** Install the process's session owner, or uninstall it with `undefined`.
 *  Called by `installProcessRuntime` exactly once at startup, right beside
 *  `initPlatform()`, and by `disposeProcessRuntime` in the shutdown step
 *  that disposes the runtime the owner runs on: from then on a close
 *  answers as a process with no owner does, instead of reaching a disposed
 *  runtime. */
export function initSessionOwner(sessions: SessionOwner | undefined): void {
  owner = sessions;
}

/**
 * Whether this process holds a session owner: false before the first
 * `installProcessRuntime` and again once `disposeProcessRuntime` has
 * uninstalled it. This, not the platform, is what says a process is
 * composed: `initPlatform` has no inverse and holds for the life of the
 * process, while the owner and the runtime under it end with the
 * composition that installed them, so a composition root asks here whether
 * it must install its own.
 */
export function sessionOwnerInstalled(): boolean {
  return owner !== undefined;
}

function sessions(): SessionOwner {
  if (!owner) {
    throw new Error(
      'Sessions not initialized: call installProcessRuntime() before opening a session.',
    );
  }
  return owner;
}

/**
 * Open the session of `init`'s workspace root, or return the one already
 * open there: one session per storage root in a process. Process roots
 * unless the opener names a folder: the extension, the CLI, and the SDK
 * open exactly one session over the process roots; the desktop opens one
 * session per paper and passes that paper's roots. What `init` supplies
 * beyond the roots (the transcript store, the sidecar store, the response
 * text policy) is read only when the root's session is built: a later
 * opener of the same root gets the session the first opener built.
 *
 * The returned handle is borrowed access to an owner-held session
 * (PR #11893, agent SDK architecture proposal, section 3): holding it
 * carries no disposal obligation, and {@link closeSession} is how the
 * session ends.
 */
export function openSession(init: SessionHandleInit): SessionHandle {
  return sessions().openSync(resolveRoots(init));
}

/** {@link openSession} for a caller that already speaks Effect: the same
 *  one-session-per-root open, on the caller's own fiber. */
export function openSessionEffect(
  init: SessionHandleInit,
): Effect.Effect<SessionHandle> {
  return Effect.suspend(() => sessions().open(resolveRoots(init)));
}

/**
 * Every session the process's owner holds. A process with no owner
 * installed has opened none and holds none, which is what this reports.
 */
export function listSessions(): Effect.Effect<readonly SessionHandle[]> {
  return Effect.suspend(() => owner?.list() ?? Effect.succeed([]));
}

function resolveRoots(init: SessionHandleInit): SessionOpen {
  return { ...init, roots: init.roots ?? processWorkspaceRoots() };
}

/**
 * The session open on the process roots' storage root, if one is: the
 * hosts' default session, read through its owner on every call rather than
 * from a cached reference, so a root closed through the owner has no
 * default session until one is opened again. No owner, or no process
 * roots yet, no session.
 */
export function defaultRootSession(): SessionHandle | undefined {
  const roots = tryProcessWorkspaceRoots();
  return roots && owner?.current(roots.storage);
}

/**
 * Close the session of a storage root (PR #11893, agent SDK architecture
 * proposal, section 9): refuse new executions on it, interrupt the ones it
 * owns and wait for them to settle within `signal`'s budget (the caller's
 * shutdown phase) or, without one, the process's shutdown-phase budget,
 * flush its artifacts, and release it from its owner. A root with no open
 * session has nothing to close and reports `settled`; so does a process
 * with no owner installed, where no session was ever opened or the owner
 * has gone with its runtime. A session whose executions
 * outlive the budget is reported `abandoned` and stays open, refusing new
 * work, until they end; it is released then, never before. This never
 * touches the process lifecycle or another root's session.
 */
export function closeSession(
  root: string,
  signal?: AbortSignal,
): Effect.Effect<SessionCloseReport> {
  return Effect.suspend(() =>
    owner
      ? owner.close(root, signal)
      : Effect.succeed({ settled: true, abandoned: [] }),
  );
}
