/**
 * `SessionHandle`: one session, as the record of the owners its layer built
 * (`sessionLayer.ts`). Each member is a deep owner of one concern, and
 * callers address it directly (`session.log.transact(...)`,
 * `session.runs.stop(...)`); the record itself does no work and forwards
 * nothing.
 *
 * A session is one per workspace storage root, built and held by the
 * process's session owner (`SessionOwner`, served by `processLayer` in
 * `controllers/session/sessionLayer.ts`; `src/agent` never imports
 * `src/controllers`, so the tag lives here). Each opener keeps the handle it was given; a run-scoped
 * caller receives its session as data, never through a module singleton
 * (#7694). It has no readiness gate: a restored session is usable the
 * moment it exists, and what a run with no loop in this process is gets
 * decided by the fold's `readOnly` and `group` rules over the view.
 *
 * It is deliberately NOT a conversation API (send/stream/resume/history):
 * continuity stays in options and storage (`ValidatedRunRequest`).
 */

import type { AgentEvent } from '@agent/trace';
import type { Inbox } from '@agent/followUp/Inbox';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type {
  AggregateId,
  PermissionPayload,
  RequestDecision,
  CommitOrdinal,
  DisplaySessionEvent,
  ResumeBlocker,
  RunEnd,
  RunId,
  RunOutcome,
  SessionCloseReport,
  SessionEvent,
  SessionEventDraft,
  TranscriptSubscription,
  LocalRuntimeState,
} from '@shared/schemas';
import type {
  AggregateClaim,
  DatabaseNotOwner,
  DatabaseReadFailed,
  DatabaseWriteFailed,
  DeletionMode,
  SessionOpenError,
  SessionStoreMovedAside,
} from '@shared/session/database';
import type { RequestError } from '@shared/session/requestErrors';
import type { RunHistory } from '@shared/session/runHistory';
import type { Outcome, RuntimeRequest } from '@shared/session/runtimeRequest';
import type { RunHistoryDraft } from '@shared/session/runStateFold';
import type { Append } from '@shared/session/sessionEvents';
import type { SessionInputs } from '@shared/session/sessionInputs';
import type { RunView, SessionView } from '@shared/session/sessionView';
import type { Context, Effect, Scope, Stream, SubscriptionRef } from 'effect';

import type {
  SessionHostInteractions,
  HostInteractions,
} from './HostInteractions';
import type { HistoryQuery } from './historyQuery/HistoryQuery';
import type { SessionApprovals } from './runApprovalQueue';
import type { RunRegistry } from './runRegistry';

/** A write the store refused: nothing was written (D6 b). */
export type LogWriteError = DatabaseNotOwner | DatabaseWriteFailed;

/** A claim the store would not give this process. */
type ClaimError = DatabaseNotOwner | DatabaseReadFailed | DatabaseWriteFailed;

/** What one transaction's job holds: the ordered append, and the claim
 *  take-over a registration makes before it appends. */
export interface SessionTransaction {
  /** Append one batch; every row commits in this transaction's order. */
  readonly append: Append;
  /**
   * Take `runId`'s claim for this process (a dead owner's, proved dead
   * first, or this process's own) and leave it standing for the run's
   * driver. A claim the job took is given back if the job fails, or if what
   * it committed never reaches the view.
   */
  readonly claim: (runId: RunId) => Effect.Effect<void, ClaimError>;
}

/**
 * The session's one door to its store: ordered transactions on the
 * session's one publisher, and the reads beside them. Every awaited write of
 * a session fact is one {@link transact}; a run's own trace rows go through
 * {@link SessionHandle.trace} and its loop's rows through
 * {@link SessionHandle.runHistory}, both on the same publisher order.
 */
export interface SessionLog {
  /**
   * One transaction, run as the next job of the session's publisher and
   * returned once the view has folded what it committed: a batch of rows,
   * or a job that reads committed rows and appends what depends on them
   * with no other write between. A refusal wrote nothing and comes back
   * typed; it is never retried here.
   */
  transact(
    events: readonly SessionEventDraft[],
  ): Effect.Effect<readonly SessionEvent[], LogWriteError>;
  transact<A, E>(
    job: (tx: SessionTransaction) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | LogWriteError>;
  /** A barrier: every job enqueued before it has run and the view has
   *  folded what they committed. A refused detached row is heard by its own
   *  writer (a run's trace, at its end), never here. */
  readonly settled: Effect.Effect<void>;
  /** The current commit ordinal: where a reader attaching now starts its
   *  {@link tail}, so it sees what is published from here on. */
  now(): CommitOrdinal;
  /** Every committed row of one aggregate, private rows included; with
   *  `types`, only rows of those types, through the type index. */
  rows(
    id: AggregateId,
    types?: readonly SessionEvent['type'][],
  ): Effect.Effect<readonly SessionEvent[], DatabaseReadFailed>;
  /** A run's record rows: the latest row of each record type. */
  records(
    runId: RunId,
  ): Effect.Effect<readonly SessionEvent[], DatabaseReadFailed>;
  /** A run's display rows, its priced `usage` rows among them; empty when
   *  the run never existed or was removed. */
  display(
    runId: RunId,
  ): Effect.Effect<readonly DisplaySessionEvent[], DatabaseReadFailed>;
  /** Every display row above `fromCommit` in commit order, then the live
   *  tail. `drained` receives the commit each forward read covered. */
  tail(
    fromCommit: CommitOrdinal,
    drained?: SubscriptionRef.SubscriptionRef<CommitOrdinal>,
  ): Stream.Stream<DisplaySessionEvent, DatabaseReadFailed>;
  /** The cold listing: the latest row per aggregate and listing type, plus
   *  the outstanding approvals; completes. */
  listing(): Stream.Stream<DisplaySessionEvent, DatabaseReadFailed>;
  /**
   * Hold `runId`'s claim for the caller's scope. Holds are counted: the
   * first takes the claim (proving a prior owner dead), later ones share
   * it, and the last to go returns it to how the first found it, unless a
   * hold `ends` it (the run's driver), when it is released.
   */
  hold(
    runId: RunId,
    options?: { readonly ends?: boolean },
  ): Effect.Effect<void, ClaimError, Scope.Scope>;
  /** Whether this process holds `runId` open in the database: the durable
   *  claim, read from SQLite rather than from the lagging fold. */
  owns(runId: RunId): Effect.Effect<boolean, DatabaseReadFailed>;
  /** Who holds `runId` now, with the owner's liveness proved in the call:
   *  what a resume gate and the run listing word a refusal from. */
  owner(runId: RunId): Effect.Effect<AggregateClaim, DatabaseReadFailed>;
  /** Set when opening the store moved an older build's rows aside; the
   *  host that opened the session presents it once. */
  readonly movedAside: SessionStoreMovedAside | null;
}

/** What a resume of a run waits for, and whether one was asked for. */
interface ResumeBlock {
  readonly reason: ResumeBlocker;
  readonly retry: boolean;
}

/**
 * The session's view: the one fold every renderer reads (PRD
 * one-fold-three-renderers, 5.1), the transport replay it is folded from,
 * the transcript subscriptions that decide what it folds, and the local
 * truth it folds beside the rows.
 */
export interface SessionViewAccess {
  /** The fold fiber's level. Synchronous readers take
   *  `SubscriptionRef.getUnsafe(ref)`; nothing outside the fold writes it. */
  readonly ref: SubscriptionRef.SubscriptionRef<SessionView>;
  /** {@link ref} as a level stream, ending as the fold does: with its
   *  defect when it died, so a reader waiting on a view never hangs. */
  readonly changes: Stream.Stream<SessionView>;
  /** One run of the current view; its transcript tier is complete only
   *  while some port subscribes the run. */
  run(runId: RunId): RunView | undefined;
  /** The view folded cold from the log as of this call: the listing tier of
   *  every run and the whole history of the runs named. */
  read(runIds: readonly RunId[]): Effect.Effect<SessionView>;
  /** Ordered fold inputs for one transport subscription: complete replay,
   *  then events before live text. */
  readonly inputs: Context.Service.Shape<typeof SessionInputs>['read'];
  /** Replace one port's transcript subscription set; an empty set removes
   *  the port. The view's set is the union over every port. */
  subscribe(
    port: string,
    set: readonly TranscriptSubscription[],
  ): Effect.Effect<void>;
  /** Record what a resume of a run waits for (durable harness D5), or null
   *  when nothing blocks it any more: local truth, never a row. */
  markResumeBlocked(
    runId: RunId,
    blocked: ResumeBlock | null,
  ): Effect.Effect<void>;
  /** The runs a resume found blocked here, with what each waits for. */
  resumeBlocks(): LocalRuntimeState['resumeBlocked'];
}

/** A streaming row's closing fact, as the run history commits it. */
export type StreamClosure = Extract<RunHistoryDraft, { type: 'stream.end' }>;

/** The facts that close a run's open work: its streams, and with an
 *  outcome its stages too. */
export type ClosureFact =
  StreamClosure | Extract<SessionEventDraft, { type: 'stage.end' }>;

/**
 * Each run's trace sink: its rows in publication order, the transient text
 * of what it streams, and what it left open. A refused row is the run's own
 * to hear at its end ({@link lost}), never another writer's.
 */
export interface RunTrace {
  /** Publish one trace event as its durable arm (a chunk as transient
   *  text); its place in the order is this call. */
  publish(runId: RunId, event: AgentEvent): void;
  /** The first of `runId`'s rows the store refused, taken, as the error
   *  its `run.end` carries; read after every row before it was tried. */
  lost(runId: RunId): Effect.Effect<RunEnd['error'] | undefined>;
  /** What closes what is still open on `runId`: every stream, with its
   *  text, and with an `outcome` every stage. Read inside a job of the
   *  session's publisher, or once the log has settled. */
  closure(runId: RunId): StreamClosure[];
  closure(runId: RunId, outcome: RunOutcome): ClosureFact[];
}

/**
 * What opening a session supplies (`SessionOwner.open`): persistence mode and
 * the host's presentation. The event plane is the session's own, built per
 * workspace root, so a separately injected plane could not silently drop a
 * session's facts onto one nobody reads.
 */
export interface SessionHandleInit {
  /** The workspace this session works on: the opener is the one caller that
   *  knows which paper it opened. */
  readonly roots: WorkspaceRoots;
  /** A presentation host the session is born with, attached for its life. */
  readonly interactions?: HostInteractions;
  /**
   * The opener is a window (the TUI, desktop, the extension), which follows
   * its interrupted tasks (`followInterruptedTasks`): it resumes a task
   * whose resume was blocked once what it needs is back, and with `offer`
   * also lists at open, or under `texra.resumeOnOpen: auto` continues, the
   * tasks a closed or crashed TeXRA left interrupted. Headless runs and the
   * SDK leave it unset: their policy is off (ruling Q2).
   */
  readonly interruptedTasks?: 'offer' | 'retry';
  /** An ephemeral session opens a throwaway database instead of the
   *  project's. */
  readonly transcriptMode?:
    | { readonly kind: 'persistent' }
    | { readonly kind: 'ephemeral'; readonly reason: string };
}

/** The rows that open a request: its `request.opened`, and the
 *  `request.decided` the policy lands beside it. */
export type RequestRow = Extract<
  RunHistoryDraft,
  { type: 'request.opened' | 'request.decided' }
>;

/** How {@link SessionRequests.ask} opens its request. */
export interface AskOptions<E> {
  /**
   * How the request's rows commit, answering the commit its decision is
   * read from: a tool call's request commits through its run's history under
   * the id its attempt derives, so it outlives this process, and a
   * request a resumed call re-enters commits only what the policy decides.
   * Omitted, the session's log commits them.
   */
  readonly open?: (
    rows: readonly RequestRow[],
  ) => Effect.Effect<CommitOrdinal, E>;
  /**
   * Cleanup for what the caller staged before the request opened, run once
   * and uninterruptibly in the two cases that leave no row behind: the
   * `request.opened` append was refused, or an interruption's cancellation
   * found nothing open. A committed request always ends in a
   * `request.decided`, the release every surface follows, so it is never
   * released here.
   */
  readonly onNeverCommitted?: Effect.Effect<void>;
}

/**
 * Everything one session's requests are: the one handler of every request a
 * surface issues (PRD one-fold-three-renderers, 7.6 and 8.2), and a run's
 * questions to a person, asked and decided as rows (one run model, 3.7).
 * Built by the session layer over that session's log (`SessionRequests.ts`);
 * one value per session, so two sessions admit, serialize and answer
 * requests independently.
 */
export interface SessionRequests {
  /** Answer one request a surface issued: exactly once, an {@link Outcome}
   *  the host renders or a request error. */
  readonly request: (
    req: RuntimeRequest,
  ) => Effect.Effect<Outcome, RequestError>;
  /** Internal deletion policies share the same admission and transaction as
   *  a user's `run.delete`. */
  readonly removeRun: (
    runId: RunId,
    mode: DeletionMode,
    expectedStartCommit: CommitOrdinal,
  ) => Effect.Effect<Outcome, RequestError>;
  /**
   * Ask a person: open the request on its run and wait for its decision.
   * The one door for a request a tool raises. An interruption anywhere in
   * the call closes the request as cancelled, so no pending request is left
   * behind; a cancel for a request this call never opened writes nothing.
   */
  readonly ask: <E = never>(
    runId: RunId,
    payload: PermissionPayload,
    options?: AskOptions<E>,
  ) => Effect.Effect<RequestDecision, LogWriteError | E>;
  /**
   * Answer a request if it is still open: the one writer of a decision. The
   * check reads the committed rows and the `request.decided` lands in one
   * transaction, so two surfaces answering at once record exactly one;
   * `false` is that lost race, or an id never opened.
   */
  readonly decide: (
    runId: RunId,
    requestId: string,
    decision: RequestDecision,
  ) => Effect.Effect<boolean, ClaimError>;
  /** The `request.decided` row answering `requestId`, read from the tail
   *  above `from`: what a run parked on a request waits on. Fails when the
   *  log closes first, which a waiting caller reads as a cancellation. */
  readonly decision: (
    runId: RunId,
    requestId: string,
    from: CommitOrdinal,
  ) => Effect.Effect<Extract<SessionEvent, { type: 'request.decided' }>, Error>;
}

/** One session: the owners its layer built, each reached directly. */
export interface SessionHandle {
  /** The workspace: every run, tool call and host command of this session
   *  takes its roots from here as data. */
  readonly roots: WorkspaceRoots;
  /** The store: one transaction door, reads and claims. */
  readonly log: SessionLog;
  /** The fold every renderer reads, and the local truth beside it. */
  readonly view: SessionViewAccess;
  /** Registration, lookup, stop, lineage, and the run's one terminal
   *  writer (`end`). */
  readonly runs: RunRegistry;
  /** The one handler of every request a surface issues, and the run's
   *  questions to a person (`ask`, `decide`). */
  readonly requests: SessionRequests;
  /** Approval policy, prompt lanes and each run's grants. */
  readonly approvals: SessionApprovals;
  /** The session's presentation host. */
  readonly interactions: SessionHostInteractions;
  /** Every run's input, one reader each. */
  readonly followUps: Inbox;
  /** Every run's trace sink. */
  readonly trace: RunTrace;
  /** The run history over this session's log: the loop's one writer of run
   *  rows, provided to each run's program at launch. */
  readonly runHistory: Context.Service.Shape<typeof RunHistory>;
  /** The history query store (`executions` `query`), closed with the
   *  session. */
  readonly history: HistoryQuery;
}

/**
 * The process's session owner (the `SessionOwner` tag's shape): one session per workspace storage root,
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
export interface SessionOwnerShape {
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

/**
 * The budget one session close spends waiting for its runs to settle before
 * it settles the ones still live itself (`SessionOwner.close`). A hung run
 * must not wedge desktop quit, eat the extension's ~5s deactivate budget, or
 * stall a CLI SIGTERM indefinitely. The closes of a process's sessions start
 * together, so they settle under one deadline for the process, not one each.
 */
export const SESSION_CLOSE_DEADLINE_MS = 5_000;
