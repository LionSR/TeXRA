/**
 * `SessionHandle` — one owner per session for the runtime's coordination state.
 *
 * It is a **composition record**, not a facade: it re-exposes no per-concern
 * methods, so callers address each owner directly
 * (`session.interactions.x(...)`, `session.executions.y(...)`). It has no
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
 * Continuity stays in options + storage (`ValidatedExecutionRequest`). The
 * session is justified only as the ownership container.
 */

import {
  Cause,
  Effect,
  Exit,
  Semaphore,
  SubscriptionRef,
  type Stream,
} from 'effect';
import pDefer, { type DeferredPromise } from 'p-defer';

import type {
  AgentEvent,
  AgentTrace,
  ResultEvent,
  StatusEvent,
} from '@agent/trace';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import {
  ownsRunLease,
  releaseOwnedRunLease,
  validateOwnedRunLease,
} from '@agent/storage/executionLease';
import { finalizeRun } from '@agent/storage/executionLifecycle';
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
  STREAM_PHASE,
  type ApprovalPolicySnapshot,
  type CommitOrdinal,
  type RunId,
  type SessionEvent,
  type SessionEventDraft,
  type StreamTabId,
  type RunPhase,
  type TranscriptSubscription,
} from '@shared/schemas';
import type { SessionView } from '@shared/session/sessionView';
import type { SessionEventsShape } from '@shared/session/sessionEvents';
import {
  isRunningGroupEntry,
  isRunningStreamingTextEntry,
  nonterminalWorkflowCall,
} from '@shared/session/traceEntries';
import { isTerminalOutcomePhase } from '@shared/streams/streamStatus';
import type { RunLogStore, RunLogStoreMode } from '@transcript/StreamLogStore';
import { RunSnapshotStore } from '@transcript/StreamSnapshotStore';
import { throwAggregated } from '@utils/core';
import { ensureError } from '@utils/errors/errorMessage';
import {
  getRunContextSession,
  runInSession,
  tryUseRunContext,
} from './RunContext';
import { RunRegistry } from './executionRegistry';
import { RunStatusMachine } from './StreamStatusService';
import {
  SessionHostInteractions,
  type HostInteractions,
} from './HostInteractions';
import { runEventDraft, statusDraft } from './SessionEvents';
import {
  defaultRootSession,
  openSession,
  type SessionGraph,
} from './sessionGraph';
import { ModelRetryGate } from './ModelRetryGate';
import {
  createSessionApprovals,
  type SessionApprovals,
} from './streamApprovalQueue';
import { WorkflowControlRegistry } from './workflowControlRegistry';
import { createNeutralResponseTextProcessing } from './responseTextProcessing';

const logger = createLog('sessionHandle');

/**
 * What opening a session supplies (`openSession`): persistence mode and
 * host-owned policies. The graph constructs its store over its event database. `interactions` is the host the
 * session is born with, attached for its whole life, for an opener with no
 * later attach step of its own (the SDK's headless host).
 *
 * `status` and `events` are deliberately absent: the machine publishes
 * canonical `status` through the session, and the event plane is the
 * session's graph, built by the session owner per workspace root, so a
 * separately-injected machine or plane could not silently drop every fact
 * of a session onto a plane nobody reads. The session co-constructs them.
 */
export type SessionHandleInit = Partial<
  Pick<SessionHandle, 'responseTextProcessing' | 'roots'>
> & {
  readonly interactions?: HostInteractions;
  readonly transcriptMode?: RunLogStoreMode;
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
   * Per-run execution handles: registration, lookup, change listeners, and
   * subagent lineage. Hears every canonical `status` fact from
   * {@link publishStatus}, in publish order.
   */
  readonly executions: RunRegistry;
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
  /** Session-scoped status plane. */
  readonly status: RunStatusMachine;
  /** Session-owned transcript store for run traces launched in this session. */
  readonly transcripts: RunLogStore;
  /**
   * The workspace this session works on: the four per-workspace host roots.
   * Runs and `runInSession` scopes resolve `StorageFS`/`WorkspaceFS` and the
   * workspace config/state through these, so several sessions in one process
   * each write under their own folder.
   */
  readonly roots: WorkspaceRoots;
  /** Session-owned follow-up queue owner. */
  readonly followUps: ToolUseFollowUpQueue;
  /** Session-owned per-stream sidecar store for runs launched in this session. */
  readonly snapshots: RunSnapshotStore;
  /** The store's projection of the durable facts, called inside `publish`. */
  private readonly applySnapshotEvent: (
    event: SessionEvent,
  ) => Effect.Effect<void>;
  private readonly graph: SessionGraph;
  private disposed = false;
  private readonly publicationGate = Semaphore.makeUnsafe(1);
  private readonly publications = new Set<Promise<Exit.Exit<unknown>>>();
  private readonly artifactFlushers = new Set<() => Promise<void>>();
  private pendingArtifactFlush: DeferredPromise<void> | undefined;
  private artifactFlushWorkerRunning = false;
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
   * Session-owned bridge from a workflow-script grandchild's execution id to
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
        readonly snapshots: RunSnapshotStore;
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
    this.view = graph.view;
    this.viewChanges = graph.viewChanges;
    this.folded = graph.folded;
    this.requests = graph.requests;
    this.inputs = graph.inputs;
    this.subscriptions = graph.subscriptions;
    const status = new RunStatusMachine(
      (event) => this.publishStatus(event),
      (streamId, detail) => this.setUnreadable(streamId, detail),
    );
    this.followUps = new ToolUseFollowUpQueue();
    const interactions = new SessionHostInteractions(this);
    // The approval authority publishes a stream's full policy snapshot on
    // every effective bypass change; `setApprovalPolicy` below publishes the
    // same snapshot when the policy half moves.
    const approvals = createSessionApprovals(interactions, (streamId) =>
      this.publishApprovalPolicy(streamId),
    );
    this.executions = new RunRegistry({
      streamStatus: status,
      publish: (events) => this.publish(events),
      approvals,
      publishResult: (event, streamId) => this.publishRunEvent(streamId, event),
      finalizeExecution: (input) => finalizeRun(this, input),
      releaseRootExecutionLease: (executionId) =>
        this.releaseExecutionLease(executionId),
    });

    this.status = status;
    // The sidecar store is a session artifact exactly like `transcripts`: the
    // session projects its own run events into it and flushes it below, so no
    // host has to construct, attach, and flush one of its own.
    this.snapshots = init.snapshots;
    this.applySnapshotEvent = this.snapshots.attachSessionEvents();
    this.interactions = interactions;
    this.approvals = approvals;
    this.modelRetries = new ModelRetryGate();
    this.responseTextProcessing =
      init.responseTextProcessing ?? createNeutralResponseTextProcessing();
    this.workflowControls = new WorkflowControlRegistry();
    // Every session owns exactly one trace-flusher map. There is no
    // process-wide registry: a host drains the session it is shutting down.
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
    this.teardown.add(() => this.artifactFlushers.clear());
    this.teardown.add(() => this.interactions.dispose());
    this.teardown.add(() => this.modelRetries.dispose());
    // Drop bypass state before the interaction slot settles pending approvals.
    this.teardown.add(() => this.approvals.clearAll());
    this.teardown.add(() => this.executions.dispose());
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
    for (const streamId of SubscriptionRef.getUnsafe(
      this.view,
    ).streams.keys()) {
      this.publishApprovalPolicy(streamId);
    }
  }

  /**
   * One run's full approval-policy snapshot: the policy this session holds
   * plus the bypass values its approval queues own. The launcher stamps it on
   * `run.start` as the initial snapshot; every later change is published
   * through {@link publishApprovalPolicy}. Never a toggle delta.
   */
  approvalPolicySnapshotFor(streamId: StreamTabId): ApprovalPolicySnapshot {
    return {
      policy: this.texraApprovalPolicy,
      bypasses: this.approvals.bypassesFor(streamId),
    };
  }

  /**
   * The one emitter of `approval.policy` (PRD one-fold-three-renderers,
   * section 6, item 2), for a change after the run's `run.start`.
   */
  private publishApprovalPolicy(streamId: StreamTabId): void {
    this.publish([
      {
        type: 'approval.policy',
        aggregateId: qualifyAggregateId('stream', streamId),
        snapshot: this.approvalPolicySnapshotFor(streamId),
      },
    ]);
  }

  /** Register a session-owned durable writer such as a snapshot store. */
  useArtifactFlusher(flush: () => Promise<void>): () => void {
    this.artifactFlushers.add(flush);
    return () => this.artifactFlushers.delete(flush);
  }

  /**
   * End ownership of one execution after every session-owned durable writer
   * has drained. An optional post-drain operation publishes lifecycle state
   * that belongs after those artifacts; it runs before the claim is unlinked.
   * The claim is unlinked whatever the drain did: resumability is the
   * checkpoint, so a failed flush is logged and rethrown but never changes
   * who owns the run. A release failure never masks a drain failure: the
   * drain's error is the one the caller sees, and the release's is logged.
   * This is the one exit choreography every run driver calls.
   */
  releaseExecutionLease(
    executionId: RunId,
    afterArtifactsDrained: Effect.Effect<void, Error> = Effect.void,
  ): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      const drained = yield* Effect.exit(
        Effect.gen({ self: this }, function* () {
          yield* Effect.tryPromise({
            try: () =>
              runInSession(this, async () => {
                await validateOwnedRunLease(executionId);
                await this.flushArtifacts();
              }),
            catch: ensureError,
          });
          yield* afterArtifactsDrained;
        }),
      );
      // A rejected artifact flush cannot let claim release overtake facts that
      // were already queued by the same owner.
      const published = yield* Effect.exit(
        Effect.tryPromise({
          try: () => this.settlePublications(),
          catch: ensureError,
        }),
      );
      const claimRelease = yield* Effect.exit(
        this.graph.releaseExecutionClaims(executionId),
      );
      const fileRelease = yield* Effect.exit(
        Effect.tryPromise({
          try: () =>
            runInSession(this, () => releaseOwnedRunLease(executionId)),
          catch: ensureError,
        }),
      );
      const failures = [drained, published, claimRelease, fileRelease].flatMap(
        (exit) => (Exit.isFailure(exit) ? [Cause.squash(exit.cause)] : []),
      );
      const primary = failures.shift();
      for (const error of failures)
        logger.warn(`Execution ${executionId}: lease release also failed`, {
          data: error,
        });
      if (primary !== undefined)
        return yield* Effect.fail(ensureError(primary));
    });
  }

  /** Admit both existing execution claims before resume reads or mutations. */
  acquireExecutionClaims(
    executionId: RunId,
    streamId: StreamTabId,
  ): Effect.Effect<Effect.Effect<void, Error>, Error> {
    return this.graph.acquireExecutionClaims(executionId, streamId).pipe(
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

  /** Drain registered artifact writers and all pending event publications. */
  flushArtifacts(): Promise<void> {
    this.pendingArtifactFlush ??= pDefer<void>();
    const batch = this.pendingArtifactFlush;
    if (!this.artifactFlushWorkerRunning) {
      this.artifactFlushWorkerRunning = true;
      queueMicrotask(() => {
        void this.drainArtifactFlushBatches();
      });
    }
    return batch.promise;
  }

  /**
   * Drain one current batch and, when calls arrived during it, one trailing
   * batch at a time. This preserves each caller's durability boundary without
   * repeating a full session flush for every execution ending in one burst.
   */
  private async drainArtifactFlushBatches(): Promise<void> {
    while (this.pendingArtifactFlush) {
      const batch = this.pendingArtifactFlush;
      this.pendingArtifactFlush = undefined;
      try {
        await this.flushArtifactsOnce();
        batch.resolve();
      } catch (error) {
        batch.reject(error);
      }
    }
    this.artifactFlushWorkerRunning = false;
  }

  private async flushArtifactsOnce(): Promise<void> {
    const results = await Promise.allSettled([
      this.settlePublications(),
      ...[...this.artifactFlushers].map((flush) =>
        Promise.resolve().then(flush),
      ),
    ]);
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    throwAggregated(
      failures,
      'Multiple session artifact writers failed to flush',
    );
  }

  /**
   * Terminal result listeners consume committed table rows, including run
   * usage and agent identity. Cleared when the session unwinds.
   */
  private readonly resultListeners = new Set<(event: ResultEvent) => void>();

  /**
   * Subscribe to terminal `result` events for runs in this session. Hosts hold
   * the session, so this is how they receive a run's outcome — per-run traces
   * are created inside the run and are not reachable from the host otherwise.
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
  attachRunTrace(trace: AgentTrace, streamId: StreamTabId): () => void {
    return trace.subscribe((event) => this.publishRunEvent(streamId, event));
  }

  /**
   * Publish one run-scoped trace event as its durable arm (`runEventDraft`);
   * a trace event with no arm goes nowhere. Shared by `attachRunTrace` (the
   * live per-run trace subscription above) and by `ExecutionRegistry`'s
   * injected `publishResult` constructor callback, which needs the identical
   * forwarding for a terminal event synthesized *after* the originating run's
   * own trace has already been disposed — killing a native subagent suspended
   * at WAITING (`terminateWaitingHandle`) settles `handle.result` and the
   * run's own (already-torn-down) trace, but has no other way to reach this
   * session's `onResult` subscribers.
   */
  publishRunEvent(streamId: StreamTabId, event: AgentEvent): void {
    if (this.disposed) return;
    if (event.type === 'stream.chunk') {
      this.schedulePublication(
        this.graph.publishText(streamId, event.id, redactSecrets(event.text)),
      );
      return;
    }
    this.schedulePublication(
      Effect.suspend(() => {
        const draft = runEventDraft(
          streamId,
          event.type === 'stream.end'
            ? {
                ...event,
                finalText:
                  event.finalText ?? this.graph.readText(streamId, event.id),
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
   * Publish one canonical status fact from the session's status machine. The
   * runtime's status consumers hear it only after the event batch commits:
   * the recorders' status ports and the execution registry's waiters and
   * child rosters cannot announce a rejected write.
   */
  publishStatus(event: StatusEvent): void {
    if (this.disposed) return;
    this.schedulePublication(
      Effect.suspend(() => {
        const closure = this.statusClosureFacts(event.streamId, event.phase);
        return this.graph.publish([...closure, statusDraft(event)]);
      }),
    );
  }

  /** Final text facts committed immediately before a status closes its entries. */
  statusClosureFacts(
    streamId: StreamTabId,
    phase: RunPhase,
  ): SessionEventDraft[] {
    const closure: SessionEventDraft[] = [];
    if (phase === STREAM_PHASE.WAITING || isTerminalOutcomePhase(phase)) {
      for (const entry of this.transcripts.get(streamId)?.getRange(0) ?? []) {
        if (!isRunningStreamingTextEntry(entry)) continue;
        closure.push({
          type: 'stream.end',
          aggregateId: qualifyAggregateId('stream', streamId),
          id: entry.id,
          finalText: this.graph.readText(streamId, entry.id) ?? entry.text,
        });
      }
    }
    return closure;
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

  /** Native metadata publication shares the existing ordered publisher. */
  commit(
    events: readonly SessionEventDraft[],
  ): Effect.Effect<readonly SessionEvent[]> {
    return this.publicationGate.withPermit(this.graph.publish(events));
  }

  /** Registration owns birth claims as soon as append commits, before its tail drains. */
  commitRegistration(
    events: readonly SessionEventDraft[],
  ): Effect.Effect<readonly SessionEvent[]> {
    return this.publicationGate.withPermit(
      this.graph.publishRegistration(events),
    );
  }

  /** Read and append under the same local publisher permit. C5 excludes foreign writers. */
  updateRecordFacts<A>(
    executionId: RunId,
    update: (rows: readonly SessionEvent[]) => {
      readonly events: readonly SessionEventDraft[];
      readonly value: A;
    },
  ): Effect.Effect<A> {
    const graph = this.graph;
    return this.publicationGate.withPermit(
      Effect.gen(function* () {
        const updateResult = update(yield* graph.executionRecords(executionId));
        yield* graph.publish(updateResult.events);
        return updateResult.value;
      }),
    );
  }

  /** Internal typed metadata accessors read the database, never the display fold. */
  readExecutionRecords(
    executionId: RunId,
  ): Effect.Effect<readonly SessionEvent[]> {
    return this.graph.executionRecords(executionId);
  }

  readExecutionChildren(
    executionId: RunId,
  ): Effect.Effect<readonly SessionEvent[]> {
    return this.graph.executionChildren(executionId);
  }

  readRecordListing(): Effect.Effect<readonly SessionEvent[]> {
    return this.graph.recordListing();
  }

  private schedulePublication(program: Effect.Effect<unknown>): void {
    const publication = effectRuntime().runPromise(
      this.publicationGate.withPermit(program).pipe(
        Effect.tapDefect((cause) =>
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
      Effect.andThen(this.applySnapshotEvent(event)),
      Effect.andThen(
        Effect.sync(() => {
          // Host notifications and runtime waiters belong to the authoring process.
          const { self } = SubscriptionRef.getUnsafe(this.graph.local);
          if (event.ownerId == null || !self.includes(event.ownerId)) return;

          if (event.type === 'result') {
            for (const listener of [...this.resultListeners]) {
              try {
                listener({
                  ...event,
                  streamId: aggregateTarget(event.aggregateId).id,
                });
              } catch (error) {
                logger.warn('Session result listener threw', { data: error });
              }
            }
          }

          if (event.type !== 'status') return;
          const status: StatusEvent = {
            ...event,
            streamId: aggregateTarget(event.aggregateId).id as StreamTabId,
          };
          this.executions.handleStatus(status.streamId);
        }),
      ),
    );
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
    set: readonly (Omit<TranscriptSubscription, 'id'> & { id: StreamTabId })[],
  ): Effect.Effect<void> {
    return Effect.suspend(() =>
      this.disposed
        ? Effect.void
        : this.subscriptions.set(
            port,
            set.map(({ id, fromSeq }) => ({
              id: qualifyAggregateId('stream', id),
              fromSeq,
            })),
          ),
    );
  }

  /** The status machine's hold on a stream this process cannot read, or its
   *  release: local truth the fold reads as `readOnly` (PRD 5.1). */
  private setUnreadable(streamId: StreamTabId, detail: string | null): void {
    if (this.disposed) return;
    effectRuntime().runFork(
      SubscriptionRef.update(this.graph.local, (local) => {
        const rest = local.unreadable.filter((u) => u.streamId !== streamId);
        return {
          ...local,
          unreadable: detail === null ? rest : [...rest, { streamId, detail }],
        };
      }),
    );
  }

  /**
   * Unwind this session ({@link unwind}) and release it from its owner,
   * which frees the root's graph after it. A teardown failure surfaces to
   * the caller and still releases the session. Settles nothing: a host that
   * needs the session's live executions ended first closes through
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
 * Settle executions still owned when the host exits. Hosts register this as
 * their first ON-phase handler, after reachable drivers have unwound and
 * before sessions or persistence services are disposed.
 *
 * Each owned execution keeps its checkpoint and receives CANCELLED unless a
 * driver has already persisted another outcome. Under the same lease, publish
 * canonical closure facts for its running transcript entries using the outcome
 * that remains authoritative. Release waits for those publications to commit.
 * A driver that writes a different outcome after this settlement remains a
 * separate lifecycle race; keepExistingOutcome only protects earlier writes.
 *
 * The caller's phase deadline bounds the drain. An expired deadline is logged
 * for each skipped execution and checked again after its outcome write.
 */
export const settleLiveSessionRuns = Effect.fn('settleLiveSessionExecutions')(
  function* (signal: AbortSignal) {
    const pending: { session: SessionHandle; executionId: RunId }[] = [];
    forEachLiveSession((session) => {
      for (const executionId of session.executions.getActiveIds()) {
        pending.push({ session, executionId });
      }
    });
    for (const { session, executionId } of pending) {
      if (signal.aborted) {
        logger.warn(
          `Host exit deadline passed before execution ${executionId} could settle`,
        );
        continue;
      }
      const settlement = Effect.gen(function* () {
        if (!runInSession(session, () => ownsRunLease(executionId))) return;
        const streamId =
          session.executions.getHandle(executionId)?.childStreamId;
        // Read the committed transcript once after queued publications settle.
        // Host exit needs no presentation residency or mutable writer handle.
        const transcript = yield* Effect.exit(
          Effect.gen(function* () {
            yield* Effect.tryPromise({
              try: () => session.settlePublications(),
              catch: ensureError,
            });
            return streamId === undefined
              ? []
              : yield* session.transcripts.readEntries(streamId);
          }),
        );
        yield* session.releaseExecutionLease(
          executionId,
          Effect.gen(function* () {
            const finalization = yield* finalizeRun(session, {
              executionId,
              outcome: RUN_OUTCOME.CANCELLED,
              flowRecord: 'preserve',
              keepExistingOutcome: true,
            });
            if (!finalization.ok) {
              throw new Error(
                `Failed to persist the CANCELLED outcome for execution ${executionId}`,
                { cause: finalization.error },
              );
            }
            if (signal.aborted) {
              logger.warn(
                `Host exit deadline passed after execution ${executionId}'s outcome was written; its transcript groups stay open`,
              );
              return;
            }
            if (streamId === undefined) {
              logger.warn(
                `Execution ${executionId} was untracked while the host exit settled it; any transcript groups it left open stay open`,
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
                session.publishRunEvent(streamId, {
                  type: 'stage.end',
                  id: entry.id,
                  status: finalization.outcome,
                });
              } else if (isRunningStreamingTextEntry(entry)) {
                session.publishRunEvent(streamId, {
                  type: 'stream.end',
                  id: entry.id,
                });
              } else {
                const call = nonterminalWorkflowCall(entry);
                if (call)
                  session.publishRunEvent(streamId, {
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
              `Failed to settle execution ${executionId} at host exit; a later launch classifies it from its checkpoint`,
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
