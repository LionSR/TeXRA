/**
 * `SessionHandle` — one owner per session for the runtime's coordination state.
 *
 * It is a **composition record**, not a facade: it re-exposes no per-concern
 * methods, so callers address each owner directly
 * (`session.interactions.x(...)`, `session.runs.y(...)`). It has no
 * readiness gate: a restored session is usable the moment it is constructed,
 * and what a stream with no live flow context in this process is gets decided
 * by the fold's `readOnly` and `group` rules over the session's view, never
 * by a boot pass. It carries the session's `Runs` and its requests as the
 * session layer built them, and composes {@link SessionHostInteractions} and
 * the other session-scoped owners.
 *
 * A session is one per workspace storage root, built and held by the
 * process's session owner (the `Sessions` map behind `openSessionEffect` in
 * `sessionGraph.ts`): the extension and the CLI open one over the roots their
 * composition root built, the desktop one per project, the SDK one per
 * platform. That module also owns the process-default session
 * (`initializeDefaultSession` / `tryDefaultSession`). There is no other way to
 * reach these owners:
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
  Exit,
  Option,
  type Scope,
  Stream,
  SubscriptionRef,
} from 'effect';

import type { AgentEvent, AgentTrace, ResultEvent } from '@agent/trace';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import { finalizeRun } from '@agent/storage/runLifecycle';
import type { ResponseTextProcessing } from '@latex/texraResponseTextProcessing';
import { withLogChannel } from '@logger/effectLog';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import {
  TEXRA_APPROVAL_POLICY_DEFAULT,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import {
  aggregateId as qualifyAggregateId,
  aggregateTarget,
  interruptedWorkflowCall,
  RUN_OUTCOME,
  type AggregateId,
  type ApprovalPolicySnapshot,
  type CommitOrdinal,
  type PermissionPayload,
  type RequestDecision,
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
import type { RunLedgerDraft } from '@shared/session/runStateFold';
import { foldRunRows, type QueuedFollowUp } from '@shared/session/runRows';
import type {
  Append,
  OpenWork,
  SessionEventReads,
} from '@shared/session/sessionEvents';
import { aggregateError } from '@utils/core';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import {
  SessionHostInteractions,
  type HostInteractions,
} from './HostInteractions';
import { redactedForFact } from './loop/rows';
import { runEventDraft } from './SessionEvents';
import { heldSessions, type SessionGraph } from './sessionGraph';
import { WorkflowControlRegistry } from './workflowControlRegistry';
import { createNeutralResponseTextProcessing } from './responseTextProcessing';
import type { SessionApprovals } from './runApprovalQueue';
import type { RunRegistry } from './runRegistry';
import type { ModelRetryGate } from './ModelRetryGate';

const CHANNEL = 'sessionHandle';

/**
 * Facts a run had queued did not commit before its lease ended: the artifact
 * drain (`settlePublications`, which settles the ordered publisher), the
 * post-drain step, or the settle after them failed, so those rows were rolled
 * back. Deliberately distinct from a claim or lease-file release that failed,
 * which happens once every fact is already committed and leaves the record
 * whole: only a drain failure can leave a caller journaling work whose rows
 * are gone, so the two are told apart by identity rather than by message.
 */
export class RunArtifactDrainError extends Error {
  constructor(
    readonly runId: RunId,
    cause: unknown,
  ) {
    super(
      `Run ${runId}: the facts it queued did not commit before its lease ended.`,
      { cause },
    );
    this.name = 'RunArtifactDrainError';
  }
}

/**
 * One publication and the run whose fact it carries, so a settle can answer
 * for one run's facts rather than for whatever the session happened to have
 * queued. `runId` is `null` for a fact no single run owns: every settle
 * answers for those.
 *
 * A publication that committed is dropped from the tracked set; one that was
 * refused stays, carrying its squashed cause in `refusal`, until the drain
 * that answers for its run reports it. An absent `refusal` therefore means
 * "still on the publisher", which only a publication enqueued after a drain's
 * barrier can be: the plane's own settle is what waits for the cohort. The
 * cause is boxed rather than held bare so that a defect whose value is
 * `undefined` is still a refusal here, never an in-flight publication.
 */
interface TrackedPublication {
  readonly runId: RunId | null;
  refusal?: { readonly cause: unknown };
}

/** The run one published batch belongs to, read off the aggregates it
 *  targets; `null` when the batch is not one run's (a session-scoped fact,
 *  or a batch spanning runs, which no run may be failed for alone — an
 *  author with a batch of that shape whose refusal someone must hear commits
 *  it through {@link SessionHandle.commit} instead, as the registry's
 *  `run.detach` batch does). */
function draftedRun(events: readonly SessionEventDraft[]): RunId | null {
  let runId: RunId | null = null;
  for (const event of events) {
    const target = aggregateTarget(event.aggregateId);
    if (target.kind !== 'run') return null;
    if (runId !== null && runId !== target.id) return null;
    runId = target.id;
  }
  return runId;
}

/**
 * What opening a session supplies (`openSessionEffect`): persistence mode and
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
  /** The run ledger over this session's event plane, provided to each run's
   *  program at the `executeAgent` boundary. */
  readonly ledger: SessionGraph['ledger'];
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
  /** Session-owned follow-up queue owner. */
  readonly followUps: ToolUseFollowUpQueue;
  private readonly graph: SessionGraph;
  private disposed = false;
  private readonly publications = new Set<TrackedPublication>();
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
   * Built by the session owner in the session's scope, so its probe fibers
   * and waiting calls end with the session rather than through this store.
   */
  readonly modelRetries: ModelRetryGate;
  /** Host policy for provider-output cleanup and continuation joining. */
  readonly responseTextProcessing: ResponseTextProcessing;
  /**
   * Session-owned bridge from a workflow-script grandchild's run id to
   * its run's engine skip/retry control. Populated by the workflow-script
   * strategy while a run is in flight; a host (the CLI child list) consumes it
   * to skip/retry a focused grandchild `agent()` call.
   */
  readonly workflowControls: WorkflowControlRegistry;
  /**
   * Built by the session owner alone (`sessionLayer.ts`), inside the root's
   * graph, with that graph handed over as a function of the session: the
   * request handler admits on the session, so the graph is bound to the
   * handle it serves. Every other caller opens through `openSessionEffect`.
   */
  constructor(
    init: SessionHandleInit &
      Pick<SessionHandle, 'modelRetries'> & {
        readonly graph: (session: SessionHandle) => SessionGraph;
      },
  ) {
    // Forced dependency order, every cross-reference explicit — never let a
    // member fall back to a neighboring module singleton (silent-state-split).
    this.roots = init.roots;
    // Built before the graph: the session's approvals are built over it, and
    // announce every effective bypass change through it.
    this.interactions = new SessionHostInteractions();
    const graph = init.graph(this);
    this.graph = graph;
    this.approvals = graph.requests.approvals;
    this.events = graph.events;
    this.ledger = graph.ledger;
    this.view = graph.view;
    this.viewChanges = graph.viewChanges;
    this.storeMovedAside = graph.storeMovedAside;
    this.folded = graph.folded;
    this.requests = graph.requests;
    this.inputs = graph.inputs;
    this.subscriptions = graph.subscriptions;
    this.runs = graph.runs;
    this.followUps = new ToolUseFollowUpQueue({
      exclusive: (job) => graph.exclusive(job),
      detach: (job) => graph.detach(() => job),
      pending: (runId) => this.pendingFollowUps(runId),
      rows: (runId) => graph.aggregateRows(qualifyAggregateId('run', runId)),
      acquireClaim: (runId) =>
        this.acquireClaims(qualifyAggregateId('run', runId)),
    });
    this.modelRetries = init.modelRetries;
    this.responseTextProcessing =
      init.responseTextProcessing ?? createNeutralResponseTextProcessing();
    this.workflowControls = new WorkflowControlRegistry();
  }

  /**
   * Shut this session's doors: from here on a detached publication, a
   * transcript subscription and a request's cancellation write nothing, and
   * no result listener hears another row. The session layer runs it as the
   * last of the session entry's own finalizers, after every owner above has
   * unwound, so a fact those owners publish on the way out still lands.
   */
  closeDoors(): void {
    this.disposed = true;
    this.resultListeners.clear();
  }

  /** Live host-neutral approval policy for executable requests. */
  get approvalPolicy(): TexraApprovalPolicy {
    return this.texraApprovalPolicy;
  }

  setApprovalPolicy(policy: TexraApprovalPolicy): void {
    if (policy === this.texraApprovalPolicy) return;
    this.texraApprovalPolicy = policy;
    // The view includes other processes' runs from the project database.
    // Publish only for runs this session owns; a future launch stamps its
    // initial snapshot from the current policy on `run.start`.
    for (const runId of this.runs.activeIds()) {
      this.publishApprovalPolicy(runId);
    }
  }

  /**
   * One run's full approval-policy snapshot: the policy this session holds
   * plus the bypass values its approval queues own. The launcher stamps it on
   * `run.start` as the initial snapshot; every later change is published
   * through {@link publishApprovalPolicy}. Never a toggle delta.
   */
  approvalPolicySnapshotFor(runId: RunId): ApprovalPolicySnapshot {
    return {
      policy: this.texraApprovalPolicy,
      bypasses: this.approvals.bypassesFor(runId),
    };
  }

  /**
   * The one emitter of `approval.policy` (PRD one-fold-three-renderers,
   * section 6, item 2), for a change after the run's `run.start`. The session
   * layer binds it as the approval state's `onPolicyChanged` when it builds
   * this session's {@link requests}, which is the other caller.
   */
  publishApprovalPolicy(runId: RunId): void {
    if (this.disposed) return;
    const snapshot = this.approvalPolicySnapshotFor(runId);
    this.detachPublication(runId, (append) =>
      Effect.gen({ self: this }, function* () {
        // Check the claim in publication order: a provisional handle does
        // not yet own a run, while a registration queued before this does.
        if (!(yield* this.graph.ownsRun(runId))) return;
        yield* append([
          {
            type: 'approval.policy',
            aggregateId: qualifyAggregateId('run', runId),
            snapshot,
          },
        ]);
      }),
    );
  }

  /**
   * Commit one run's ending: settle the facts it queued, run its terminal
   * step, settle what that step published. The terminal step runs whether or
   * not the first settle rejected, and hears which it was: it is where the
   * run's terminal row is written, and a run whose claim ends with no
   * terminal row reads back as merely interrupted — the one classification a
   * shutdown must not leave behind. A failed settle is what that row carries
   * (the `artifact-drain` marker), and it is still the error this call
   * reports once the row has landed, as a {@link RunArtifactDrainError}, so a
   * caller can tell rolled-back facts from a step that failed afterwards.
   *
   * It releases nothing: the run's claim is its driver's hold
   * ({@link holdRunClaim}), released when the driver's scope closes, after
   * this has run.
   */
  commitRunEnd(
    runId: RunId,
    terminal: (
      drainFailure: Error | undefined,
    ) => Effect.Effect<void, Error> = () => Effect.void,
  ): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      const drained = yield* Effect.exit(
        this.settlePublications(runId).pipe(
          // A refused append keeps its own identity: it says this process no
          // longer holds the run's claim, and the callers that treat shutdown
          // contention as expected read that type.
          Effect.mapError((cause) =>
            cause instanceof DatabaseNotOwner
              ? cause
              : new RunArtifactDrainError(runId, cause),
          ),
        ),
      );
      const ended = yield* Effect.exit(
        terminal(
          Exit.isFailure(drained)
            ? ensureError(Cause.squash(drained.cause))
            : undefined,
        ),
      );
      // Settle whatever the terminal step published, so the claim's release
      // after this never overtakes it.
      const published = yield* Effect.exit(
        this.settlePublications(runId).pipe(
          Effect.mapError((cause) => new RunArtifactDrainError(runId, cause)),
        ),
      );
      const failures = [drained, ended, published].flatMap((exit) =>
        Exit.isFailure(exit) ? [Cause.squash(exit.cause)] : [],
      );
      const primary = failures.shift();
      for (const error of failures)
        yield* Effect.logWarning(`Run ${runId}: its ending also failed`).pipe(
          Effect.annotateLogs({ data: error }),
          withLogChannel(CHANNEL),
        );
      if (primary !== undefined)
        return yield* Effect.fail(ensureError(primary));
    });
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
   *  a run's before resume reads or mutations, a workflow checkpoint's
   *  before a relaunch journals into it. */
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
   * Terminal result listeners consume committed table rows, including run
   * usage and agent identity. Cleared when the session unwinds.
   */
  private readonly resultListeners = new Set<
    (event: ResultEvent) => Effect.Effect<void>
  >();

  /**
   * Subscribe to the `run.end` rows of this session's runs, each delivered
   * once the view has folded it, so a listener that reads the run's view
   * (its parent, its status) reads the state the row produced. Hosts hold
   * the session, so this is how they receive a run's outcome — per-run
   * traces are created inside the run and are not reachable from the host
   * otherwise.
   */
  onResult(listener: (event: ResultEvent) => Effect.Effect<void>): () => void {
    this.resultListeners.add(listener);
    return () => {
      this.resultListeners.delete(listener);
    };
  }

  /**
   * Bridge a run's trace into this session's event plane: every durable
   * trace event becomes the fact of its arm on the stream's aggregate, and
   * the recorder's status port hears every canonical `status` fact in
   * transcript order. Returns a detach disposer the run bundles into its
   * trace teardown.
   */
  attachRunTrace(trace: AgentTrace, runId: RunId): () => void {
    return trace.subscribe((event) => this.publishRunEvent(runId, event));
  }

  /**
   * Publish one run-scoped trace event as its durable arm (`runEventDraft`);
   * a trace event with no arm goes nowhere. Used by `attachRunTrace` (the
   * live per-run trace subscription above) and by the few places that
   * publish a trace fact for a run whose own trace is already gone.
   */
  publishRunEvent(runId: RunId, event: AgentEvent): void {
    if (this.disposed) return;
    if (event.type === 'stream.chunk') {
      const { text } = event;
      this.detachPublication(runId, () =>
        this.graph.publishText(runId, event.id, text),
      );
      return;
    }
    // The call fixes the row's place in the publication order; the job
    // builds the draft when it runs.
    this.detachPublication(runId, (append) =>
      this.runEventPublication(runId, event, append),
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
   * The final-text facts that close every streaming row still open for
   * `runId`: the loop commits them in the batch that parks the run (its
   * `waiting` step), so a parked transcript never streams. The open ids are
   * the publisher's, kept as it commits, not the view's: the view folds a
   * run's transcript only while some port subscribes it, and a run parks
   * whether or not one does. Read after this run's publications settled, or
   * inside a publisher job, so every `stream.start` before it is counted.
   */
  streamClosureFacts(
    runId: RunId,
  ): Extract<RunLedgerDraft, { type: 'stream.end' }>[] {
    return this.openWork(runId).flatMap(({ kind, id }) =>
      kind === 'stream'
        ? [
            {
              type: 'stream.end' as const,
              aggregateId: qualifyAggregateId('run', runId),
              id,
              finalText: this.graph.readText(runId, id),
            },
          ]
        : [],
    );
  }

  /** What the publisher holds open on `runId` (`SessionEvents.openWork`):
   *  what the host exit closes. Read after this run's publications settled. */
  openWork(runId: RunId): readonly OpenWork[] {
    return this.events.openWork(qualifyAggregateId('run', runId));
  }

  /** The run's pending follow-ups, in commit order
   *  (`SessionEvents.pendingFollowUps`). */
  pendingFollowUps(runId: RunId): readonly QueuedFollowUp[] {
    return this.events.pendingFollowUps(qualifyAggregateId('run', runId));
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
   * one door for a request outside the loop's own batches (a command, an
   * edit, a plan, a delegation, a question); a loop-owned request commits
   * its row with its recovery binding through the ledger and waits with
   * {@link decisionFor} directly. An interruption anywhere in the call (the
   * run stopped, the session unwound) closes the request as cancelled, so a
   * pending set is never left behind in the fold; a cancel for a request
   * this call never opened writes nothing.
   *
   * This call is also the one place that knows whether the open committed,
   * so it owns `onNeverCommitted`: whatever the caller staged for a request
   * the fold never listed is released from here, and from nowhere else.
   */
  openRequest(
    runId: RunId,
    payload: PermissionPayload,
    options: {
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
  ): Effect.Effect<RequestDecision, DatabaseNotOwner | DatabaseWriteFailed> {
    const requestId = payload.data.requestId;
    const aggregateId = qualifyAggregateId('run', runId);
    const releaseUncommitted = Effect.uninterruptible(
      options.onNeverCommitted ?? Effect.void,
    );
    return Effect.gen({ self: this }, function* () {
      const from = this.now();
      yield* this.commit([
        {
          type: 'request.opened',
          aggregateId,
          requestId,
          payload: redactedForFact(payload),
          thread: options.thread ?? null,
        },
      ]).pipe(Effect.tapError(() => releaseUncommitted));
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
          this.detachPublication(runId, (append) =>
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
   * a registry's roster change, a policy snapshot. The batch takes its
   * place in the graph's one publication order at this call and commits in
   * that order; {@link settlePublications} waits for it. Durable subscribers
   * read committed facts from the table tail; publication never delivers
   * payloads directly. A publish after teardown goes nowhere: the session's
   * owners have unwound and a late fact has no reader.
   */
  publish(events: readonly SessionEventDraft[]): void {
    if (this.disposed || events.length === 0) return;
    this.detachPublication(draftedRun(events), (append) => append(events));
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

  /** Private record reads (`run.record`, `run.report`, ...) read the database's latest row of each type, never the display fold. */
  readRunRecords(
    runId: RunId,
  ): Effect.Effect<readonly SessionEvent[], DatabaseReadFailed> {
    return this.graph.runRecords(runId);
  }

  /** Every committed row of one aggregate, private rows included, for the
   *  readers that fold a keyed record or a journal over the whole aggregate. */
  readAggregate(
    id: AggregateId,
  ): Effect.Effect<readonly SessionEvent[], DatabaseReadFailed> {
    return this.graph.aggregateRows(id);
  }

  /** The run aggregate's committed rows; empty when the run never existed
   *  or is tombstoned. */
  readRunEvents(
    runId: RunId,
  ): Effect.Effect<readonly SessionEvent[], DatabaseReadFailed> {
    return this.graph
      .aggregateRows(qualifyAggregateId('run', runId))
      .pipe(
        Effect.map((events) =>
          events.at(-1)?.type === 'run.removed' ? [] : events,
        ),
      );
  }

  readRecordListing(): Effect.Effect<
    readonly SessionEvent[],
    DatabaseReadFailed
  > {
    return this.graph.recordListing();
  }

  /**
   * Enqueue one publication on the graph's publisher, tagged with the run
   * whose fact it carries. The publisher fixes the commit order; this
   * remembers who the fact belongs to, so a drain can answer for one run's
   * facts rather than for whatever the session happened to have queued. A
   * refused batch wrote nothing and is never retried here (D6 b, R7): the
   * cause is logged as itself and kept in the publication's `refusal` for the
   * settle that answers for it, and the job itself returns quietly so the
   * publisher's own settle stays a barrier rather than a second reporter.
   */
  private detachPublication(
    runId: RunId | null,
    job: (
      append: Append,
    ) => Effect.Effect<
      unknown,
      DatabaseNotOwner | DatabaseReadFailed | DatabaseWriteFailed
    >,
  ): void {
    const publication: TrackedPublication = { runId };
    this.publications.add(publication);
    this.graph.detach((append) =>
      job(append).pipe(
        Effect.tapCause((cause) =>
          Effect.logError('Session publication failed').pipe(
            Effect.annotateLogs({ data: cause }),
            withLogChannel(CHANNEL),
            Effect.ignoreCause,
          ),
        ),
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            // A committed publication is done with; a failed one is a fact
            // this run queued and lost, and the drain that decides its run's
            // terminal row is what has to hear it. A fire-and-forget
            // publication fails on its own schedule, so dropping it here
            // would leave a drain that arrives later reading an empty set
            // and writing a COMPLETED row with no `artifact-drain` marker. It
            // stays tracked until a drain that answers for it reports it
            // ({@link settlePublications}).
            if (Exit.isSuccess(exit)) this.publications.delete(publication);
            else publication.refusal = { cause: Cause.squash(exit.cause) };
          }),
        ),
        Effect.asVoid,
      ),
    );
  }

  /** Await every detached publication enqueued so far and the view's fold
   *  of what they committed, then report the failures nobody has heard yet.
   *  A refused batch wrote nothing and is never retried (D6 b, R7):
   *  `DatabaseNotOwner` says this process no longer holds the aggregate and
   *  `DatabaseWriteFailed` says the transaction rolled back. Failures belong
   *  to the tracked entries, not a session-wide leftover array a later
   *  settler would drain: a failed publication stays in the tracked set,
   *  carrying its cause, until the drain that answers for it takes it out.
   *
   *  Every publication settles whoever asks, but a run id narrows whose
   *  rollback the caller hears: that run's own facts only — never a sibling
   *  run's, and never a session-scoped fact (an inquiry thread update, say),
   *  which no run's terminal outcome may absorb. A run's terminal outcome is
   *  decided by this settle, and another owner's lost fact is that owner's
   *  outcome, not this one's. Session-scoped failures are heard by a
   *  session-wide settle (no run id).
   *
   *  A session-wide settle is the session's own drain, not a drain of every
   *  run at once: it awaits every publication — callers queue an operation and
   *  wait on it as a barrier (`createChildRun`, a workflow checkpoint's
   *  journal write) — and reports the session-scoped failures only. A run's
   *  lost fact is that run's outcome to carry, and a barrier that reported it
   *  would fail a child creation, or a journal entry that committed, over
   *  another run's rollback. Whoever hears a failure is who clears it, so a
   *  run-tagged one stays tracked until that run's own drain takes it: that
   *  drain is what stamps the `artifact-drain` marker on the row it decides,
   *  and a session close settling a run past its budget settles the session
   *  before it releases each live run's lease ({@link commitRunEnd}, the terminal path every run
   *  driver takes), which would otherwise read an empty set and write an
   *  unmarked CANCELLED row that recovery would treat as repeatable.
   *
   *  `consume: false` observes instead of answering: the failures are
   *  reported and left tracked for the drain that decides the run's terminal
   *  row. That is what a mid-run barrier takes (the loop's park, `toolUse`),
   *  since ending the run over a lost fact is the loop's own failure path and
   *  the row it lands on still has to say `artifact-drain` rather than
   *  `unexpected`. */
  settlePublications(
    runId?: RunId,
    options: { readonly consume?: boolean } = {},
  ): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      // The plane's own settle is the barrier: every publication enqueued
      // before this call has run by the time it returns, and each one's
      // refusal is already recorded on its entry.
      yield* this.graph.settle;
      const reported = [...this.publications].flatMap((publication) =>
        publication.refusal !== undefined &&
        publication.runId === (runId ?? null)
          ? [{ publication, cause: publication.refusal.cause }]
          : [],
      );
      if (options.consume !== false)
        for (const { publication } of reported)
          this.publications.delete(publication);
      if (reported.length > 0)
        return yield* Effect.fail(
          ensureError(
            aggregateError(
              reported.map(({ cause }) => cause),
              'Session publication failed',
            ),
          ),
        );
    }).pipe(
      // A settle that cannot complete (the plane's consumer stopped) is a
      // settle that failed: its caller decides the run's terminal row on it
      // (the `artifact-drain` marker), so it is a typed failure here, never a
      // defect that ends the caller before that row is written. Interruption
      // still propagates.
      Effect.catchDefect((defect) =>
        Effect.logWarning('Session publications could not be settled').pipe(
          Effect.annotateLogs({ data: defect }),
          withLogChannel(CHANNEL),
          Effect.andThen(Effect.fail(ensureError(defect))),
        ),
      ),
    );
  }

  /**
   * One row of the fold-gated tail ({@link folded}, PRD 7.2): the result
   * listeners and the registry's folded-stop child sweep, which is why
   * neither is on the raw tail above. Both read the run's view
   * synchronously, so a notification ahead of the fold would hand them the
   * state the row just replaced.
   */
  receiveFoldedEvent(event: SessionEvent): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      // The sweep and host notifications belong to the authoring process.
      const { self } = yield* SubscriptionRef.get(this.graph.local);
      if (event.ownerId == null || !self.includes(event.ownerId)) return;
      const target = aggregateTarget(event.aggregateId);
      if (target.kind !== 'run' || event.type !== 'run.end') return;
      // A throwing listener is logged and never stops the ones after it.
      yield* Effect.forEach(
        [...this.resultListeners],
        (listener) =>
          Effect.suspend(() => listener({ ...event, runId: target.id })).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning('Session result listener threw').pipe(
                Effect.annotateLogs({ data: Cause.squash(cause) }),
                withLogChannel(CHANNEL),
              ),
            ),
          ),
        { discard: true },
      );
      this.runs.sweepChildrenOfFoldedStop(target.id);
    });
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
}
