/**
 * `SessionHandle` — one owner per session for the runtime's coordination state.
 *
 * It is a **composition record**, not a facade: it re-exposes no per-concern
 * methods, so callers address each owner directly
 * (`session.interactions.x(...)`, `session.executions.y(...)`). Its sole
 * lifecycle gate, {@link SessionHandle.waitUntilReady}, ensures persistent
 * restart repair has settled before a host exposes the session. It composes
 * {@link ExecutionRegistry}, {@link ExecutionSubscriptionBinder},
 * {@link SessionHostInteractions}, and the other session-scoped owners.
 *
 * A session is one per host context: extension activation (per VS Code window),
 * CLI process, or desktop Electron process. The default instance is installed
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

import pDefer, { type DeferredPromise } from 'p-defer';
import PQueue from 'p-queue';

import type { AgentEvent, AgentTrace, ResultEvent } from '@agent/trace';
import { createChannelTrace } from '@agent/trace';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import { detectWaitingStreams } from '@agent/storage/detectWaitingStreams';
import { runWithOwnedExecutionLeaseQuiescence } from '@agent/storage/executionLease';
import { deriveResumability } from '@agent/storage/resumability';
import { platform } from '@platform/platform';
import {
  TEXRA_APPROVAL_POLICY_DEFAULT,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import { STREAM_PHASE, type StreamTabId } from '@shared/schemas';
import {
  isInFlightPhase,
  STREAM_TRANSITION_CAUSE,
} from '@shared/streams/streamStatus';
import type { RunTraceFlushEntry } from '@transcript/runTrace';
import type { StreamLogStore } from '@transcript/StreamLogStore';
import { StreamSnapshotStore } from '@transcript/StreamSnapshotStore';
import { throwAggregated } from '@utils/core';
import { getRunContextSession, tryUseRunContext } from './RunContext';
import { ExecutionRegistry } from './executionRegistry';
import { ExecutionSubscriptionBinder } from './ExecutionSubscriptionBinder';
import { StreamStatusMachine } from './StreamStatusService';
import {
  SessionHostInteractions,
  type HostInteractions,
} from './HostInteractions';
import { SessionEventHub } from './SessionEventHub';
import { ModelRetryGate } from './ModelRetryGate';
import {
  createSessionApprovals,
  type SessionApprovals,
} from './streamApprovalQueue';
import { WorkflowControlRegistry } from './workflowControlRegistry';
import { releaseExecutionLeaseAfterArtifacts } from './executionOwnership';
import {
  repairRestartedStreams,
  RestartRepairRetryScheduler,
} from './restartRepair';
import {
  createNeutralResponseTextProcessing,
  type ResponseTextProcessing,
} from './responseTextProcessing';

const logger = createChannelTrace('sessionHandle');

interface WaitingRepairProbe {
  readonly executionId: string;
  readonly statusGeneration: object | undefined;
  readonly result: Promise<boolean>;
}

function isReplayableTerminalResult(event: ResultEvent): boolean {
  return (
    !event.isSubagent && event.error != null && event.error.kind !== 'abort'
  );
}

/**
 * A valid transcript store is required; other owners may be injected.
 *
 * `status` is deliberately absent: the machine publishes canonical `status`
 * on the hub it is handed at construction, so a separately-injected machine
 * could be bound to a different hub than `events` and silently drop every
 * status fact. The session always co-constructs the pair instead.
 */
export type SessionHandleInit = Pick<SessionHandle, 'transcripts'> & {
  /**
   * Delay store repair until {@link SessionHandle.waitUntilReady} is called.
   * Desktop uses this so repair runs only after its process stores are wired.
   */
  restartRepair?: 'deferred';
} & Partial<
    Pick<
      SessionHandle,
      | 'executions'
      | 'subscriptions'
      | 'events'
      | 'followUps'
      | 'snapshots'
      | 'flushers'
      | 'interactions'
      | 'modelRetries'
      | 'responseTextProcessing'
      | 'workflowControls'
    >
  >;

export interface WorkspaceStorageTransitionHooks {
  readonly workspacePath: string | undefined;
  afterStorageCommit(): Promise<void>;
  afterStorageRollback(): void;
  afterStorageFinalize(): void;
}

export class SessionHandle {
  /** Per-run execution handles; owns the process-output poller + status sub. */
  readonly executions: ExecutionRegistry;
  /** Execution-status subscriptions bound to agent stream lifecycles. */
  readonly subscriptions: ExecutionSubscriptionBinder;
  /** Session-scoped one-way fact plane. */
  readonly events: SessionEventHub;
  /** Session-scoped status plane. */
  readonly status: StreamStatusMachine;
  /** Session-owned transcript store for run traces launched in this session. */
  readonly transcripts: StreamLogStore;
  /** Session-owned follow-up queue owner. */
  readonly followUps: ToolUseFollowUpQueue;
  /** Session-owned per-stream sidecar store for runs launched in this session. */
  readonly snapshots: StreamSnapshotStore;
  private readonly detachSnapshotEvents: () => void;
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
  private restartRepairPromise: Promise<unknown> | undefined;
  /** Per-stream {@link repairWaitingIfResumable} result currently in flight. */
  private readonly waitingRepairProbes = new Map<
    StreamTabId,
    WaitingRepairProbe
  >();
  private readonly restartRepairQueue = new PQueue({ concurrency: 1 });
  private readonly restartRepairRetry = new RestartRepairRetryScheduler();
  private readonly restartRepairAbort = new AbortController();
  private storageGeneration = 0;
  constructor(init: SessionHandleInit) {
    if (init.transcripts.mode.kind === 'read-only') {
      throw new Error(
        'SessionHandle requires a writable transcript store; read-only stores are reserved for call-scoped readers.',
      );
    }
    // Forced dependency order, every cross-reference explicit — never let a
    // member fall back to a neighboring module singleton (silent-state-split).
    const events = init.events ?? new SessionEventHub();
    const status = new StreamStatusMachine(events);
    const transcripts = init.transcripts;
    const followUps = init.followUps ?? new ToolUseFollowUpQueue();
    const interactions = init.interactions ?? new SessionHostInteractions();
    const approvals = createSessionApprovals(interactions);
    const executions =
      init.executions ??
      new ExecutionRegistry({ streamStatus: status, events });
    // Attaching here also supports an explicitly supplied registry while
    // keeping result publication scoped to this session's listeners.
    executions.attachSessionEvents(events, (event, streamId) =>
      this.publishRunEvent(streamId, event),
    );
    executions.attachSessionApprovals(approvals);

    this.executions = executions;
    this.subscriptions =
      init.subscriptions ??
      new ExecutionSubscriptionBinder({
        registry: executions,
        releaseSource: followUps,
        session: this,
      });
    this.events = events;
    this.status = status;
    this.transcripts = transcripts;
    this.followUps = followUps;
    // The sidecar store is a session artifact exactly like `transcripts`: the
    // session projects its own run events into it and flushes it below, so no
    // host has to construct, attach, and flush one of its own.
    this.snapshots = init.snapshots ?? new StreamSnapshotStore();
    this.detachSnapshotEvents = this.snapshots.attachSessionEvents(events);
    this.interactions = interactions;
    this.approvals = approvals;
    this.modelRetries = init.modelRetries ?? new ModelRetryGate();
    this.responseTextProcessing =
      init.responseTextProcessing ?? createNeutralResponseTextProcessing();
    this.workflowControls =
      init.workflowControls ?? new WorkflowControlRegistry();
    // Every session owns exactly one trace-flusher map. There is no
    // process-wide registry: a host drains the session it is shutting down.
    this.flushers = init.flushers ?? new Map<string, RunTraceFlushEntry>();
    executions.attachRootExecutionLeaseRelease((executionId) =>
      releaseExecutionLeaseAfterArtifacts(this, executionId),
    );
    liveSessions.add(this);
    if (
      this.transcripts.mode.kind === 'persistent' &&
      init.restartRepair !== 'deferred'
    ) {
      this.restartRepairPromise = this.enqueueRestartRepair(() =>
        this.repairStoresAfterRestart(this.storageGeneration),
      );
      // Construction cannot be awaited. Hosts observe the same promise
      // through waitUntilReady(); this branch only prevents a rejection from
      // becoming unhandled before the host reaches that boundary.
      void this.restartRepairPromise.catch(() => undefined);
    }
  }

  /** Live host-neutral approval policy for executable requests. */
  get approvalPolicy(): TexraApprovalPolicy {
    return this.texraApprovalPolicy;
  }

  setApprovalPolicy(policy: TexraApprovalPolicy): void {
    this.texraApprovalPolicy = policy;
  }

  /**
   * Wait for canonical stores and restart repair before exposing restored
   * session state to a host.
   */
  waitUntilReady(): Promise<void> {
    if (
      this.transcripts.mode.kind !== 'persistent' ||
      this.restartRepairAbort.signal.aborted
    ) {
      return Promise.resolve();
    }
    if (!this.restartRepairPromise) {
      this.restartRepairPromise = this.enqueueRestartRepair(() =>
        this.repairStoresAfterRestart(this.storageGeneration),
      );
    }
    return this.restartRepairPromise.then(() => undefined);
  }

  /**
   * Replace session persistence after the host's workspace storage root moves.
   *
   * Ordinary view loads must not reopen these live stores. The host calls this
   * explicit lifecycle boundary only after a workspace-root change.
   */
  reloadAfterStorageRootChange(
    hooks?: WorkspaceStorageTransitionHooks,
  ): Promise<boolean> {
    if (
      this.transcripts.mode.kind !== 'persistent' ||
      this.restartRepairAbort.signal.aborted
    ) {
      return Promise.resolve(false);
    }
    const hasPendingStorageChange =
      platform().storage.hasPendingWorkspaceStorageChange?.(
        hooks && { workspacePath: hooks.workspacePath },
      );
    if (hasPendingStorageChange === false) return Promise.resolve(false);
    this.storageGeneration += 1;
    const generation = this.storageGeneration;
    this.restartRepairRetry.cancel();
    const repair = this.enqueueRestartRepair(() =>
      this.repairStoresAfterRestart(generation, true, hooks),
    );
    this.restartRepairPromise = repair;
    return repair;
  }

  /**
   * Restore one stream to WAITING when its execution is still resumable.
   *
   * The same repair {@link repairRestartedStreams} applies at startup, deferred
   * to the moment it matters: a stream whose phase settled terminal while its
   * flow record stayed resumable routes a follow-up to `no_session` instead of
   * the resume queue (`ExecutionRegistry.getToolUseFollowUpTarget`). Callers
   * submitting input therefore probe here first. Concurrent submissions for one
   * stream collapse onto the first probe — the resumability read is the
   * expensive part and only one transition can win anyway.
   *
   * Lives beside the startup pass rather than in a host command so all three
   * hosts share one repair, and so the resumability read stays inside the
   * runtime that owns the stream phase.
   */
  async repairWaitingIfResumable(streamId: StreamTabId): Promise<boolean> {
    const executionId = this.snapshots.getRunMetadata(streamId).executionId;
    const inFlight = this.waitingRepairProbes.get(streamId);
    if (
      inFlight &&
      inFlight.executionId === executionId &&
      this.status.isCurrentGeneration(streamId, inFlight.statusGeneration)
    ) {
      return inFlight.result;
    }

    const statusGeneration = this.status.getGeneration(streamId);
    const phase = this.status.get(streamId);
    if (phase === STREAM_PHASE.WAITING) return true;
    if (isInFlightPhase(phase)) return false;

    if (!executionId) return false;

    const probe: WaitingRepairProbe = {
      executionId,
      statusGeneration,
      result: this.probeWaitingRepair(streamId, executionId, statusGeneration),
    };
    this.waitingRepairProbes.set(streamId, probe);
    try {
      return await probe.result;
    } finally {
      if (this.waitingRepairProbes.get(streamId) === probe) {
        this.waitingRepairProbes.delete(streamId);
      }
    }
  }

  private async probeWaitingRepair(
    streamId: StreamTabId,
    executionId: string,
    statusGeneration: object | undefined,
  ): Promise<boolean> {
    const resumability = await deriveResumability(executionId);
    if (!resumability.resumable) return false;
    if (
      this.snapshots.getRunMetadata(streamId).executionId !== executionId ||
      !this.status.isCurrentGeneration(streamId, statusGeneration)
    ) {
      return false;
    }
    const repaired = this.status.transitionToWaiting(
      streamId,
      STREAM_TRANSITION_CAUSE.RESTART_REPAIR,
    );
    if (repaired) {
      logger.debug(`Stream ${streamId} restored to WAITING before follow-up`);
    } else {
      logger.warn(
        `Failed to restore resumable stream ${streamId} to WAITING before follow-up`,
      );
    }
    return repaired;
  }

  private enqueueRestartRepair<T>(work: () => Promise<T>): Promise<T> {
    // `add` widens to `T | void` for abort/timeout options; neither is used.
    return this.restartRepairQueue.add(work) as Promise<T>;
  }

  private async repairStoresAfterRestart(
    generation: number,
    reloadTranscripts = false,
    transitionHooks?: WorkspaceStorageTransitionHooks,
  ): Promise<boolean> {
    try {
      if (this.restartRepairAbort.signal.aborted) return false;
      if (reloadTranscripts) {
        return await runWithOwnedExecutionLeaseQuiescence(async () => {
          if (this.restartRepairAbort.signal.aborted) return false;
          return this.replaceStoresAfterStorageRootChange(
            generation,
            transitionHooks,
          );
        });
      }
      if (generation !== this.storageGeneration) return false;
      await this.snapshots.load(this.transcripts.keys());
      if (
        generation !== this.storageGeneration ||
        this.restartRepairAbort.signal.aborted
      ) {
        return false;
      }
      this.markUnfinishedStreamsRunning();
      await this.runRestartRepair(generation);
      return true;
    } catch (error) {
      logger.warn('Failed to repair session stores after restart', {
        data: error,
      });
      throw error;
    }
  }

  private async replaceStoresAfterStorageRootChange(
    generation: number,
    transitionHooks?: WorkspaceStorageTransitionHooks,
  ): Promise<boolean> {
    if (generation !== this.storageGeneration) return false;
    try {
      await Promise.all([this.transcripts.flush(), this.snapshots.flush()]);
    } catch (flushError) {
      return this.restoreRestartRepairAfterReplacementFailure(
        generation,
        flushError,
      );
    }
    if (
      generation !== this.storageGeneration ||
      this.restartRepairAbort.signal.aborted
    ) {
      return false;
    }
    const storage = platform().storage;
    const storageRootChanged = storage.commitWorkspaceStorageChange?.(
      transitionHooks && { workspacePath: transitionHooks.workspacePath },
    );
    if (storageRootChanged === false) {
      try {
        await transitionHooks?.afterStorageCommit();
        await this.runRestartRepair(generation);
        transitionHooks?.afterStorageFinalize();
        return false;
      } catch (replacementError) {
        transitionHooks?.afterStorageRollback();
        throw replacementError;
      }
    }
    const previousStatus = this.status.getAllStreamStates();
    try {
      await transitionHooks?.afterStorageCommit();
      await this.transcripts.reload();
      this.status.clearAll();
      const streamIds = this.transcripts.keys();
      await this.snapshots.load(streamIds);
      this.markUnfinishedStreamsRunning();
      await this.runRestartRepair(generation);
      storage.finalizeWorkspaceStorageChange?.();
      transitionHooks?.afterStorageFinalize();
      return true;
    } catch (replacementError) {
      if (storage.rollbackWorkspaceStorageChange?.() !== true) {
        transitionHooks?.afterStorageRollback();
        throw replacementError;
      }
      transitionHooks?.afterStorageRollback();
      try {
        await this.transcripts.reload({ discardPendingWrites: true });
        this.snapshots.evictAll();
        await this.snapshots.load(this.transcripts.keys());
        this.status.clearAll();
        for (const [streamId, state] of previousStatus) {
          if (state.phase === STREAM_PHASE.WAITING) {
            this.status.transitionToWaiting(
              streamId,
              STREAM_TRANSITION_CAUSE.RESTART_REPAIR,
              { substate: state.substate },
            );
          } else if (
            state.phase === STREAM_PHASE.COMPLETED ||
            state.phase === STREAM_PHASE.FAILED ||
            state.phase === STREAM_PHASE.CANCELLED
          ) {
            this.status.transitionToTerminal(
              streamId,
              state.phase,
              STREAM_TRANSITION_CAUSE.LIFECYCLE,
              { substate: state.substate },
            );
          } else {
            this.status.transition(
              streamId,
              state.phase,
              STREAM_TRANSITION_CAUSE.LIFECYCLE,
              { substate: state.substate },
            );
          }
        }
      } catch (rollbackError) {
        throw new AggregateError(
          [replacementError, rollbackError],
          'Workspace storage replacement and rollback both failed',
        );
      }
      return this.restoreRestartRepairAfterReplacementFailure(
        generation,
        replacementError,
      );
    }
  }

  private async restoreRestartRepairAfterReplacementFailure(
    generation: number,
    replacementError: unknown,
  ): Promise<never> {
    try {
      await this.runRestartRepair(generation);
    } catch (repairError) {
      throw new AggregateError(
        [replacementError, repairError],
        'Workspace storage replacement failed and restored restart repair also failed',
      );
    }
    throw replacementError;
  }

  /** Transition every transcript-unfinished stream to RUNNING ahead of restart repair. */
  private markUnfinishedStreamsRunning(): void {
    for (const streamId of this.transcripts.getUnfinishedStreamIds()) {
      this.status.transition(
        streamId,
        STREAM_PHASE.RUNNING,
        STREAM_TRANSITION_CAUSE.LIFECYCLE,
      );
    }
  }

  private async runRestartRepair(generation: number): Promise<void> {
    if (
      generation !== this.storageGeneration ||
      this.restartRepairAbort.signal.aborted
    ) {
      return;
    }
    const snapshotExecutionIds = this.snapshots.getExecutionIdMap();
    const executionIds = new Map(snapshotExecutionIds);
    const unresolvedStreams = new Set<StreamTabId>();
    for (const streamId of this.transcripts.keys()) {
      if (executionIds.has(streamId)) continue;
      try {
        // The stream→execution reverse edge is the persisted sidecar FK;
        // name resemblance is never ownership. A stream without one stays
        // unmapped and is skipped by repair.
        const persisted =
          await this.snapshots.readPersistedExecutionId(streamId);
        if (persisted) executionIds.set(streamId, persisted);
      } catch (error) {
        // A transient storage failure proves nothing about this stream. Leave
        // it out of this pass — repairing it unmapped would skip its lease
        // guard — instead of aborting repair for every other stream.
        unresolvedStreams.add(streamId);
        logger.warn(
          `Skipped restart repair for stream ${streamId}: its execution identity could not be read`,
          { data: error },
        );
      }
    }
    let waitingStreams: Set<StreamTabId>;
    let repairStreams: Set<StreamTabId>;
    try {
      waitingStreams = await detectWaitingStreams(executionIds);
      repairStreams = new Set(
        [
          ...this.transcripts.getUnfinishedStreamIds(),
          ...waitingStreams,
        ].filter((streamId) => !unresolvedStreams.has(streamId)),
      );
    } catch (error) {
      logger.warn('Failed to detect resumable streams during restart repair', {
        data: error,
      });
      waitingStreams = new Set();
      repairStreams = new Set(
        this.transcripts
          .getUnfinishedStreamIds()
          .filter(
            (streamId) =>
              !snapshotExecutionIds.has(streamId) &&
              !unresolvedStreams.has(streamId),
          ),
      );
    }
    if (
      generation !== this.storageGeneration ||
      this.restartRepairAbort.signal.aborted
    ) {
      return;
    }

    const result = await repairRestartedStreams({
      streamStatus: this.status,
      waitingStreams,
      executionIds,
      repairStreams,
      closeRunningGroups: async (streamIds, status, now) => {
        // StreamLogStore commits each settlement through its onChange channel;
        // attached progress bridges therefore receive dirty-entry deltas
        // without a host-specific full-view refresh.
        const closed = await this.transcripts.endRunningGroupsForStreams(
          streamIds,
          now,
          status,
        );
        if (closed.length > 0) await this.transcripts.flush();
        return closed;
      },
      logger,
      signal: this.restartRepairAbort.signal,
    });
    if (this.restartRepairAbort.signal.aborted) return;
    this.restartRepairRetry.schedule(result.nextLeaseCheckAt, () => {
      void this.enqueueRestartRepair(() =>
        this.runRestartRepair(generation),
      ).catch((error: unknown) => {
        logger.warn('Failed delayed restart repair', { data: error });
      });
    });
  }

  useHostInteractions(interactions: HostInteractions): () => void {
    return this.interactions.use(interactions);
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

  private readonly missedTerminalResults = new Map<
    ResultEvent['executionId'],
    ResultEvent
  >();
  /** Currently-subscribed `onResult` listeners that asked for missed replay. */
  private replayResultListenerCount = 0;
  private replayMissedResultsEnabled = false;
  /**
   * Disposers for active `onResult` hub subscriptions, so `dispose()` can
   * drop them like the pre-hub listener set did — a late `publishRunEvent`
   * after teardown must not reach host closures.
   */
  private readonly resultListenerDetachers = new Set<() => void>();
  private disposeStarted = false;

  /**
   * Subscribe to terminal `result` events for runs in this session. Hosts hold
   * the session, so this is how they receive a run's outcome — per-run traces
   * are created inside the run and are not reachable from the host otherwise.
   *
   * Delivery rides the session event hub (`result` events travel as run-scoped
   * facts); this method only adds the missed-terminal-result replay that the
   * hub deliberately has no concept of.
   */
  onResult(
    listener: (event: ResultEvent) => void,
    options: { replayMissed?: boolean } = {},
  ): () => void {
    const replayMissed = options.replayMissed ?? false;
    const detach = this.events.subscribeRunFacts(
      ({ event }) => listener(event),
      { types: ['result'] },
    );
    let disposed = false;
    if (replayMissed) {
      this.replayResultListenerCount += 1;
      this.replayMissedResultsEnabled = true;
      queueMicrotask(() => {
        if (disposed) return;
        const missed = [...this.missedTerminalResults.values()];
        this.missedTerminalResults.clear();
        for (const event of missed) {
          try {
            listener(event);
          } catch (err) {
            logger.warn('onResult listener threw', { data: err });
          }
        }
      });
    }
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      this.resultListenerDetachers.delete(dispose);
      if (replayMissed) this.replayResultListenerCount -= 1;
      detach();
    };
    this.resultListenerDetachers.add(dispose);
    return dispose;
  }

  /**
   * Bridge a run's trace into this session's event hub: re-publish each event
   * as a run-scoped fact. Returns a detach disposer the run bundles into its
   * trace teardown.
   */
  attachRunTrace(trace: AgentTrace, streamId: StreamTabId): () => void {
    return trace.subscribe((event) => this.publishRunEvent(streamId, event));
  }

  /**
   * Forward one run-scoped event to this session's event bus, recording
   * terminal `result` events for missed replay when no replay-subscribed
   * listener is attached. Shared by `attachRunTrace` (the live per-run trace
   * subscription above) and by `ExecutionRegistry`'s injected `publishResult`
   * callback (see `attachSessionEvents`), which needs the identical
   * forwarding for a terminal event synthesized *after* the originating run's
   * own trace has already been disposed — killing a native subagent suspended
   * at WAITING (`terminateWaitingHandle`) settles `handle.result` and the
   * run's own (already-torn-down) trace, but has no other way to reach this
   * session's `onResult` subscribers.
   */
  publishRunEvent(streamId: StreamTabId, event: AgentEvent): void {
    if (event.type === 'result') {
      if (this.replayResultListenerCount > 0) {
        this.missedTerminalResults.delete(event.executionId);
      } else if (
        this.replayMissedResultsEnabled &&
        isReplayableTerminalResult(event)
      ) {
        this.missedTerminalResults.set(event.executionId, event);
      }
    }
    this.events.emit({ scope: 'run', streamId, event });
  }

  /**
   * Tear down everything this session owns. Order matters: drain this session's
   * pending trace writes, drop subscription disposers, dispose the execution
   * registry, settle pending host interactions via `interactions.dispose()`,
   * and drop result listeners. Deregistration from `liveSessions` happens even
   * when either phase fails, and every collected failure returns only after
   * teardown has been attempted.
   */
  dispose(): void {
    if (this.disposeStarted) return;
    this.disposeStarted = true;

    const failures: unknown[] = [];
    try {
      this.flushPendingTraces();
    } catch (error) {
      failures.push(error);
    }
    try {
      this.teardownOwners();
    } catch (error) {
      failures.push(error);
    } finally {
      liveSessions.delete(this);
    }
    throwAggregated(failures, 'Session teardown failed');
  }

  /** Dispose the runtime owners and drop result listeners. */
  private teardownOwners(): void {
    this.restartRepairAbort.abort();
    this.restartRepairRetry.dispose();
    this.subscriptions.dispose();
    this.executions.dispose();
    // Drop bypass state before the interaction slot settles pending approvals.
    this.approvals.clearAll();
    this.modelRetries.dispose();
    this.interactions.dispose();
    this.detachSnapshotEvents();
    this.artifactFlushers.clear();
    for (const detach of [...this.resultListenerDetachers]) detach();
    this.missedTerminalResults.clear();
  }
}

/** Live sessions whose background processes must be stopped at shutdown. */
const liveSessions = new Set<SessionHandle>();

/** Stop background OS processes owned by every live runtime session. */
export function killAllSessionBackgroundProcesses(): void {
  for (const session of liveSessions) {
    session.executions.killBackgroundProcesses();
  }
}

let cachedDefaultSession: SessionHandle | undefined;
let defaultSessionFallbackWarned = false;

export type DefaultSessionInit = Omit<SessionHandleInit, 'flushers'>;

/** Install the process-default session after its transcript store is valid. */
export function initializeDefaultSession(
  init: DefaultSessionInit,
): SessionHandle {
  if (cachedDefaultSession) {
    throw new Error('The default session has already been initialized.');
  }
  cachedDefaultSession = new SessionHandle(init);
  return cachedDefaultSession;
}

/** Inspect whether the host has installed its process-default session. */
export function tryDefaultSession(): SessionHandle | undefined {
  return cachedDefaultSession;
}

/** Clear and dispose the process-default session during host teardown. */
export function teardownDefaultSession(): void {
  const session = cachedDefaultSession;
  cachedDefaultSession = undefined;
  session?.dispose();
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
  if (!cachedDefaultSession) {
    throw new Error(
      'The default session has not been initialized. Call initializeDefaultSession() after opening its transcript store.',
    );
  }
  const processDefault = cachedDefaultSession;
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
