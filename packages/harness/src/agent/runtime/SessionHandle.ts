/**
 * `SessionHandle`: one session, as the record of the owners its layer built
 * (`sessionLayer.ts`). Each member is a deep owner of one concern, and
 * callers address it directly (`session.log.transact(...)`,
 * `session.runs.stop(...)`); the record itself does no work and forwards
 * nothing.
 *
 * A session is one per workspace storage root, built and held by the
 * process's session owner (`SessionOwner`, served by `processLayer`). Each
 * opener keeps the handle it was given; a run-scoped caller receives its
 * session as data, never through a module singleton. It has no readiness
 * gate: a restored session is usable the moment it exists, and the view's
 * `readOnly` and `group` rules decide how a run with no loop here reads.
 */

import type { Inbox } from '@agent/followUp/Inbox';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type {
  DecisionOf,
  PermissionPayload,
  RequestDecision,
  CommitOrdinal,
  RunEnd,
  RunId,
  RunOutcome,
  SessionEvent,
  SessionEventDraft,
} from '@shared/schemas';
import type { Approvals } from '@shared/session/approvalDecision';
import type {
  DatabaseReadFailed,
  DeletionMode,
} from '@shared/session/database';
import type { DraftBlob } from '@shared/session/historyTurns';
import type { RequestError } from '@shared/session/runtimeRequest';
import type { RunHistory, SessionLog } from '@shared/session/runHistory';
import type { OutcomeOf, RuntimeRequest } from '@shared/session/runtimeRequest';
import type { RunHistoryDraft } from '@shared/session/runState';
import type { SessionViewAccess } from '@shared/session/sessionInputs';
import type { LogWriteError } from '@shared/session/sessionLog';
import type { SessionTools } from '@tools/sessionTools';
import type { Context, Effect } from 'effect';

import type {
  SessionHostInteractions,
  HostInteractions,
} from './HostInteractions';
import type { HistoryQuery } from './historyQuery/HistoryQuery';
import type { RunsShape } from './runs';

/** A streaming row's closing fact, as the run history commits it. */
export type StreamClosure = Extract<RunHistoryDraft, { type: 'stream.end' }>;

/** The facts that close a run's open work: its streams, and with an
 *  outcome its stages too. */
export type ClosureFact =
  StreamClosure | Extract<SessionEventDraft, { type: 'stage.end' }>;

/** Each run's trace (the session log's `publish`): the first row the store
 *  refused, and its open work. */
export interface RunTrace {
  /** The first refused row of `runId`, taken, as its `run.end` error. */
  lost(runId: RunId): Effect.Effect<RunEnd['error'] | undefined>;
  /** What closes `runId`'s open streams (and stages, with an `outcome`);
   *  read in a publisher job or after `SessionLog.settled`. */
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
  /** A presentation host the session is born with: it answers while no
   *  host is attached. */
  readonly interactions?: HostInteractions;
  /** What the session does with its interrupted tasks
   *  (`OpenOptions.host.interruptedTasks`, `followInterruptedTasks`);
   *  absent, nothing. */
  readonly interruptedTasks?: 'list' | 'resume';
  /** Absent, the project's database; ephemeral, a throwaway one. */
  readonly transcriptMode?: { readonly kind: 'ephemeral' };
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
  /** The strings the payload names by address (a tool edit's proposal),
   *  stored with the `request.opened` row; the session log's `blobs` reads
   *  them back for as long as the row lives. */
  readonly blobs?: readonly DraftBlob[];
}

/**
 * Everything one session's requests are: the one handler of every request a
 * surface issues, and a run's questions to a person, asked and decided as
 * rows.
 * Built by the session layer over that session's log (`SessionRequests.ts`);
 * one value per session, so two sessions admit, serialize and answer
 * requests independently.
 */
export interface SessionRequests {
  /** Answer a surface's request once: its kind's {@link OutcomeOf}, or an error. */
  readonly request: <R extends RuntimeRequest>(
    req: R,
  ) => Effect.Effect<OutcomeOf<R['kind']>, RequestError>;
  /** Internal deletion policies share the same admission and transaction as
   *  a user's `run.delete`. */
  readonly removeRun: (
    runId: RunId,
    mode: DeletionMode,
    expectedStartCommit: CommitOrdinal,
  ) => Effect.Effect<void, RequestError>;
  /**
   * Ask a person: open the request on its run and wait for a decision its
   * kind takes; the one door for a request a tool raises. An interruption
   * anywhere in the call closes the request as cancelled, so none is left
   * pending; a cancel for a request this call never opened writes nothing.
   */
  readonly ask: <P extends PermissionPayload, E = never>(
    runId: RunId,
    payload: P,
    options?: AskOptions<E>,
  ) => Effect.Effect<DecisionOf<P['kind']>, LogWriteError | E>;
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
  ) => Effect.Effect<boolean, DatabaseReadFailed | LogWriteError>;
  /** The `request.decided` row answering `requestId`, read from the tail
   *  above `from`: what a run blocked on a request waits for. Fails when the
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
  readonly log: Context.Service.Shape<typeof SessionLog>;
  /** The view every renderer reads, and the local state beside it. */
  readonly view: Context.Service.Shape<typeof SessionViewAccess>;
  /** Its runs: launch, resume, stop, and what this process holds. */
  readonly runs: RunsShape;
  /** The project's tools: its plugin layers and MCP servers, closed with it. */
  readonly tools: SessionTools;
  /** The one handler of every request a surface issues, and the run's
   *  questions to a person (`ask`, `decide`). */
  readonly requests: SessionRequests;
  /** Approval policy, prompt lanes and each run's grants. */
  readonly approvals: Context.Service.Shape<typeof Approvals>;
  /** The session's presentation host. */
  readonly interactions: SessionHostInteractions;
  /** Every run's input, one reader each. */
  readonly followUps: Inbox;
  /** What every run's trace left: its refused rows and open work. */
  readonly trace: RunTrace;
  /** The run history over this session's log: each run's cell commits
   *  through it, provided to each run's program at launch. */
  readonly runHistory: Context.Service.Shape<typeof RunHistory>;
  /** The history query store (`executions` `query`), closed with the
   *  session. */
  readonly history: HistoryQuery;
}

/** The budget one session close spends waiting for its runs to end before it
 *  reports the ones still live abandoned (`SessionOwner.close`). A hung run
 *  must not wedge desktop quit, eat the extension's ~5s deactivate budget, or
 *  stall a CLI SIGTERM indefinitely. The closes of a process's sessions start
 *  together, so they finish under one deadline for the process, not one each. */
export const SESSION_CLOSE_DEADLINE_MS = 5_000;
