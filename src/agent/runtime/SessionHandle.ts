/**
 * `SessionHandle` — one owner per session for the runtime's coordination state.
 *
 * It is a **composition record**, not a facade: it re-exposes no per-concern
 * methods, so callers address each owner directly
 * (`session.interactions.x(...)`, `session.runs.y(...)`). It has no
 * readiness gate: a restored session is usable the moment it is constructed,
 * and what a stream with no live flow context in this process is gets decided
 * by the fold's `readOnly` and `group` rules over the session's view, never
 * by a boot pass. It composes {@link RunRegistry},
 * {@link SessionHostInteractions}, and the other session-scoped owners.
 *
 * A session is one per workspace storage root, built and held by the
 * process's session owner (the `Sessions` map behind `openSession`): the
 * extension and the CLI open one over the process roots, the desktop one
 * per paper, the SDK one per platform. The default instance is installed
 * explicitly through {@link initializeDefaultSession}; {@link defaultSession}
 * only retrieves that process-wide owner. There is no other way to reach
 * these owners: the invariant is "no session-scoped mutable module export"
 * (#7694) — a run-scoped caller resolves through {@link currentSession} /
 * {@link defaultSession}, never a standalone singleton import.
 *
 * Fresh construction is in FORCED dependency order with every cross-reference
 * explicit: no member is ever allowed to default to a neighboring module
 * singleton (the "silent state split" trap — a fresh member quietly sharing a
 * singleton would leak cross-session `clearAll` sweeps). The
 * fresh-ctor test in `SessionHandle.vitest.ts` locks this.
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
  Semaphore,
  Stream,
  SubscriptionRef,
} from 'effect';

import type { AgentEvent, AgentTrace, ResultEvent } from '@agent/trace';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import {
  ownsRunLease,
  releaseOwnedRunLease,
  validateOwnedRunLease,
} from '@agent/storage/runLease';
import { finalizeRun } from '@agent/storage/runLifecycle';
import type { ResponseTextProcessing } from '@latex/texraResponseTextProcessing';
import { createLog, isDebugModeEnabled } from '@logger/logUtils';
import { redactSecrets } from '@logger/redaction';
import { DisposableStore } from '@platform/disposable';
import { effectRuntime } from '@platform/processRuntime';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import {
  TEXRA_APPROVAL_POLICY_DEFAULT,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import {
  aggregateId as qualifyAggregateId,
  aggregateTarget,
  interruptedWorkflowCall,
  isTranscriptEvent,
  RUN_OUTCOME,
  type AggregateId,
  type ApprovalPolicySnapshot,
  type CommitOrdinal,
  type PermissionPayload,
  type RequestDecision,
  type RunId,
  type SessionEvent,
  type SessionEventDraft,
  type TranscriptSubscription,
} from '@shared/schemas';
import type {
  DatabaseNotOwner,
  DatabaseWriteFailed,
} from '@shared/session/database';
import { fold } from '@shared/session/sessionFold';
import {
  emptySessionView,
  type RunView,
  type SessionView,
} from '@shared/session/sessionView';
import type { RunLedgerDraft } from '@shared/session/runStateFold';
import type { SessionEventsShape } from '@shared/session/sessionEvents';
import {
  isRunningGroupEntry,
  isRunningStreamingTextEntry,
  nonterminalWorkflowCall,
} from '@shared/session/traceEntries';
import type {
  StreamLogStore,
  StreamLogStoreMode,
} from '@transcript/StreamLogStore';
import { throwAggregated } from '@utils/core';
import { ensureError } from '@utils/errors/errorMessage';
import {
  getRunContextSession,
  runInSession,
  tryUseRunContext,
} from './RunContext';
import { RunRegistry } from './runRegistry';
import {
  SessionHostInteractions,
  type HostInteractions,
} from './HostInteractions';
import { redactedForFact } from './loop/rows';
import { runEventDraft } from './SessionEvents';
import {
  defaultRootSession,
  openSession,
  type SessionGraph,
} from './sessionGraph';
import { ModelRetryGate } from './ModelRetryGate';
import {
  createSessionApprovals,
  type SessionApprovals,
} from './runApprovalQueue';
import { WorkflowControlRegistry } from './workflowControlRegistry';
import { createNeutralResponseTextProcessing } from './responseTextProcessing';

const logger = createLog('sessionHandle');

/**
 * What opening a session supplies (`openSession`): persistence mode and
 * host-owned policies. The graph constructs its store over its event
 * database. `interactions` is a presentation host the session is born with,
 * attached for its whole life, for an opener with no later attach step of its
 * own.
 *
 * `events` is deliberately absent: the event plane is the session's graph,
 * built by the session owner per workspace root, so a separately-injected
 * plane could not silently drop every fact of a session onto a plane nobody
 * reads. The session co-constructs it.
 */
export type SessionHandleInit = Partial<
  Pick<SessionHandle, 'responseTextProcessing' | 'roots'>
> & {
  readonly interactions?: HostInteractions;
  readonly transcriptMode?: StreamLogStoreMode;
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
  /**
   * Per-run run handles: registration, lookup, change listeners, and
   * subagent lineage. Hears every phase-moving row this process committed
   * ({@link receiveFoldedEvent}), in commit order and only once the view has
   * folded it; the phase itself is the fold's (`RunView.status`), never a
   * second map here.
   */
  readonly runs: RunRegistry;
  /**
   * The session's event plane (PRD 7.1, contract C7): what a renderer reads
   * with `events.all(session.now())`. The reads only: publishing goes
   * through {@link publish}, which runs the session's ordering-sensitive
   * bookkeeping before the log moves, and nothing else can append.
   */
  readonly events: Omit<SessionEventsShape, 'publish'>;
  /**
   * The one handler of every request a surface issues to this session (PRD
   * 7.6, 8.2): an in-process surface runs it on the process runtime
   * (`effectRuntime()`) and reads the Effect's own result as the response.
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
  /** Session-owned transcript store for run traces launched in this session. */
  readonly transcripts: StreamLogStore;
  /**
   * The workspace this session works on: the four per-workspace host roots.
   * Runs and `runInSession` scopes resolve `StorageFS`/`WorkspaceFS` and the
   * workspace config/state through these, so several sessions in one process
   * each write under their own folder.
   */
  readonly roots: WorkspaceRoots;
  /** Session-owned follow-up queue owner. */
  readonly followUps: ToolUseFollowUpQueue;
  private readonly graph: SessionGraph;
  private disposed = false;
  private readonly publicationGate = Semaphore.makeUnsafe(1);
  private readonly publications = new Set<
    Promise<Exit.Exit<unknown, DatabaseNotOwner | DatabaseWriteFailed>>
  >();
  /** Session-scoped host interaction owner. */
  readonly interactions: SessionHostInteractions;
  /** Session-owned approval queues, pending registries, and bypass state. */
  readonly approvals: SessionApprovals;
  private texraApprovalPolicy = TEXRA_APPROVAL_POLICY_DEFAULT;
  /** Coordinates recovery probes for model routes shared by parallel runs. */
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
  /** LIFO owner for the session's constructor-registered teardown. */
  private readonly teardown = new DisposableStore();
  /**
   * Built by the session owner alone (`sessionLayer.ts`), inside the root's
   * graph, with that graph handed over as a function of the session: the
   * request handler admits on the session, so the graph is bound to the
   * handle it serves. Every other caller opens through `openSession`.
   */
  constructor(
    init: SessionHandleInit &
      Pick<SessionHandle, 'transcripts'> & {
        readonly roots: WorkspaceRoots;
        readonly graph: (session: SessionHandle) => SessionGraph;
      },
  ) {
    // Forced dependency order, every cross-reference explicit — never let a
    // member fall back to a neighboring module singleton (silent-state-split).
    this.transcripts = init.transcripts;
    this.roots = init.roots;
    const graph = init.graph(this);
    this.graph = graph;
    this.events = graph.events;
    this.ledger = graph.ledger;
    this.view = graph.view;
    this.viewChanges = graph.viewChanges;
    this.folded = graph.folded;
    this.requests = graph.requests;
    this.inputs = graph.inputs;
    this.subscriptions = graph.subscriptions;
    this.followUps = new ToolUseFollowUpQueue();
    const interactions = new SessionHostInteractions();
    // The approval authority publishes a stream's full policy snapshot on
    // every effective bypass change; `setApprovalPolicy` below publishes the
    // same snapshot when the policy half moves.
    const approvals = createSessionApprovals(interactions, (runId) =>
      this.publishApprovalPolicy(runId),
    );
    this.runs = new RunRegistry({
      runView: (runId) => this.runView(runId),
      publish: (events) => this.publish(events),
      approvals,
      finalizeRun: (input) => finalizeRun(this, input),
      releaseRootRunLease: (runId) => this.releaseRunLease(runId),
    });

    this.interactions = interactions;
    this.approvals = approvals;
    this.modelRetries = new ModelRetryGate();
    this.responseTextProcessing =
      init.responseTextProcessing ?? createNeutralResponseTextProcessing();
    this.workflowControls = new WorkflowControlRegistry();
    if (init.interactions) this.interactions.use(init.interactions);
    liveSessions.add(this);
    // Register teardown in reverse LIFO order so `teardown.dispose()` runs the
    // session's shutdown sequence top-to-bottom: drain traces, then unwind
    // each owner in dependency order, finally leaving `liveSessions`.
    this.teardown.add(() => {
      liveSessions.delete(this);
    });
    // The graph outlives every publisher above it: the owner releases it
    // after this store has run, so a late fact still lands in the log until
    // the last owner has unwound.
    this.teardown.add(() => {
      this.disposed = true;
    });
    this.teardown.add(() => this.resultListeners.clear());
    this.teardown.add(() => this.interactions.dispose());
    this.teardown.add(() => this.modelRetries.dispose());
    // Drop bypass state before the interaction slot settles pending approvals.
    this.teardown.add(() => this.approvals.clearAll());
    this.teardown.add(() => this.runs.dispose());
    this.teardown.add(() => this.followUps.dispose());
  }

  /** Live host-neutral approval policy for executable requests. */
  get approvalPolicy(): TexraApprovalPolicy {
    return this.texraApprovalPolicy;
  }

  setApprovalPolicy(policy: TexraApprovalPolicy): void {
    if (policy === this.texraApprovalPolicy) return;
    this.texraApprovalPolicy = policy;
    // The policy is session-wide; the snapshot is per run, so every stream
    // the view holds (the ones whose `run.start` has folded: the existence
    // rule, PRD 5.2) gets its own `approval.policy`. A reservation still
    // short of its `run.start` is not in the view: its launcher stamps the
    // initial snapshot, read from this new value, on that event instead.
    for (const runId of SubscriptionRef.getUnsafe(this.view).runs.keys()) {
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
   * section 6, item 2), for a change after the run's `run.start`.
   */
  private publishApprovalPolicy(runId: RunId): void {
    this.publish([
      {
        type: 'approval.policy',
        aggregateId: qualifyAggregateId('run', runId),
        snapshot: this.approvalPolicySnapshotFor(runId),
      },
    ]);
  }

  /**
   * End ownership of one run after the facts it queued have committed.
   * An optional post-drain operation publishes lifecycle state that belongs
   * after those facts; it runs before the claim is unlinked.
   * The claim is unlinked whatever the drain did: resumability is the
   * checkpoint, so a failed flush is logged and rethrown but never changes
   * who owns the run. A release failure never masks a drain failure: the
   * drain's error is the one the caller sees, and the release's is logged.
   * This is the one exit choreography every run driver calls.
   */
  releaseRunLease(
    runId: RunId,
    afterArtifactsDrained: Effect.Effect<void, Error> = Effect.void,
  ): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      const drained = yield* Effect.exit(
        Effect.gen({ self: this }, function* () {
          yield* Effect.tryPromise({
            try: () =>
              runInSession(this, async () => {
                await validateOwnedRunLease(runId);
                await this.flushArtifacts();
              }),
            catch: ensureError,
          });
          yield* afterArtifactsDrained;
        }),
      );
      // Settle whatever the drain did. When the drain rejected
      // (including in `validateOwnedExecutionLease`), the post-drain step
      // never ran, and this settle still stops claim release from overtaking
      // facts the owner already queued. On success it also covers the facts
      // `afterArtifactsDrained` published.
      const published = yield* Effect.exit(
        Effect.tryPromise({
          try: () => this.settlePublications(),
          catch: ensureError,
        }),
      );
      const claimRelease = yield* Effect.exit(
        this.releaseClaims(qualifyAggregateId('run', runId)),
      );
      const fileRelease = yield* Effect.exit(
        Effect.tryPromise({
          try: () => runInSession(this, () => releaseOwnedRunLease(runId)),
          catch: ensureError,
        }),
      );
      const failures = [drained, published, claimRelease, fileRelease].flatMap(
        (exit) => (Exit.isFailure(exit) ? [Cause.squash(exit.cause)] : []),
      );
      const primary = failures.shift();
      for (const error of failures)
        logger.warn(`Run ${runId}: lease release also failed`, {
          data: error,
        });
      if (primary !== undefined)
        return yield* Effect.fail(ensureError(primary));
    });
  }

  /** Admit an aggregate's existing claim before this process appends to it:
   *  a run's before resume reads or mutations, a workflow checkpoint's
   *  before a relaunch journals into it. */
  acquireClaims(
    id: AggregateId,
  ): Effect.Effect<Effect.Effect<void, Error>, Error> {
    return this.graph.acquireClaims(id).pipe(
      Effect.map((release) =>
        release.pipe(
          Effect.catchCause((cause) =>
            Effect.fail(ensureError(Cause.squash(cause))),
          ),
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.fail(ensureError(Cause.squash(cause))),
      ),
    );
  }

  /** Drop this process's claim on one aggregate, so the next process resumes
   *  it instead of reading a live owner: a run's when its lease ends, a
   *  workflow checkpoint's when its invocation does. The claim belongs to the
   *  invocation, not to the process, and this is its one release. */
  releaseClaims(id: AggregateId): Effect.Effect<void, Error> {
    return this.graph
      .releaseClaims(id)
      .pipe(
        Effect.catchCause((cause) =>
          Effect.fail(ensureError(Cause.squash(cause))),
        ),
      );
  }

  /**
   * The host-facing name for "everything this session owes storage has
   * landed": a session's durable artifacts are the facts it publishes, so
   * this is exactly {@link settlePublications}. Hosts call it on shutdown and
   * every run driver reaches it through {@link releaseRunLease}.
   */
  flushArtifacts(): Promise<void> {
    return this.settlePublications();
  }

  /**
   * Terminal result listeners consume committed table rows, including run
   * usage and agent identity. Cleared when the session unwinds.
   */
  private readonly resultListeners = new Set<(event: ResultEvent) => void>();

  /**
   * Subscribe to the `run.end` rows of this session's runs, as they commit.
   * Hosts hold the session, so this is how they receive a run's outcome —
   * per-run traces are created inside the run and are not reachable from the
   * host otherwise.
   */
  onResult(listener: (event: ResultEvent) => void): () => void {
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
      this.schedulePublication(
        this.graph.publishText(runId, event.id, redactSecrets(event.text)),
      );
      return;
    }
    this.schedulePublication(
      Effect.suspend(() => {
        const draft = runEventDraft(
          runId,
          event.type === 'stream.end'
            ? {
                ...event,
                finalText:
                  event.finalText ?? this.graph.readText(runId, event.id),
              }
            : event,
        );
        return draft === null
          ? Effect.void
          : this.graph.publish([
              isTranscriptEvent(draft)
                ? { ...draft, transcriptDebug: isDebugModeEnabled() }
                : draft,
            ]);
      }),
    );
  }

  /**
   * The final-text facts that close every streaming row still open for
   * `runId`: the loop commits them in the batch that parks the run (its
   * `waiting` step), so a parked transcript never shows a permanently
   * streaming block.
   */
  streamClosureFacts(
    runId: RunId,
  ): Extract<RunLedgerDraft, { type: 'stream.end' }>[] {
    const closure: Extract<RunLedgerDraft, { type: 'stream.end' }>[] = [];
    for (const entry of this.transcripts.get(runId)?.toJSON() ?? []) {
      if (!isRunningStreamingTextEntry(entry)) continue;
      closure.push({
        type: 'stream.end',
        aggregateId: qualifyAggregateId('run', runId),
        id: entry.id,
        finalText: this.graph.readText(runId, entry.id) ?? entry.text,
      });
    }
    return closure;
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
   * {@link decisionFor} directly. An interrupted wait (the run stopped, the
   * session unwound) closes the request as cancelled, so a pending set is
   * never left behind in the fold.
   */
  openRequest(
    runId: RunId,
    payload: PermissionPayload,
    thread: string | null = null,
  ): Effect.Effect<RequestDecision, DatabaseNotOwner | DatabaseWriteFailed> {
    const requestId = payload.data.requestId;
    const aggregateId = qualifyAggregateId('run', runId);
    return Effect.gen({ self: this }, function* () {
      const from = this.now();
      yield* this.commit([
        {
          type: 'request.opened',
          aggregateId,
          requestId,
          payload: redactedForFact(payload),
          thread,
        },
      ]);
      const decided = yield* this.decisionFor(runId, requestId, from).pipe(
        Effect.map((row) => row.decision),
        Effect.catch((cause) =>
          Effect.sync((): RequestDecision => {
            logger.warn(`Request ${requestId} closed without a decision`, {
              data: cause,
            });
            return { action: 'cancel', cause: cause.message };
          }),
        ),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            if (this.disposed) return;
            this.schedulePublication(
              this.decisionRow(runId, requestId, {
                action: 'cancel',
                cause: 'Run interrupted.',
              }),
            );
          }),
        ),
      );
      return decided;
    });
  }

  /**
   * Answer a request, if it is still open: the one writer of a decision (one
   * run model, 3.7). The check reads the committed rows and the
   * `request.decided` row lands under the same publication permit, so two
   * surfaces answering at once record exactly one decision — a run
   * aggregate takes appends from its claim holder alone, and inside this
   * process the permit orders them. `false` is that lost race, or an id
   * never opened: nothing was written and the live waiter keeps the
   * decision that was.
   */
  decideRequest(
    runId: RunId,
    requestId: string,
    decision: RequestDecision,
  ): Effect.Effect<boolean, DatabaseNotOwner | DatabaseWriteFailed> {
    return this.publicationGate.withPermit(
      this.decisionRow(runId, requestId, decision),
    );
  }

  /** {@link decideRequest} without the permit: the body the session's one
   *  publisher runs, whether a surface awaits it or an interrupted
   *  {@link openRequest} schedules it. */
  private decisionRow(
    runId: RunId,
    requestId: string,
    decision: RequestDecision,
  ): Effect.Effect<boolean, DatabaseNotOwner | DatabaseWriteFailed> {
    const aggregateId = qualifyAggregateId('run', runId);
    return Effect.gen({ self: this }, function* () {
      let open = false;
      for (const row of yield* this.graph.aggregateRows(aggregateId)) {
        if (row.type === 'request.opened' && row.requestId === requestId) {
          open = true;
        } else if (
          row.type === 'request.decided' &&
          row.requestId === requestId
        ) {
          open = false;
        }
      }
      if (!open) return false;
      yield* this.graph.publish([
        { type: 'request.decided', aggregateId, requestId, decision },
      ]);
      return true;
    });
  }

  /**
   * The one publisher of this session's facts (PRD 7.1). Durable subscribers
   * read committed facts from the table tail; publication never delivers
   * payloads directly. A publish after teardown goes
   * nowhere: the session's owners have unwound and a late fact has no reader.
   */
  publish(events: readonly SessionEventDraft[]): void {
    if (this.disposed || events.length === 0) return;
    this.schedulePublication(this.graph.publish(events));
  }

  /** Native metadata publication shares the existing ordered publisher. A
   *  refused batch wrote nothing and comes back typed (D6 b): the caller
   *  stops on it, it is never retried or converted here. */
  commit(
    events: readonly SessionEventDraft[],
  ): Effect.Effect<
    readonly SessionEvent[],
    DatabaseNotOwner | DatabaseWriteFailed
  > {
    return this.publicationGate.withPermit(this.graph.publish(events));
  }

  /** Registration owns birth claims as soon as append commits, before its
   *  tail drains. Its refusal is typed like {@link commit}'s. */
  commitRegistration(
    events: readonly SessionEventDraft[],
  ): Effect.Effect<
    readonly SessionEvent[],
    DatabaseNotOwner | DatabaseWriteFailed
  > {
    return this.publicationGate.withPermit(
      this.graph.publishRegistration(events),
    );
  }

  /** Read and append under the same local publisher permit. C5 excludes
   *  foreign writers; losing the claim between the read and the append comes
   *  back as `DatabaseNotOwner` with nothing written. */
  updateRecordFacts<A>(
    runId: RunId,
    update: (rows: readonly SessionEvent[]) => {
      readonly events: readonly SessionEventDraft[];
      readonly value: A;
    },
  ): Effect.Effect<A, DatabaseNotOwner | DatabaseWriteFailed> {
    const graph = this.graph;
    return this.publicationGate.withPermit(
      Effect.gen(function* () {
        const updateResult = update(yield* graph.runRecords(runId));
        yield* graph.publish(updateResult.events);
        return updateResult.value;
      }),
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
  readRunRecords(runId: RunId): Effect.Effect<readonly SessionEvent[]> {
    return this.graph.runRecords(runId);
  }

  readRunChildren(runId: RunId): Effect.Effect<readonly SessionEvent[]> {
    return this.graph.runChildren(runId);
  }

  /** Every committed row of one aggregate, private rows included, for the
   *  readers that fold a keyed record or a journal over the whole aggregate. */
  readAggregate(id: AggregateId): Effect.Effect<readonly SessionEvent[]> {
    return this.graph.aggregateRows(id);
  }

  readRecordListing(): Effect.Effect<readonly SessionEvent[]> {
    return this.graph.recordListing();
  }

  /**
   * Run one fire-and-forget publication under the session's ordered permit.
   * A refused batch wrote nothing and is never retried here (D6 b, R7):
   * `DatabaseNotOwner` says this process no longer holds the aggregate, and
   * `DatabaseWriteFailed` says the transaction rolled back. The whole cause
   * is logged as itself, and the Exit carries it to
   * {@link settlePublications}, which throws it at the caller waiting for
   * the session's facts to settle.
   */
  private schedulePublication(
    program: Effect.Effect<unknown, DatabaseNotOwner | DatabaseWriteFailed>,
  ): void {
    const publication = effectRuntime().runPromise(
      this.publicationGate.withPermit(program).pipe(
        Effect.tapCause((cause) =>
          Effect.sync(() => {
            logger.error('Session publication failed', { data: cause });
          }).pipe(Effect.ignoreCause),
        ),
        Effect.exit,
      ),
    );
    this.publications.add(publication);
    void publication.finally(() => {
      this.publications.delete(publication);
    });
  }

  /** Await in-flight publications. Failures belong to those Exits, not a
   *  session-wide leftover array a later settler would drain. */
  async settlePublications(): Promise<void> {
    const exits = await Promise.all([...this.publications]);
    throwAggregated(
      exits.flatMap((exit) =>
        Exit.isFailure(exit) ? [Cause.squash(exit.cause)] : [],
      ),
      'Session publication failed',
    );
  }

  /** Apply a durable fact delivered by the root's ordered table tail. */
  receiveCommittedEvent(event: SessionEvent): Effect.Effect<void> {
    return this.transcripts.acceptCommitted(event).pipe(
      Effect.andThen(
        Effect.sync(() => {
          // Host notifications belong to the authoring process.
          const { self } = SubscriptionRef.getUnsafe(this.graph.local);
          if (event.ownerId == null || !self.includes(event.ownerId)) return;

          const target = aggregateTarget(event.aggregateId);
          if (target.kind !== 'run' || event.type !== 'run.end') return;
          for (const listener of [...this.resultListeners]) {
            try {
              listener({ ...event, runId: target.id });
            } catch (error) {
              logger.warn('Session result listener threw', { data: error });
            }
          }
        }),
      ),
    );
  }

  /**
   * One row of the fold-gated tail ({@link folded}, PRD 7.2): the registry's
   * phase notification, which is why it is not on the raw tail above. A woken
   * waiter and a refreshed child roster both read `RunView.status` from the
   * view synchronously, so a notification ahead of the fold would hand them
   * the phase the row just replaced.
   */
  receiveFoldedEvent(event: SessionEvent): void {
    // Runtime waiters belong to the authoring process.
    const { self } = SubscriptionRef.getUnsafe(this.graph.local);
    if (event.ownerId == null || !self.includes(event.ownerId)) return;
    const target = aggregateTarget(event.aggregateId);
    if (target.kind !== 'run') return;
    // The rows that move a run's phase (one run model, 3.3): every
    // activation, the park and the step that leaves it, the end.
    const phaseMoved =
      event.type === 'run.activate' ||
      event.type === 'run.end' ||
      (event.type === 'flow.step' &&
        (event.payload.step === 'waiting' ||
          event.payload.step === 'turn.begin'));
    if (!phaseMoved) return;
    this.runs.handleStatus(target.id);
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
  markUnreadable(runId: RunId, detail: string): void {
    this.setUnreadable(runId, detail);
  }

  /** Drop a run's unreadable detail: a read that found it free disproved it. */
  clearUnreadable(runId: RunId): void {
    this.setUnreadable(runId, null);
  }

  private setUnreadable(runId: RunId, detail: string | null): void {
    if (this.disposed) return;
    effectRuntime().runFork(
      SubscriptionRef.update(this.graph.local, (local) => {
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

  /**
   * Unwind this session ({@link unwind}) and release it from its owner,
   * which frees the root's graph after it. A teardown failure surfaces to
   * the caller and still releases the session. Settles nothing: a host that
   * needs the session's live runs ended first closes through
   * `closeSession`, which ends here. Idempotent, so a handle released once
   * never reaches the session its owner built over the same root later.
   */
  dispose(): void {
    if (this.disposed) return;
    try {
      this.unwind();
    } finally {
      this.graph.close();
    }
  }

  /**
   * Tear down everything this session owns through the constructor-registered
   * LIFO store, once: the store aggregates each disposer's failure and still
   * runs the remaining disposers, including the final `liveSessions`
   * removal. The session owner calls this as it releases the session (a
   * `closeSession`, the runtime's disposal); {@link dispose} calls it first
   * and then asks for that release.
   */
  unwind(): void {
    this.teardown.dispose();
  }
}

/** Live sessions whose background processes must be stopped at shutdown. */
const liveSessions = new Set<SessionHandle>();

/** Visit every live session — for process-shutdown sweeps that must reach
 * session-keyed registries (e.g. the agent-CLI session stores). */
export function forEachLiveSession(
  callback: (session: SessionHandle) => void,
): void {
  for (const session of liveSessions) callback(session);
}

/**
 * Settle runs still owned when the host exits. Hosts register this as
 * their first ON-phase handler, after reachable drivers have unwound and
 * before sessions or persistence services are disposed.
 *
 * Each owned run keeps its checkpoint and receives CANCELLED unless a
 * driver has already persisted another outcome. Under the same lease, publish
 * canonical closure facts for its running transcript entries using the outcome
 * that remains authoritative. Release waits for those publications to commit.
 * A driver that writes a different outcome after this settlement remains a
 * separate lifecycle race; keepExistingOutcome only protects earlier writes.
 *
 * The caller's phase deadline bounds the drain. An expired deadline is logged
 * for each skipped run and checked again after its outcome write.
 */
export const settleLiveSessionRuns = Effect.fn('settleLiveSessionRuns')(
  function* (signal: AbortSignal) {
    const pending: { session: SessionHandle; runId: RunId }[] = [];
    forEachLiveSession((session) => {
      for (const runId of session.runs.getActiveIds()) {
        pending.push({ session, runId });
      }
    });
    for (const { session, runId } of pending) {
      if (signal.aborted) {
        logger.warn(
          `Host exit deadline passed before run ${runId} could settle`,
        );
        continue;
      }
      const settlement = Effect.gen(function* () {
        if (!runInSession(session, () => ownsRunLease(runId))) return;
        const tracked = session.runs.getHandle(runId) !== undefined;
        // Read the committed transcript once after queued publications settle.
        // Host exit needs no presentation residency or mutable writer handle.
        const transcript = yield* Effect.exit(
          Effect.gen(function* () {
            yield* Effect.tryPromise({
              try: () => session.settlePublications(),
              catch: ensureError,
            });
            return tracked ? yield* session.transcripts.readEntries(runId) : [];
          }),
        );
        yield* session.releaseRunLease(
          runId,
          Effect.gen(function* () {
            const finalization = yield* finalizeRun(session, {
              runId,
              outcome: RUN_OUTCOME.CANCELLED,
              keepExistingOutcome: true,
            });
            if (!finalization.ok) {
              throw new Error(
                `Failed to persist the CANCELLED outcome for run ${runId}`,
                { cause: finalization.error },
              );
            }
            if (signal.aborted) {
              logger.warn(
                `Host exit deadline passed after run ${runId}'s outcome was written; its transcript groups stay open`,
              );
              return;
            }
            if (!tracked) {
              logger.warn(
                `Run ${runId} was untracked while the host exit settled it; any transcript groups it left open stay open`,
              );
              return;
            }
            // A failed read must still pass through the owner's release
            // choreography after recording the terminal outcome.
            if (Exit.isFailure(transcript))
              throw Cause.squash(transcript.cause);
            // These are ordinary canonical facts. The lease owner settles their
            // publication before unlinking the claim, so replay sees the same
            // closure as the resident transcript.
            for (const entry of transcript.value) {
              if (isRunningGroupEntry(entry)) {
                session.publishRunEvent(runId, {
                  type: 'stage.end',
                  id: entry.id,
                  status: finalization.outcome,
                });
              } else if (isRunningStreamingTextEntry(entry)) {
                session.publishRunEvent(runId, {
                  type: 'stream.end',
                  id: entry.id,
                });
              } else {
                const call = nonterminalWorkflowCall(entry);
                if (call)
                  session.publishRunEvent(runId, {
                    type: 'workflow.call',
                    logId: entry.id,
                    stageId: entry.groupId,
                    call: interruptedWorkflowCall(call),
                  });
              }
            }
          }),
        );
      });
      yield* settlement.pipe(
        Effect.scoped,
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            logger.warn(
              `Failed to settle run ${runId} at host exit; a later launch classifies it from its checkpoint`,
              { data: Cause.squash(cause) },
            );
          }),
        ),
      );
    }
  },
);

let defaultSessionFallbackWarned = false;

/**
 * Open the process-default session, the session of the process roots, after
 * its transcript store is valid. Its owner holds it, as it holds every
 * session: {@link defaultSession} reads it from there on each call, so no
 * second reference to it exists to go stale when the root is closed.
 */
export function initializeDefaultSession(
  init: SessionHandleInit,
): SessionHandle {
  if (defaultRootSession()) {
    throw new Error('The default session has already been initialized.');
  }
  return openSession(init);
}

/** Inspect whether the host has installed its process-default session. */
export function tryDefaultSession(): SessionHandle | undefined {
  return defaultRootSession();
}

/** Dispose the process-default session during host teardown. */
export function teardownDefaultSession(): void {
  defaultRootSession()?.dispose();
}

/**
 * The process-default session — the sole owner of the process-wide runtime
 * singletons (#7694). Every member the constructor doesn't receive is
 * fresh-built in the same FORCED dependency order any other `SessionHandle`
 * uses, and this construction is the only place those singletons live: no
 * module-level `Shared*`/`*Service` export aliases them.
 *
 * Hosts must initialize it explicitly after opening transcript persistence.
 * Access before that composition step is a lifecycle error rather than an
 * implicit memory-only session. If another session is live, retrieval emits at
 * most one best-effort warning for the process lifetime, including across
 * teardown and reinitialization of the default session.
 */
export function defaultSession(): SessionHandle {
  const processDefault = defaultRootSession();
  if (!processDefault) {
    throw new Error(
      'The default session has not been initialized. Call initializeDefaultSession() after opening its transcript store.',
    );
  }
  if (
    !defaultSessionFallbackWarned &&
    [...liveSessions].some((session) => session !== processDefault)
  ) {
    defaultSessionFallbackWarned = true;
    try {
      logger.warn(
        'defaultSession() resolved while a non-default SessionHandle was live. Pass or propagate the owning session instead.',
      );
    } catch {
      // Diagnostics must not break the sanctioned fallback.
    }
  }
  return processDefault;
}

/**
 * Resolve the session for the calling context: the active run's session when
 * called inside a run, otherwise the process {@link defaultSession}. This is
 * the single resolution point run-scoped code (flows, tools, formatters) uses
 * to reach session-owned state — there is no other way to reach it (#7694) —
 * and the seam that lets a host inject an isolated session per run.
 */
export function currentSession(): SessionHandle {
  return getRunContextSession(tryUseRunContext()) ?? defaultSession();
}
