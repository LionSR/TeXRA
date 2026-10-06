/**
 * `SessionHandle` — one owner per session for the runtime's coordination state.
 *
 * It is a **composition record**, not a facade: it re-exposes no per-concern
 * methods, so callers address each owner directly
 * (`session.interactions.x(...)`, `session.runs.y(...)`). It has no
 * readiness gate: a restored session is usable the moment it is constructed,
 * and what a run with no running loop in this process is gets decided
 * by the fold's `readOnly` and `group` rules over the session's view, never
 * by a boot pass. It carries the session's `Runs` and its requests as the
 * session layer built them, and composes {@link SessionHostInteractions} and
 * the other session-scoped owners.
 *
 * A session is one per workspace storage root, built and held by the
 * process's session owner (`SessionOwner` in `sessionGraph.ts`, served by
 * `processLayer`): the extension and the CLI open one over the roots their
 * composition root built, the desktop one per project, the service one per
 * project it serves, the SDK one per platform. Each opener keeps the handle
 * it was given. There is no other way to reach the owner:
 * the invariant is "no session-scoped mutable module export" (#7694) — a
 * run-scoped caller receives its session as data, never through a standalone
 * singleton import.
 *
 * Fresh construction is in FORCED dependency order with every cross-reference
 * explicit: no member is ever allowed to default to a neighboring module
 * singleton (the "silent state split" trap — a fresh member quietly sharing a
 * singleton would leak cross-session `clearAll` sweeps).
 *
 * It is deliberately NOT a conversation/session API (send/stream/resume/history):
 * Anthropic shipped and then deleted exactly that shape in the Agent SDK.
 * Continuity stays in options + storage (`ValidatedRunRequest`). The
 * session is justified only as the ownership container.
 */

import {
  Cause,
  Effect,
  Option,
  type Scope,
  Stream,
  SubscriptionRef,
} from 'effect';

import type { AgentEvent } from '@agent/trace';
import { Inbox } from '@agent/followUp/Inbox';
import { classifyAgentError } from '@common/errors';
import { withLogChannel } from '@logger/effectLog';
import { writeLogLine } from '@logger/logSink';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import {
  TEXRA_APPROVAL_POLICY_DEFAULT,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import {
  aggregateId as qualifyAggregateId,
  aggregateTarget,
  type AggregateId,
  type CommitOrdinal,
  type LocalRuntimeState,
  type PermissionPayload,
  type RequestDecision,
  type ResumeBlocker,
  type RunEnd,
  type RunId,
  type RunOutcome,
  type SessionEvent,
  type SessionEventDraft,
  type TranscriptSubscription,
} from '@shared/schemas';
import {
  DatabaseNotOwner,
  type AggregateClaim,
  type DatabaseReadFailed,
  type DatabaseWriteFailed,
} from '@shared/session/database';
import { fold } from '@shared/session/sessionFold';
import {
  emptySessionView,
  type RunView,
  type SessionView,
} from '@shared/session/sessionView';
import type { RunHistoryDraft } from '@shared/session/runStateFold';
import { foldRunRows } from '@shared/session/runRows';
import type {
  Append,
  OpenWork,
  SessionEventReads,
} from '@shared/session/sessionEvents';
import {
  SessionHostInteractions,
  type HostInteractions,
} from './HostInteractions';
import { policyDecidedRows } from './requestPolicy';
import { runEventDraft } from './SessionEvents';
import { presentTerminalResult } from './terminalResultToast';
import {
  createNeutralResponseTextProcessing,
  type ResponseTextProcessing,
} from './responseTextProcessing';
import type { SessionGraph } from './sessionGraph';
import type { SessionApprovals } from './runApprovalQueue';
import type { RunRegistry } from './runRegistry';
import type { HistoryQuery } from './historyQuery/HistoryQuery';
import type { ModelRetryGate } from './ModelRetryGate';

/** The rows that open a request: its `request.opened`, and the
 *  `request.decided` the policy lands beside it. */
type RequestRow = Extract<
  RunHistoryDraft,
  { type: 'request.opened' | 'request.decided' }
>;

const CHANNEL = 'sessionHandle';

/** A streaming row's closing fact, as the run history commits it. */
type StreamClosure = Extract<RunHistoryDraft, { type: 'stream.end' }>;

/**
 * What opening a session supplies (`SessionOwner.open`): persistence mode and
 * host-owned policies. The graph constructs its store over its event
 * database. `interactions` is a presentation host the session is born with,
 * attached for its whole life by the session owner (`sessionLayer`) as soon as
 * the handle exists, for an opener with no later attach step of its own.
 *
 * `events` is deliberately absent: the event plane is the session's graph,
 * built by the session owner per workspace root, so a separately-injected
 * plane could not silently drop every fact of a session onto a plane nobody
 * reads. The session co-constructs it.
 */
export type SessionHandleInit = Partial<
  Pick<SessionHandle, 'responseTextProcessing'>
> & {
  /**
   * The workspace this session works on. Required: the opener is the one
   * caller that knows which paper it opened, and there is no process-wide
   * roots record to fall back to.
   */
  readonly roots: WorkspaceRoots;
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
};

export class SessionHandle {
  /**
   * The one session state every renderer of this session reads (PRD
   * one-fold-three-renderers, 5.1), keyed by the session's storage root (7.3):
   * the fold fiber's level (`SessionViewService.ref`, 7.2), resolved from the
   * session's graph once at construction. Synchronous readers take
   * `SubscriptionRef.getUnsafe(view)`; nothing here writes it.
   */
  readonly view: SubscriptionRef.SubscriptionRef<SessionView>;
  /**
   * {@link view} as a level stream (`SessionViewService.changes`, 7.2): the
   * current view on subscribe, then every later one, ending as the fold
   * does, with the fold's defect if it died and cleanly when the graph
   * closes. A reader that waits on a view the fold has yet to publish (the
   * SDK's drain to a run's final view) reads this, so a dead fold fails it
   * instead of hanging it.
   */
  readonly viewChanges: Stream.Stream<SessionView>;
  /** Set when opening this session's store moved an older build's rows
   *  aside; the host that opened the session presents it once. */
  readonly storeMovedAside: SessionGraph['storeMovedAside'];
  /**
   * The session's `Runs` service, as the session layer built it in the
   * session's scope (`SessionGraph.runs`): registration, lookup and
   * subagent lineage. The record carries it for a host that
   * holds the session; Effect code below a launch takes it from context,
   * where the run and request entries provide this same value.
   * Hears every `run.end` this process committed
   * ({@link receiveFoldedEvent}), in commit order and only once the view has
   * folded it; the phase itself is the fold's (`RunView.status`), never a
   * second map here.
   */
  readonly runs: RunRegistry;
  /**
   * The session's event plane (PRD 7.1, contract C7): what a renderer reads
   * with `events.all(session.now())`. The reads only: publishing goes
   * through {@link publish} and {@link commit}, the session's doors onto
   * the graph's one publisher, and nothing else can append.
   */
  readonly events: SessionEventReads;
  /**
   * The session's requests, as the session layer built them in the session's
   * scope (`SessionGraph.requests`): its approval state and the one handler
   * of every request a surface issues to this session (PRD 7.6, 8.2).
   * An in-process surface runs that handler on the runtime its own
   * composition root owns and reads the Effect's own result as the response.
   * Everything that answers a request already holds the session, so this is
   * reached through the session rather than from context.
   */
  readonly requests: SessionGraph['requests'];
  /** The run history over this session's event plane, provided to each run's
   *  program at the `executeAgent` boundary. */
  readonly runHistory: SessionGraph['runHistory'];
  /**
   * The tail as the view has folded it (PRD 7.2): what a reader that reads
   * {@link view} beside each row reads, from `now()`, so no row reaches it
   * before the fold has landed the state that row produced.
   */
  readonly folded: SessionGraph['folded'];
  /** Ordered replay and live inputs for each transport subscription. */
  readonly inputs: SessionGraph['inputs'];
  /**
   * The transcript subscription set, one set per port: the aggregates whose
   * transcript tier the view folds for that port, the view's set being the
   * union over every port. An Effect-native reader (the SDK's run drain,
   * the session bridge's ports) sets its own port here;
   * {@link setTranscriptSubscriptions} is the same write with this session's
   * qualification and disposal guard applied.
   */
  readonly subscriptions: SessionGraph['subscriptions'];
  /**
   * The workspace this session works on: the four per-workspace host roots.
   * Every run, tool call and host command this session serves takes them from
   * here as data, so several sessions in one process each write under their
   * own folder.
   */
  readonly roots: WorkspaceRoots;
  /** The session's follow-up inbox: every run's input, one reader each. */
  readonly followUps: Inbox;
  private readonly graph: SessionGraph;
  private disposed = false;
  /** Each run's first refused trace row, until its terminal takes it. */
  private readonly lost = new Map<
    RunId,
    DatabaseNotOwner | DatabaseWriteFailed
  >();
  /** Session-scoped host interaction owner. */
  readonly interactions: SessionHostInteractions;
  /**
   * This session's approval queues, pending registries and bypass state: the
   * `approvals` of its {@link requests}, carried here because run-scoped host
   * code (the approval gates, the goal and plan tools) reaches it through the
   * session record. Not a second instance — the session layer builds one.
   */
  readonly approvals: SessionApprovals;
  private texraApprovalPolicy = TEXRA_APPROVAL_POLICY_DEFAULT;
  /**
   * Coordinates recovery probes for model routes shared by parallel runs.
   * The process's one gate, built by its session family in the runtime's
   * scope, so every project's runs on a credential share its cooling.
   */
  readonly modelRetries: ModelRetryGate;
  /** The history query store (`executions` `query`), closed with the session. */
  readonly history: HistoryQuery;
  /** Host policy for provider-output cleanup and continuation joining. */
  readonly responseTextProcessing: ResponseTextProcessing;
  /**
   * Built by the session owner alone (`sessionLayer.ts`), inside the root's
   * graph, with that graph handed over as a function of the session: the
   * request handler admits on the session, so the graph is bound to the
   * handle it serves. Every other caller opens through `SessionOwner.open`.
   */
  constructor(
    init: SessionHandleInit &
      Pick<SessionHandle, 'modelRetries' | 'history'> & {
        readonly graph: (session: SessionHandle) => SessionGraph;
      },
  ) {
    // Forced dependency order, every cross-reference explicit — never let a
    // member fall back to a neighboring module singleton (silent-state-split).
    this.roots = init.roots;
    // Built before the graph, whose approvals announce bypasses through it.
    this.interactions = new SessionHostInteractions();
    const graph = init.graph(this);
    this.graph = graph;
    this.approvals = graph.requests.approvals;
    this.events = graph.events;
    this.runHistory = graph.runHistory;
    this.view = graph.view;
    this.viewChanges = graph.viewChanges;
    this.storeMovedAside = graph.storeMovedAside;
    this.folded = graph.folded;
    this.requests = graph.requests;
    this.inputs = graph.inputs;
    this.subscriptions = graph.subscriptions;
    this.runs = graph.runs;
    const run = (runId: RunId) => qualifyAggregateId('run', runId);
    const viewOf = (runId: RunId) =>
      SubscriptionRef.getUnsafe(graph.view).runs.get(runId);
    this.followUps = new Inbox({
      exclusive: (job) => graph.exclusive(job),
      detach: (job) => graph.detach(job),
      pending: (runId) => graph.events.pendingFollowUps(run(runId)),
      inputClosed: (runId) => graph.events.inputClosed(run(runId)),
      parentOf: (runId) => viewOf(runId)?.parentId,
      named: (runId, followUpId) =>
        graph.events.followUpNamed(run(runId), followUpId),
      acquireClaim: (runId) => this.acquireClaims(run(runId)),
      live: (runId) => graph.runs.isLive(runId),
    });
    this.modelRetries = init.modelRetries;
    this.history = init.history;
    this.responseTextProcessing =
      init.responseTextProcessing ?? createNeutralResponseTextProcessing();
  }

  /**
   * Shut this session's doors: from here on a detached publication, a
   * transcript subscription and a request's cancellation write nothing, and
   * no terminal result is presented for another row. The session layer runs it as the
   * last of the session entry's own finalizers, after every owner above has
   * unwound, so a fact those owners publish on the way out still lands.
   */
  closeDoors(): void {
    this.disposed = true;
  }

  /** Whether a publication arrives after {@link closeDoors}: it writes
   *  nothing, and the first one says so. What still publishes then is a run
   *  that outlived its session's close budget, whose closing facts this
   *  session can no longer take. */
  private refusedAfterClose(): boolean {
    if (!this.disposed) return false;
    if (!this.reportedLateWrite) {
      this.reportedLateWrite = true;
      writeLogLine(
        'WARN',
        CHANNEL,
        `Session ${this.roots.storage} is closed; a run still running published into it and nothing was written`,
      );
    }
    return true;
  }
  private reportedLateWrite = false;

  /** Live host-neutral approval policy for executable requests. */
  get approvalPolicy(): TexraApprovalPolicy {
    return this.texraApprovalPolicy;
  }

  /** Set the session's approval policy, the host's setting: every request
   *  any of its runs opens from now on is decided under it. */
  setApprovalPolicy(policy: TexraApprovalPolicy): void {
    this.texraApprovalPolicy = policy;
  }

  /** Hold one run's claim for the caller's scope as the run's driver: the
   *  claim ends with the last hold, however it was found — a registration
   *  leaves it standing for the driver to end. */
  holdRunClaim(
    runId: RunId,
  ): Effect.Effect<
    void,
    DatabaseNotOwner | DatabaseReadFailed | DatabaseWriteFailed,
    Scope.Scope
  > {
    return Effect.asVoid(
      Effect.acquireRelease(
        this.acquireClaims(qualifyAggregateId('run', runId), { ends: true }),
        (release) => release,
      ),
    );
  }

  /** Hold one run's claim for the caller's scope without ending it: the claim
   *  goes back to how this hold found it, so a run's standing claim outlives
   *  a detach batch or an inactive-run step over it. */
  borrowRunClaim(
    runId: RunId,
  ): Effect.Effect<
    void,
    DatabaseNotOwner | DatabaseReadFailed | DatabaseWriteFailed,
    Scope.Scope
  > {
    return Effect.asVoid(
      Effect.acquireRelease(
        this.acquireClaims(qualifyAggregateId('run', runId)),
        (release) => release,
      ),
    );
  }

  /** Admit an aggregate's existing claim before this process appends to it:
   *  a run's, before resume reads or mutations. */
  acquireClaims(
    id: AggregateId,
    options: { readonly ends?: boolean } = {},
  ): Effect.Effect<
    Effect.Effect<void>,
    DatabaseNotOwner | DatabaseReadFailed | DatabaseWriteFailed
  > {
    return this.graph.acquireClaims(id, options.ends === true);
  }

  /**
   * Whether this process holds `runId` open in the database: the durable
   * claim, read from SQLite rather than from the fold, which lags it by a
   * drain. The one ownership question a caller outside this class asks.
   */
  ownsRun(runId: RunId): Effect.Effect<boolean, DatabaseReadFailed> {
    return this.graph.ownsRun(runId);
  }

  /**
   * Who holds `runId` right now, with the owner's liveness proved in the
   * call. A resume gate and the run listing word their refusal from this,
   * never from the view: the view's liveness comes from a prober that only
   * watches owners of runs already resident in it.
   */
  claimOwner(runId: RunId): Effect.Effect<AggregateClaim, DatabaseReadFailed> {
    return this.graph.claimOwner(runId);
  }

  /**
   * Publish one run-scoped trace event as its durable arm (`runEventDraft`);
   * a trace event with no arm goes nowhere. It is every run trace's session
   * sink (the trace is built with it), and the few places that publish a
   * trace fact for a run whose own trace is already gone call it directly.
   */
  publishRunEvent(runId: RunId, event: AgentEvent): void {
    if (this.refusedAfterClose()) return;
    if (event.type === 'stream.chunk') {
      const { text } = event;
      this.graph.detach(() => this.graph.publishText(runId, event.id, text));
      return;
    }
    // The call fixes the row's place in the publication order; the job
    // builds the draft when it runs. A refusal is the run's to hear at its
    // end (`lostRows`); the first one is kept.
    this.graph.detach((append) =>
      this.runEventPublication(runId, event, append).pipe(
        Effect.tapError((refusal) =>
          Effect.sync(() => {
            if (!this.lost.has(runId)) this.lost.set(runId, refusal);
          }),
        ),
      ),
    );
  }

  /**
   * The first of `runId`'s trace rows the store refused, taken, as the error
   * its `run.end` carries: every row the run published before this call has
   * been tried by then. The run's terminal reads it once, so its end says
   * the run failed rather than claiming a record it does not have. Nothing
   * about it is stored.
   */
  lostRows(runId: RunId): Effect.Effect<RunEnd['error'] | undefined> {
    return this.settled.pipe(
      Effect.map(() => {
        const refusal = this.lost.get(runId);
        this.lost.delete(runId);
        return refusal === undefined
          ? undefined
          : {
              kind: classifyAgentError(refusal),
              message: `Rows this run published were not written: ${refusal.message}`,
            };
      }),
    );
  }

  /** The row one run-scoped trace event commits. The draft is built when the publisher runs the job,
   *  after every chunk enqueued before it has reached the text source, so a
   *  `stream.end` with no final text of its own closes on the complete
   *  streamed text. */
  private runEventPublication(
    runId: RunId,
    event: AgentEvent,
    append: Append,
  ): Effect.Effect<unknown, DatabaseNotOwner | DatabaseWriteFailed> {
    const draft = runEventDraft(
      runId,
      event.type === 'stream.end'
        ? {
            ...event,
            finalText: event.finalText ?? this.graph.readText(runId, event.id),
          }
        : event,
    );
    if (draft === null) return Effect.void;
    return append([draft]);
  }

  /**
   * The facts that close what is still open on `runId`: every streaming row,
   * with its text, and with an `outcome`, every stage too. The loop commits
   * the streams' in the batch that parks the run (its `waiting` step), so a
   * parked transcript never streams; a run's end closes both. The open ids
   * are the publisher's, kept as it commits, not the view's: the view folds
   * a run's transcript only while some port subscribes it. Read after this
   * session {@link settled}, or inside a publisher job, so every row before
   * it is counted.
   */
  closureFacts(runId: RunId): StreamClosure[];
  closureFacts(
    runId: RunId,
    outcome: RunOutcome,
  ): (StreamClosure | Extract<SessionEventDraft, { type: 'stage.end' }>)[];
  closureFacts(
    runId: RunId,
    outcome?: RunOutcome,
  ): (StreamClosure | Extract<SessionEventDraft, { type: 'stage.end' }>)[] {
    const aggregateId = qualifyAggregateId('run', runId);
    return this.openWork(runId).flatMap(
      ({
        kind,
        id,
      }): (
        StreamClosure | Extract<SessionEventDraft, { type: 'stage.end' }>
      )[] => {
        if (kind === 'stream')
          return [
            {
              type: 'stream.end',
              aggregateId,
              id,
              finalText: this.graph.readText(runId, id),
            },
          ];
        return outcome === undefined
          ? []
          : [{ type: 'stage.end', aggregateId, id, status: outcome }];
      },
    );
  }

  /** What the publisher holds open on `runId` (`SessionEvents.openWork`):
   *  what the host exit closes. Read after this session {@link settled}. */
  openWork(runId: RunId): readonly OpenWork[] {
    return this.events.openWork(qualifyAggregateId('run', runId));
  }

  /**
   * The `request.decided` row that answers `requestId`, read from the plane's
   * tail above `from` (one run model, 3.7): what a run parked on a request
   * waits on, in process, whichever surface decides it. Fails when the plane
   * closes before a decision lands, which a waiting caller reads as a
   * cancellation.
   */
  decisionFor(
    runId: RunId,
    requestId: string,
    from: CommitOrdinal,
  ): Effect.Effect<Extract<SessionEvent, { type: 'request.decided' }>, Error> {
    const aggregate = qualifyAggregateId('run', runId);
    return this.events.all(from).pipe(
      Stream.filter(
        (event): event is Extract<SessionEvent, { type: 'request.decided' }> =>
          event.type === 'request.decided' &&
          event.aggregateId === aggregate &&
          event.requestId === requestId,
      ),
      Stream.runHead,
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new Error(
                `The session closed before request ${requestId} was decided.`,
              ),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
  }

  /**
   * Ask a person: open the request on its run and wait for the decision. The
   * one door for a request a tool raises (a command, an edit, a plan, a
   * delegation, a question); the loop's own outcome question commits its row
   * with its recovery binding through the run history and waits with
   * {@link decisionFor} directly. An interruption anywhere in the call (the
   * run stopped, the session unwound) closes the request as cancelled, so a
   * pending set is never left behind in the fold; a cancel for a request
   * this call never opened writes nothing.
   *
   * This call is also the one place that knows whether the open committed,
   * so it owns `onNeverCommitted`: whatever the caller staged for a request
   * the fold never listed is released from here, and from nowhere else.
   */
  openRequest<E = never>(
    runId: RunId,
    payload: PermissionPayload,
    options: {
      /**
       * How the request's rows commit, answering the commit its decision is
       * read from: a tool call's request commits through its run's history,
       * beside the `tool.binding` that lets it outlive this process, and a
       * request a resumed call re-enters commits only what the policy
       * decides. Omitted, this session commits them.
       */
      readonly open?: (
        rows: readonly RequestRow[],
      ) => Effect.Effect<CommitOrdinal, E>;
      readonly thread?: string | null;
      /**
       * Cleanup for what the caller staged before the request opened, run
       * once and uninterruptibly in the two cases that leave no row behind:
       * the `request.opened` append was refused, or an interruption's
       * cancellation found nothing open. An open that did commit always
       * ends in a `request.decided` — the release every surface already
       * follows — so a committed request is never released here, not even
       * when its cancellation is itself refused and it stays pending.
       */
      readonly onNeverCommitted?: Effect.Effect<void>;
    } = {},
  ): Effect.Effect<
    RequestDecision,
    DatabaseNotOwner | DatabaseWriteFailed | E
  > {
    const requestId = payload.data.requestId;
    const aggregateId = qualifyAggregateId('run', runId);
    const releaseUncommitted = Effect.uninterruptible(
      options.onNeverCommitted ?? Effect.void,
    );
    const rows: RequestRow[] = [
      {
        type: 'request.opened',
        aggregateId,
        requestId,
        payload,
        thread: options.thread ?? null,
      },
      ...policyDecidedRows(this, runId, payload),
    ];
    const open: (
      opened: readonly RequestRow[],
    ) => Effect.Effect<
      CommitOrdinal,
      E | DatabaseNotOwner | DatabaseWriteFailed
    > =
      options.open ??
      ((opened) =>
        Effect.suspend(() => {
          const from = this.now();
          return this.commit(opened).pipe(Effect.as(from));
        }));
    return Effect.gen({ self: this }, function* () {
      const from = yield* open(rows).pipe(
        Effect.tapError(() => releaseUncommitted),
      );
      return yield* this.decisionFor(runId, requestId, from).pipe(
        Effect.map((row) => row.decision),
        Effect.catch((cause) =>
          Effect.logWarning(
            `Request ${requestId} closed without a decision`,
          ).pipe(
            Effect.annotateLogs({ data: cause }),
            withLogChannel(CHANNEL),
            Effect.as({
              action: 'cancel',
              cause: cause.message,
            } satisfies RequestDecision),
          ),
        ),
      );
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          if (this.disposed) return;
          this.graph.detach((append) =>
            this.decisionRow(
              runId,
              requestId,
              { action: 'cancel', cause: 'Run interrupted.' },
              append,
            ).pipe(
              // `false` is the interruption that landed before the open
              // committed: no row exists, so this cancellation writes none
              // either and the caller's staging has no decision coming.
              Effect.tap((cancelled) =>
                cancelled ? Effect.void : releaseUncommitted,
              ),
            ),
          );
        }),
      ),
    );
  }

  /**
   * Answer a request, if it is still open: the one writer of a decision (one
   * run model, 3.7). The check reads the committed rows and the
   * `request.decided` row lands as one job of the session's publisher, so
   * two surfaces answering at once record exactly one decision — a run
   * aggregate takes appends from its claim holder alone, and inside this
   * process the publisher orders them. `false` is that lost race, or an id
   * never opened: nothing was written and the live waiter keeps the
   * decision that was.
   */
  decideRequest(
    runId: RunId,
    requestId: string,
    decision: RequestDecision,
  ): Effect.Effect<
    boolean,
    DatabaseNotOwner | DatabaseReadFailed | DatabaseWriteFailed
  > {
    return this.graph.exclusive((append) =>
      this.decisionRow(runId, requestId, decision, append),
    );
  }

  /** {@link decideRequest}'s job: the body the session's one publisher
   *  runs, whether a surface awaits it or an interrupted
   *  {@link openRequest} detaches it. */
  private decisionRow(
    runId: RunId,
    requestId: string,
    decision: RequestDecision,
    append: Append,
  ): Effect.Effect<
    boolean,
    DatabaseNotOwner | DatabaseReadFailed | DatabaseWriteFailed
  > {
    const aggregateId = qualifyAggregateId('run', runId);
    return Effect.gen({ self: this }, function* () {
      const { requests } = foldRunRows(
        yield* this.graph.aggregateRows(aggregateId),
      );
      if (requests[requestId]?.resolved !== false) return false;
      yield* append([
        { type: 'request.decided', aggregateId, requestId, decision },
      ]);
      return true;
    });
  }

  /**
   * Publish facts the session authors with no fiber to wait on (PRD 7.1):
   * a registry's agent list change, a policy snapshot. The batch takes its
   * place in the graph's one publication order at this call and commits in
   * that order; {@link settled} waits for it. A refused batch is reported
   * by the next awaited write to its aggregate. Durable subscribers
   * read committed facts from the table tail; publication never delivers
   * payloads directly. A publish after teardown goes nowhere: the session's
   * owners have unwound and a late fact has no reader.
   */
  publish(events: readonly SessionEventDraft[]): void {
    if (events.length === 0 || this.refusedAfterClose()) return;
    this.graph.detach((append) => append(events));
  }

  /** Native metadata publication through the same ordered publisher,
   *  awaited: returns once the view has folded the batch. A refused batch
   *  wrote nothing and comes back typed (D6 b): the caller stops on it, it
   *  is never retried or converted here. */
  commit(
    events: readonly SessionEventDraft[],
  ): Effect.Effect<
    readonly SessionEvent[],
    DatabaseNotOwner | DatabaseWriteFailed
  > {
    return this.graph.publish(events);
  }

  /** Registration owns its runs' claims: a birth's as soon as its append
   *  commits, before its tail drains, and a re-registration's taken over
   *  before it appends. Its refusal is typed like {@link commit}'s. */
  commitRegistration(
    events: readonly SessionEventDraft[],
  ): Effect.Effect<
    readonly SessionEvent[],
    DatabaseNotOwner | DatabaseReadFailed | DatabaseWriteFailed
  > {
    return this.graph.publishRegistration(events);
  }

  /** Read and append as one job of the publisher, with no other write
   *  between them (the update may read more of the run inside that job). C5
   *  excludes foreign writers; losing the claim between the read and the
   *  append comes back as `DatabaseNotOwner` with nothing written. */
  updateRecordFacts<A, E>(
    runId: RunId,
    update: (
      rows: readonly SessionEvent[],
    ) => Effect.Effect<{ events: readonly SessionEventDraft[]; value: A }, E>,
  ): Effect.Effect<
    A,
    E | DatabaseNotOwner | DatabaseReadFailed | DatabaseWriteFailed
  > {
    return this.graph.exclusive((append) =>
      this.graph.runRecords(runId).pipe(
        Effect.flatMap(update),
        Effect.flatMap((next) => Effect.as(append(next.events), next.value)),
      ),
    );
  }

  /**
   * One run of {@link view}'s current level, or undefined when the view
   * holds no such run: the synchronous read for a caller on a settled
   * session (a host request, a tool inside a live run). Its transcript-tier
   * facts are complete only while some port subscribes the run; a reader
   * that needs the whole history of a run nobody holds takes
   * {@link readView}.
   */
  runView(runId: RunId): RunView | undefined {
    return SubscriptionRef.getUnsafe(this.view).runs.get(runId);
  }

  /**
   * The view folded cold from the log as of this call (one run model, R1:
   * the one fold, over a one-shot read): the listing tier of every run and
   * the whole history of the runs named. For a reader outside the live
   * view's residency: a one-shot backend read of a run no port holds, or a
   * read that must not race the live fold's first replay.
   */
  readView(runIds: readonly RunId[]): Effect.Effect<SessionView> {
    return this.graph
      .inputs(
        runIds.map((id) => ({
          id: qualifyAggregateId('run', id),
          fromSeq: 0,
        })),
        0,
        false,
      )
      .pipe(
        Stream.runHead,
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.die(new Error('Session input read produced no replay')),
            onSome: (replay) =>
              Effect.succeed(
                fold(emptySessionView(this.roots.storage), replay),
              ),
          }),
        ),
      );
  }

  /** Record reads (`run.config`, `run.report`, ...) read the database's latest row of each type, never the display fold. */
  readRunRecords(
    runId: RunId,
  ): Effect.Effect<readonly SessionEvent[], DatabaseReadFailed> {
    return this.graph.runRecords(runId);
  }

  /** Every committed row of one aggregate, private rows included, for the
   *  readers that fold a keyed record or a journal over the whole aggregate;
   *  with `types`, only the rows of those types, through the type index. */
  readAggregate(
    id: AggregateId,
    types?: readonly SessionEvent['type'][],
  ): Effect.Effect<readonly SessionEvent[], DatabaseReadFailed> {
    return this.graph.aggregateRows(id, types);
  }

  /** The run aggregate's committed display rows, its projected `usage`
   *  rows among them; empty when the run never existed or is tombstoned. */
  readRunEvents(
    runId: RunId,
  ): Effect.Effect<readonly SessionEvent[], DatabaseReadFailed> {
    return this.graph
      .displayRows(qualifyAggregateId('run', runId))
      .pipe(
        Effect.map((events) =>
          events.at(-1)?.type === 'run.removed' ? [] : events,
        ),
      );
  }

  /**
   * One row of the fold-gated tail ({@link folded}, PRD 7.2): the follow-up
   * lifecycle, the terminal-result presenter and the folded-stop child sweep, none on
   * the raw tail above: each reads the run's view synchronously, and a
   * notification ahead of the fold would hand it the state the row replaced.
   */
  receiveFoldedEvent(event: SessionEvent): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      // The sweep and host notifications belong to the authoring process.
      const target = aggregateTarget(event.aggregateId);
      this.graph.events.foldLifecycle(event);
      const { self } = yield* SubscriptionRef.get(this.graph.local);
      if (event.origin == null || !self.includes(event.origin)) return;
      if (target.kind !== 'run' || event.type !== 'run.end') return;
      // Presented once the view has folded the row, so the presenter reads
      // the run's parent edge from the state the row produced.
      if (!this.disposed) {
        yield* Effect.suspend(() =>
          presentTerminalResult(this, { ...event, runId: target.id }),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning('Terminal result presentation threw').pipe(
              Effect.annotateLogs({ data: Cause.squash(cause) }),
              withLogChannel(CHANNEL),
            ),
          ),
        );
      }
      this.runs.sweepChildrenOfFoldedStop(target.id);
    });
  }

  /**
   * A barrier: every publication enqueued before it has run, and the view
   * has folded what they committed. It reports nothing: a refused detached
   * write is heard by the next awaited write to its aggregate, which for a
   * run's own rows is that run's next commit or its ending.
   */
  get settled(): Effect.Effect<void> {
    return this.graph.settle;
  }

  /**
   * The session's current commit ordinal: where a reader attaching now starts
   * its `events.all` read (PRD 10.3), so it sees what is published from here
   * on and replays nothing.
   */
  now(): CommitOrdinal {
    return this.graph.now();
  }

  /**
   * Replace one port's transcript subscription set (PRD 7.2, 8.1): the
   * logical stream ids whose transcript tier the view folds for that port.
   * Qualify them once when entering the event graph. An empty
   * set removes the port; the view's set is the union over every port.
   *
   * The write is returned, not run: the session owns no fiber for a set a
   * surface asks for, so the host entry that asks runs it on its own runtime
   * and a session disposed before it starts writes nothing.
   */
  setTranscriptSubscriptions(
    port: string,
    set: readonly (Omit<TranscriptSubscription, 'id'> & { id: RunId })[],
  ): Effect.Effect<void> {
    return Effect.suspend(() =>
      this.disposed
        ? Effect.void
        : this.subscriptions.set(
            port,
            set.map(({ id, fromSeq }) => ({
              id: qualifyAggregateId('run', id),
              fromSeq,
            })),
          ),
    );
  }

  /**
   * Record why this process cannot act on a run (another live TeXRA process
   * holds it, its state could not be read): local truth the fold reads as
   * `readOnly` with the detail as `statusDetail` (PRD 5.1), never a row.
   */
  markUnreadable(runId: RunId, detail: string): Effect.Effect<void> {
    return this.setUnreadable(runId, detail);
  }

  /** Drop a run's unreadable detail: a read that found it free disproved it. */
  clearUnreadable(runId: RunId): Effect.Effect<void> {
    return this.setUnreadable(runId, null);
  }

  private setUnreadable(
    runId: RunId,
    detail: string | null,
  ): Effect.Effect<void> {
    return Effect.suspend(() =>
      this.disposed
        ? Effect.void
        : SubscriptionRef.update(this.graph.local, (local) => {
            const rest = local.unreadable.filter((u) => u.runId !== runId);
            if (detail === null && rest.length === local.unreadable.length) {
              return local;
            }
            return {
              ...local,
              unreadable: detail === null ? rest : [...rest, { runId, detail }],
            };
          }),
    );
  }

  /** The runs a resume found blocked here, with what each waits for. */
  resumeBlocks(): LocalRuntimeState['resumeBlocked'] {
    return SubscriptionRef.getUnsafe(this.graph.local).resumeBlocked;
  }

  /**
   * Record what a resume of a run waits for (durable harness D5: local
   * truth the fold reads as `resumeBlocked`, never a row), `retry` when a
   * resume was asked for; null when nothing blocks it any more.
   */
  markResumeBlocked(
    runId: RunId,
    blocked: { readonly reason: ResumeBlocker; readonly retry: boolean } | null,
  ): Effect.Effect<void> {
    return Effect.suspend(() =>
      this.disposed
        ? Effect.void
        : SubscriptionRef.update(this.graph.local, (local) => {
            const rest = local.resumeBlocked.filter((b) => b.runId !== runId);
            if (blocked === null && rest.length === local.resumeBlocked.length)
              return local;
            // The same block again leaves the state, and the view, as it is.
            const held = local.resumeBlocked.find((b) => b.runId === runId);
            if (
              blocked !== null &&
              held !== undefined &&
              held.retry === blocked.retry &&
              held.reason.kind === blocked.reason.kind &&
              held.reason.name === blocked.reason.name
            )
              return local;
            return {
              ...local,
              resumeBlocked:
                blocked === null ? rest : [...rest, { runId, ...blocked }],
            };
          }),
    );
  }
}
