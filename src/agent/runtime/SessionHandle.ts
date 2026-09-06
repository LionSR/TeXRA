/**
 * `SessionHandle` — one owner per session for the runtime's coordination state.
 *
 * It is a **composition record**, not a facade: it re-exposes no per-concern
 * methods, so callers address each owner directly
 * (`session.interactions.x(...)`, `session.executions.y(...)`). It has no
 * readiness gate: a restored session is usable the moment it is constructed,
 * and what a stream with no live flow context in this process is gets decided
 * by the fold's `readOnly` and `group` rules over the session's view, never
 * by a boot pass. It composes {@link ExecutionRegistry},
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

import { SubscriptionRef, type Stream } from 'effect';
import pDefer, { type DeferredPromise } from 'p-defer';

import type {
  AgentEvent,
  AgentTrace,
  ResultEvent,
  StatusEvent,
} from '@agent/trace';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import {
  ownsExecutionLease,
  releaseOwnedExecutionLease,
  validateOwnedExecutionLease,
} from '@agent/storage/executionLease';
import { finalizeRun } from '@agent/storage/executionLifecycle';
import type { ResponseTextProcessing } from '@latex/texraResponseTextProcessing';
import { createLog } from '@logger/logUtils';
import { DisposableStore } from '@platform/disposable';
import { effectRuntime } from '@platform/processRuntime';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import {
  TEXRA_APPROVAL_POLICY_DEFAULT,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import {
  aggregateId as qualifyAggregateId,
  RUN_OUTCOME,
  type ApprovalPolicySnapshot,
  type CommitOrdinal,
  type ExecutionId,
  type SessionEventDraft,
  type StreamTabId,
  type TranscriptSubscription,
} from '@shared/schemas';
import type { SessionView } from '@shared/session/sessionView';
import type { SessionEventsShape } from '@shared/session/sessionEvents';
import type { RunTrace, RunTraceFlushEntry } from '@transcript/runTrace';
import type { StreamLogStore } from '@transcript/StreamLogStore';
import { StreamSnapshotStore } from '@transcript/StreamSnapshotStore';
import { throwAggregated } from '@utils/core';
import {
  getRunContextSession,
  runInSession,
  tryUseRunContext,
} from './RunContext';
import { ExecutionRegistry } from './executionRegistry';
import { StreamStatusMachine } from './StreamStatusService';
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
 * What opening a session supplies (`openSession`): a valid transcript store
 * is required; other owners may be injected. `interactions` is the host the
 * session is born with, attached for its whole life, for an opener with no
 * later attach step of its own (the SDK's headless host).
 *
 * `status` and `events` are deliberately absent: the machine publishes
 * canonical `status` through the session, and the event plane is the
 * session's graph, built by the session owner per workspace root, so a
 * separately-injected machine or plane could not silently drop every fact
 * of a session onto a plane nobody reads. The session co-constructs them.
 */
export type SessionHandleInit = Pick<SessionHandle, 'transcripts'> &
  Partial<
    Pick<SessionHandle, 'snapshots' | 'responseTextProcessing' | 'roots'>
  > & { readonly interactions?: HostInteractions };

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
  readonly executions: ExecutionRegistry;
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
  /** Session-scoped status plane. */
  readonly status: StreamStatusMachine;
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
  /** Session-owned per-stream sidecar store for runs launched in this session. */
  readonly snapshots: StreamSnapshotStore;
  /** The store's projection of the durable facts, called inside `publish`. */
  private readonly applySnapshotEvent: (event: SessionEventDraft) => void;
  private readonly graph: SessionGraph;
  /**
   * The transcript recorders' status ports (`RunTrace.handleStatus`), one per
   * attached run trace: status is a session fact the recorder cannot hear on
   * its own trace, and it must land in transcript order, so the session calls
   * them inside {@link publishStatus} before the log moves.
   */
  private readonly statusPorts = new Set<(event: StatusEvent) => void>();
  private disposed = false;
  /** This session's execution-keyed trace flushers. */
  readonly flushers: Map<string, RunTraceFlushEntry>;
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
    init: SessionHandleInit & {
      readonly roots: WorkspaceRoots;
      readonly graph: (session: SessionHandle) => SessionGraph;
    },
  ) {
    if (init.transcripts.mode.kind === 'read-only') {
      throw new Error(
        'SessionHandle requires a writable transcript store; read-only stores are reserved for call-scoped readers.',
      );
    }
    // Forced dependency order, every cross-reference explicit — never let a
    // member fall back to a neighboring module singleton (silent-state-split).
    const transcripts = init.transcripts;
    this.transcripts = transcripts;
    this.roots = init.roots;
    const graph = init.graph(this);
    this.graph = graph;
    this.events = graph.events;
    this.view = graph.view;
    this.viewChanges = graph.viewChanges;
    this.folded = graph.folded;
    this.requests = graph.requests;
    this.inputs = graph.inputs;
    const status = new StreamStatusMachine(
      (event) => this.publishStatus(event),
      (streamId, detail) => this.setUnreadable(streamId, detail),
    );
    const followUps = new ToolUseFollowUpQueue();
    const interactions = new SessionHostInteractions(this);
    // The approval authority publishes a stream's full policy snapshot on
    // every effective bypass change; `setApprovalPolicy` below publishes the
    // same snapshot when the policy half moves.
    const approvals = createSessionApprovals(interactions, (streamId) =>
      this.publishApprovalPolicy(streamId),
    );
    const executions = new ExecutionRegistry({
      streamStatus: status,
      publish: (events) => this.publish(events),
      approvals,
      publishResult: (event, streamId) => this.publishRunEvent(streamId, event),
      releaseRootExecutionLease: (executionId) =>
        this.releaseExecutionLease(executionId),
    });

    this.executions = executions;
    this.status = status;
    this.followUps = followUps;
    // The sidecar store is a session artifact exactly like `transcripts`: the
    // session projects its own run events into it and flushes it below, so no
    // host has to construct, attach, and flush one of its own.
    this.snapshots = init.snapshots ?? new StreamSnapshotStore();
    // The summary sink mirrors snapshot-owned display metadata into the
    // always-resident stream summaries, so sidebars and all-streams metadata
    // paths read summaries instead of per-stream sidecars (#9947). Always
    // writable: this constructor rejects read-only transcript stores above.
    this.applySnapshotEvent = this.snapshots.attachSessionEvents({
      summaryMetaSink: (stream, meta) =>
        transcripts.recordSummaryMeta(stream, meta),
      summaryMetaSource: (stream) => transcripts.getSummaryMeta(stream),
    });
    this.interactions = interactions;
    this.approvals = approvals;
    this.modelRetries = new ModelRetryGate();
    this.responseTextProcessing =
      init.responseTextProcessing ?? createNeutralResponseTextProcessing();
    this.workflowControls = new WorkflowControlRegistry();
    // Every session owns exactly one trace-flusher map. There is no
    // process-wide registry: a host drains the session it is shutting down.
    this.flushers = new Map<string, RunTraceFlushEntry>();
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
      this.statusPorts.clear();
    });
    this.teardown.add(() => this.resultListeners.clear());
    this.teardown.add(() => this.artifactFlushers.clear());
    this.teardown.add(() => this.interactions.dispose());
    this.teardown.add(() => this.modelRetries.dispose());
    // Drop bypass state before the interaction slot settles pending approvals.
    this.teardown.add(() => this.approvals.clearAll());
    this.teardown.add(() => this.executions.dispose());
    this.teardown.add(() => this.followUps.dispose());
    this.teardown.add(() => this.flushPendingTraces());
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

  /** Drain one execution's pending trace, or every trace during shutdown. */
  flushPendingTraces(ownerKey?: string): void {
    const failures: unknown[] = [];
    const flushers =
      ownerKey === undefined
        ? [...this.flushers.values()]
        : [this.flushers.get(ownerKey)].filter(
            (entry): entry is RunTraceFlushEntry => entry !== undefined,
          );
    for (const entry of flushers) {
      try {
        entry.flush();
      } catch (error) {
        failures.push(error);
      }
    }
    throwAggregated(failures, 'Multiple session trace writers failed to flush');
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
  async releaseExecutionLease(
    executionId: ExecutionId,
    afterArtifactsDrained?: () => void | Promise<void>,
  ): Promise<void> {
    let drainError: unknown;
    try {
      await validateOwnedExecutionLease(executionId);
      await this.flushArtifacts(executionId);
      await afterArtifactsDrained?.();
    } catch (error) {
      drainError = error;
      logger.warn(
        `Execution ${executionId}: final artifacts did not all persist; releasing its lease anyway`,
        { data: error },
      );
    }
    try {
      await releaseOwnedExecutionLease(executionId);
    } catch (releaseError) {
      if (drainError === undefined) throw releaseError;
      logger.warn(
        `Execution ${executionId}: its lease could not be released after its final artifacts failed`,
        { data: releaseError },
      );
    }
    if (drainError !== undefined) throw drainError;
  }

  /** Persist one execution's trace plus the session's shared artifact stores. */
  flushArtifacts(ownerKey?: string): Promise<void> {
    let traceFailure: unknown;
    try {
      this.flushPendingTraces(ownerKey);
    } catch (error) {
      traceFailure = error;
    }
    this.pendingArtifactFlush ??= pDefer<void>();
    const batch = this.pendingArtifactFlush;
    if (!this.artifactFlushWorkerRunning) {
      this.artifactFlushWorkerRunning = true;
      queueMicrotask(() => {
        void this.drainArtifactFlushBatches();
      });
    }
    if (traceFailure === undefined) return batch.promise;
    return batch.promise.then(
      () => {
        throw traceFailure;
      },
      (artifactFailure: unknown) => {
        throw new AggregateError(
          [traceFailure, artifactFailure],
          'Trace and shared artifact writers failed to flush',
        );
      },
    );
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
    const writers = [
      () => this.transcripts.flush(),
      () => this.snapshots.flush(),
      ...this.artifactFlushers,
    ];
    const results = await Promise.allSettled(
      writers.map((flush) => Promise.resolve().then(flush)),
    );
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    throwAggregated(
      failures,
      'Multiple session artifact writers failed to flush',
    );
  }

  /**
   * Terminal `result` listeners, called from {@link publishRunEvent} with
   * the run's own event (its usage totals and agent name included, which the
   * durable arm does not carry). Cleared by `dispose()`: a late
   * `publishRunEvent` after teardown must not reach host closures.
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
  attachRunTrace(
    run: Pick<RunTrace, 'trace' | 'handleStatus'>,
    streamId: StreamTabId,
  ): () => void {
    const detachTrace = run.trace.subscribe((event) =>
      this.publishRunEvent(streamId, event),
    );
    this.statusPorts.add(run.handleStatus);
    return () => {
      this.statusPorts.delete(run.handleStatus);
      detachTrace();
    };
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
    if (event.type === 'result') {
      for (const listener of [...this.resultListeners]) {
        try {
          listener(event);
        } catch (error) {
          logger.warn('Session result listener threw', { data: error });
        }
      }
    }
    const draft = runEventDraft(streamId, event);
    if (draft) this.publish([draft]);
  }

  /**
   * Publish one canonical status fact from the session's status machine. The
   * runtime's ordering-sensitive consumers hear it here, in publish order and
   * before the log moves and any renderer wakes: the recorders' status ports
   * and the execution registry's waiters and child rosters.
   */
  publishStatus(event: StatusEvent): void {
    if (this.disposed) return;
    for (const port of [...this.statusPorts]) {
      try {
        port(event);
      } catch (error) {
        logger.warn('Session status port threw', { data: error });
      }
    }
    this.executions.handleStatus(event.streamId);
    this.publish([statusDraft(event)]);
  }

  /**
   * The one publisher of this session's facts (PRD 7.1). The snapshot store
   * projects each durable fact synchronously, before the log moves, so its
   * summary mirror is current for every reader the wake reaches; then the
   * batch commits under the plane's permit. A publish after teardown goes
   * nowhere: the session's owners have unwound and a late fact has no reader.
   */
  publish(events: readonly SessionEventDraft[]): void {
    if (this.disposed || events.length === 0) return;
    for (const event of events) {
      // A projection that rejects a fact (a malformed payload, a store that
      // refused a patch) is logged and the fact still lands: the store owns
      // its own validation, and a publisher must not lose the plane over it.
      try {
        this.applySnapshotEvent(event);
      } catch (error) {
        logger.warn(`Snapshot projection rejected a ${event.type} fact`, {
          data: error,
        });
      }
    }
    effectRuntime().runFork(this.graph.publish(events));
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
   */
  setTranscriptSubscriptions(
    port: string,
    set: readonly (Omit<TranscriptSubscription, 'id'> & { id: StreamTabId })[],
  ): void {
    if (this.disposed) return;
    effectRuntime().runFork(
      this.graph.subscriptions.set(
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
 * Settle the executions live sessions still own, so a host exit leaves no
 * execution recorded as neither running nor finished.
 *
 * Run drivers settle their own executions as they unwind, through
 * {@link SessionHandle.releaseExecutionLease}. Hosts register this drain as
 * their **first ON-phase handler** so that every driver a BEFORE handler
 * *does* reach has already had its turn — on the CLI that is the whole
 * headless path, whose handler kills the run and awaits its unwind — and so
 * that nothing has been disposed yet.
 *
 * On desktop and the extension no BEFORE handler aborts or awaits an
 * in-process run: `registerAgentShutdownHandlers` interrupts background OS
 * processes and the agent-CLI registries only. A run in flight there is still
 * being driven when this runs, which is precisely why the drain exists — its
 * driver's promise would otherwise never settle — and why the terminal write
 * below yields to a driver that did reach its own outcome first. What is left
 * for the drain is a run the process is exiting out from under (quitting the
 * desktop app or VS Code mid-run) or a tool-use flow parked at its WAIT node.
 *
 * Each such execution gets the same durable settlement the CLI has always
 * given its own: the CANCELLED outcome, its transcript's running groups closed
 * as whatever outcome that write left standing (the driver's own when it
 * reached its terminal write first, so the transcript never closes on an
 * outcome the header contradicts), its flow record preserved so
 * `deriveResumability` can still offer the checkpoint, and its lease record
 * deleted rather than left for a later launch to prove dead. The outcome and
 * the group close are both written inside the lease-fenced post-drain window,
 * so the run's durable state and its transcript settle under one claim. That
 * pairing assumes the outcome write is the one that resolves the race: if this
 * drain writes CANCELLED first and an in-flight driver's `finalizeRunTerminal`
 * then overwrites the header with COMPLETED or FAILED, the groups below are
 * already closed as CANCELLED and stay that way — the documented case is the
 * driver reaching the meta-lock first, which `keepExistingOutcome` handles.
 *
 * Bounded by the caller's phase deadline — a host that cannot exit because a
 * release is slow would be worse than the unsettled record. The budget is
 * sized for what each execution costs here: one outcome write plus one
 * transcript flush. Once `signal` fires, every remaining execution is named
 * in the log instead of being silently skipped, and the signal is re-checked
 * between the two writes so a deadline reached mid-settlement is logged too.
 */
export async function settleLiveSessionExecutions(
  signal: AbortSignal,
): Promise<void> {
  const pending: { session: SessionHandle; executionId: ExecutionId }[] = [];
  forEachLiveSession((session) => {
    for (const executionId of session.executions.getActiveIds()) {
      pending.push({ session, executionId });
    }
  });
  for (const { session, executionId } of pending) {
    if (signal.aborted) {
      logger.warn(
        `Host exit deadline passed before this drain reached execution ${executionId}; settling one execution costs an outcome write and a transcript flush, which the exit deadline budgets for, so a run left here means the budget ran out. If it was still unsettled it keeps its open transcript groups, which a later launch renders as interrupted from the derived outcome until a later settlement persists the close`,
      );
      continue;
    }
    // A host quit handler runs outside any run scope, and the lease key and
    // the terminal write both resolve through the owning session's storage
    // root, so the drain enters each session before asking who owns what: a
    // desktop with several papers open would otherwise look every paper's
    // lease up under the no-workspace root and skip them all.
    await runInSession(session, async () => {
      // Skips both a run whose driver already settled it and one this process
      // never owned (a run another TeXRA process holds).
      if (!ownsExecutionLease(executionId)) return;
      try {
        await session.releaseExecutionLease(executionId, async () => {
          const finalization = await finalizeRun({
            executionId,
            outcome: RUN_OUTCOME.CANCELLED,
            flowRecord: 'preserve',
            // A driver that reached its own terminal write between the
            // registry read above and this one owns the result: this drain
            // records what the exit interrupted, never what already finished.
            keepExistingOutcome: true,
          });
          if (!finalization.ok) {
            throw new Error(
              `Failed to persist the CANCELLED outcome for execution ${executionId}`,
              { cause: finalization.error },
            );
          }
          // Same claim, second write: close the run's transcript. Outside
          // this callback the claim is already unlinked, so another process
          // could have taken the run over and be appending to its log;
          // settling its groups from this process's stale resident copy would
          // then write that owner's entries back out from under it.
          if (signal.aborted) {
            logger.warn(
              `Host exit deadline passed after execution ${executionId}'s outcome was written; its transcript groups stay open and render as interrupted from that outcome`,
            );
            return;
          }
          const streamId =
            session.executions.getHandle(executionId)?.childStreamId;
          if (streamId === undefined) {
            logger.warn(
              `Execution ${executionId} was untracked while the host exit settled it; any transcript groups it left open stay open`,
            );
            return;
          }
          // The outcome that actually stands on disk, which is the driver's
          // own when it won the race above: closing this run's groups as
          // CANCELLED there would contradict the COMPLETED (or FAILED) result
          // the header reports.
          const closed = await session.transcripts.endRunningGroupsForStreams(
            [streamId],
            Date.now(),
            finalization.outcome,
          );
          if (closed.length > 0) await session.transcripts.flush();
        });
      } catch (error) {
        logger.warn(
          `Failed to settle execution ${executionId} at host exit; a later launch classifies it from its checkpoint`,
          { data: error },
        );
      }
    });
  }
}

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
