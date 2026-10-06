/**
 * What a session holds of its graph ({@link SessionGraph}), and the process's
 * session owner ({@link SessionOwner}) as the tag `src/agent` and the hosts
 * reach it by. The owner is served by `processLayer` in
 * `packages/harness/src/controllers/session/sessionLayer.ts`, keyed by
 * workspace storage root; `src/agent` never imports `src/controllers`, so
 * the tag lives here. A `SessionHandle` holds no runtime at all: its
 * Effects run on the fibers of whoever calls them.
 */

import {
  Context,
  type Effect,
  type Stream,
  type SubscriptionRef,
} from 'effect';
import type {
  AggregateId,
  CommitOrdinal,
  RunId,
  LocalRuntimeState,
  SessionCloseReport,
  DisplaySessionEvent,
  SessionEvent,
  SessionEventDraft,
  TranscriptSubscription,
} from '@shared/schemas';
import type {
  AggregateClaim,
  DatabaseNotOwner,
  DatabaseReadFailed,
  DatabaseWriteFailed,
  SessionOpenError,
  SessionStoreMovedAside,
} from '@shared/session/database';
import type { SessionView } from '@shared/session/sessionView';
import type { RunHistory } from '@shared/session/runHistory';
import type {
  SessionEventReads,
  SessionEventsShape,
} from '@shared/session/sessionEvents';
import type { SessionInputs } from '@shared/session/sessionInputs';
import type { SessionRequests } from './runApprovalQueue';
import type { Runs } from './runRegistry';
import type { SessionHandle, SessionHandleInit } from './SessionHandle';

/** What a session holds of its graph, resolved once at construction. */
export interface SessionGraph {
  /** The plane's reads. Publishing is the session's alone (the four doors
   *  below), so nothing holding a session can append past its bookkeeping. */
  readonly events: SessionEventReads;
  /** Append one batch in publication order and return once the view has
   *  folded it: what a caller that reads the view next awaits. */
  readonly publish: SessionEventsShape['publish'];
  /** `publish`, owning the claims of the runs it registers: a birth's as it
   *  commits, a re-registration's taken over before it. */
  readonly publishRegistration: (
    events: readonly SessionEventDraft[],
  ) => Effect.Effect<
    readonly SessionEvent[],
    DatabaseNotOwner | DatabaseReadFailed | DatabaseWriteFailed
  >;
  /** A read of committed rows and the append that depends on it, as one
   *  job of the publisher, settled like `publish`. */
  readonly exclusive: SessionEventsShape['exclusive'];
  /** Enqueue a job in publication order and return: the door for a
   *  producer with no fiber of its own to wait on. */
  readonly detach: SessionEventsShape['detach'];
  /** Every detached job enqueued before this call has run and the view has
   *  folded what they committed. A barrier, never a reporter: a refused job
   *  belongs to whoever enqueued it. */
  readonly settle: Effect.Effect<void>;
  /** The run history over this root's event plane: the run loop's one
   *  writer of run rows, provided to each run's program from here. */
  readonly runHistory: Context.Service.Shape<typeof RunHistory>;
  /** A hold on one aggregate's claim, answered with its release. Holds are
   *  counted: the last one to go returns the claim to how the first found
   *  it, or releases it when any hold `ends` it — a run's driver, a
   *  workflow checkpoint's invocation. */
  readonly acquireClaims: (
    id: AggregateId,
    ends: boolean,
  ) => Effect.Effect<
    Effect.Effect<void>,
    DatabaseNotOwner | DatabaseReadFailed | DatabaseWriteFailed
  >;
  readonly runRecords: (
    id: RunId,
  ) => Effect.Effect<readonly SessionEvent[], DatabaseReadFailed>;
  /** Whether this process holds an existing, open run in the database. */
  readonly ownsRun: (id: RunId) => Effect.Effect<boolean, DatabaseReadFailed>;
  /** Who holds one run right now, with its owner's liveness proved in the
   *  call: the ownership read a resume gate and the run listing ask, so a
   *  run outside the live view is never reported held by a dead owner. */
  readonly claimOwner: (
    id: RunId,
  ) => Effect.Effect<AggregateClaim, DatabaseReadFailed>;
  /** Every committed row of one aggregate, run-history-private rows included:
   *  the read behind the keyed private records, which fold over the
   *  whole aggregate rather than the latest of a type.
   *  With `types`, only those rows, through the type index. */
  readonly aggregateRows: (
    id: AggregateId,
    types?: readonly SessionEvent['type'][],
  ) => Effect.Effect<readonly SessionEvent[], DatabaseReadFailed>;
  /** One aggregate's display rows, with the `usage` rows its priced
   *  responses project: what a renderer or an export replays. */
  readonly displayRows: (
    id: AggregateId,
  ) => Effect.Effect<readonly DisplaySessionEvent[], DatabaseReadFailed>;
  /** Transient text shares the existing session-input source, never the event table. */
  readonly publishText: (
    runId: RunId,
    id: string,
    text: string,
  ) => Effect.Effect<void>;
  readonly readText: (runId: RunId, id: string) => string | undefined;
  /** The one session state every renderer reads: the fold fiber's level. */
  readonly view: SubscriptionRef.SubscriptionRef<SessionView>;
  /** `view` as a level stream (PRD 7.2): ends as the fold does, with its
   *  defect when the fold died, so a reader waiting on a view never hangs. */
  readonly viewChanges: Stream.Stream<SessionView>;
  /** The store this graph opened held an older build's rows and moved them
   *  aside (`Database.movedAside`): the one fact a host tells the user. */
  readonly storeMovedAside: SessionStoreMovedAside | null;
  /** The plane's tail as `view` has folded it (PRD 7.2): every row above
   *  `fromCommit`, released once the view holds the state that folded it,
   *  and local reconciliation has completed, for a reader that queries the
   *  resulting state beside each row. */
  readonly folded: (
    fromCommit: CommitOrdinal,
  ) => Stream.Stream<SessionEvent, DatabaseReadFailed>;
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
  /** The session's runs (`Runs`): built by the session layer over the
   *  session's doors, disposed when the session's scope closes. */
  readonly runs: Context.Service.Shape<typeof Runs>;
  /** The session's requests: its approval state and the one handler of
   *  every request a surface issues to it (PRD 7.6, 8.2), built by the
   *  session layer over this graph. */
  readonly requests: SessionRequests;
  /** The session's current commit ordinal: where a reader attaching now
   *  starts its `all` read (PRD 10.3). */
  readonly now: () => CommitOrdinal;
}

/**
 * The process's session owner: one session per workspace storage root,
 * served by `processLayer` (`@controllers/session/sessionLayer`) over the
 * `LayerMap` that owns every session's lifetime. Every opener reaches it
 * from context: the hosts' default sessions, the desktop's projects, the
 * service's tasks and the SDK's `Sessions`.
 *
 * A handle `open` returns is borrowed access (PR #11893, agent SDK
 * architecture proposal, section 3): holding it carries no disposal
 * obligation; `close` is how a session ends, and the process layer's own
 * release closes whatever is still open.
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
    /** Every session the owner holds, entries still building waited for
     *  within the close budget. */
    readonly list: Effect.Effect<readonly SessionHandle[]>;
    /**
     * Close the session of a storage root: refuse new runs, interrupt the
     * ones it owns and wait for them inside {@link SESSION_CLOSE_DEADLINE_MS},
     * settle the ones still live, flush, release. A root with no open
     * session reports `settled`. Never touches another root's session.
     */
    readonly close: (root: string) => Effect.Effect<SessionCloseReport>;
    /** A process shutdown's close: drain what the plugins' pollers admitted,
     *  then close every held session at once, under one deadline. */
    readonly closeAll: Effect.Effect<readonly SessionCloseReport[]>;
  }
>()('@texra-ai/harness/SessionOwner') {}

/**
 * The budget one session close spends waiting for its runs to settle before
 * it settles the ones still live itself (`SessionOwner.close`). A hung run
 * must not wedge desktop quit, eat the extension's ~5s deactivate budget, or
 * stall a CLI SIGTERM indefinitely. The closes of a process's sessions start
 * together, so they settle under one deadline for the process, not one each.
 */
export const SESSION_CLOSE_DEADLINE_MS = 5_000;
