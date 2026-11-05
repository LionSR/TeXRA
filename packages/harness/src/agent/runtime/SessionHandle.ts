/**
 * What opening a session supplies (`SessionHandleInit`) and the shape of
 * its requests (`SessionRequestsShape`, served as `SessionRequests`). A session is one per workspace storage root, built and held
 * by the process's session owner (`SessionOwner`, served by `processLayer`);
 * its layer serves each owner it built as its own service, which a
 * run-scoped caller reads from context, never through a module singleton.
 * It has no readiness gate: a restored session is usable the moment it
 * exists, and the view's `readOnly` and `group` rules decide how a run with
 * no loop here reads.
 */

import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type {
  DecisionOf,
  PermissionPayload,
  RequestDecision,
  CommitOrdinal,
  RunId,
  SessionEvent,
} from '@shared/schemas';
import type {
  DatabaseReadFailed,
  DeletionMode,
} from '@shared/session/database';
import type { DraftBlob } from '@shared/session/historyTurns';
import type {
  RequestError,
  OutcomeOf,
  RuntimeRequest,
} from '@shared/session/runtimeRequest';
import type { RunHistoryDraft } from '@shared/session/runState';
import type { LogWriteError } from '@shared/session/sessionLog';
import type { Effect } from 'effect';

import type { HostInteractions } from './HostInteractions';
import type { SessionServices } from './rootLaunch';

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
  /** Absent, the project's database; ephemeral, a throwaway one. */
  readonly transcriptMode?: { readonly kind: 'ephemeral' };
}

/** The rows that open a request: its `request.opened`, and the
 *  `request.decided` the policy lands beside it. */
export type RequestRow = Extract<
  RunHistoryDraft,
  { type: 'request.opened' | 'request.decided' }
>;

/** How {@link SessionRequestsShape.ask} opens its request. */
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
 * requests independently. A surface's request reads the session's runs and
 * owners from its caller's context: the session's own, which the SDK and
 * the session's fibers provide.
 */
export interface SessionRequestsShape {
  /** Answer a surface's request once: its kind's {@link OutcomeOf}, or an error. */
  readonly request: <R extends RuntimeRequest>(
    req: R,
  ) => Effect.Effect<OutcomeOf<R['kind']>, RequestError, SessionServices>;
  /** Internal deletion policies share the same admission and transaction as
   *  a user's `run.delete`. */
  readonly removeRun: (
    runId: RunId,
    mode: DeletionMode,
    expectedStartCommit: CommitOrdinal,
  ) => Effect.Effect<void, RequestError, SessionServices>;
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
