/**
 * `SessionHandle` — one owner per session for the runtime's coordination state.
 *
 * It is a **composition record**, not a facade: it re-exposes no per-concern
 * methods, so callers address each owner directly
 * (`session.interactions.x(...)`, `session.executions.y(...)`). Its sole
 * lifecycle gate, {@link SessionHandle.waitUntilReady}, ensures persistent
 * restart repair has settled before a host exposes the session. It composes
 * {@link ExecutionRegistry}, {@link SessionHostInteractions}, and the other
 * session-scoped owners.
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
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import {
  ownsExecutionLease,
  releaseOwnedExecutionLease,
  validateOwnedExecutionLease,
} from '@agent/storage/executionLease';
import { finalizeRun } from '@agent/storage/executionLifecycle';
import {
  listExecutionStreamReferences,
  readExecutionStreamIndex,
} from '@agent/storage/executionListing';
import type { ResponseTextProcessing } from '@latex/texraResponseTextProcessing';
import { createLog } from '@logger/logUtils';
import { DisposableStore } from '@platform/disposable';
import { platform } from '@platform/platform';
import {
  TEXRA_APPROVAL_POLICY_DEFAULT,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import {
  RUN_OUTCOME,
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import {
  isInFlightPhase,
  STREAM_TRANSITION_CAUSE,
} from '@shared/streams/streamStatus';
import { streamUnreadableMessage } from '@shared/streams/streamStatusDisplay';
import type { RunTraceFlushEntry } from '@transcript/runTrace';
import type { StreamLogStore } from '@transcript/StreamLogStore';
import { StreamSnapshotStore } from '@transcript/StreamSnapshotStore';
import { throwAggregated } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { getRunContextSession, tryUseRunContext } from './RunContext';
import { ExecutionRegistry } from './executionRegistry';
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
import { repairRestartedStreams } from './restartRepair';
import { createNeutralResponseTextProcessing } from './responseTextProcessing';

const logger = createLog('sessionHandle');

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

/**
 * A storage-root change was refused because executions are live in this
 * session. Nothing was changed; the caller retries once they have finished.
 */
export class StorageRootChangeRefusedError extends Error {
  constructor(readonly liveExecutionIds: readonly string[]) {
    super(
      `TeXRA cannot change its storage location while ${liveExecutionIds.length} ${liveExecutionIds.length === 1 ? 'run is' : 'runs are'} live in this window. Stop or finish them, then retry the workspace change.`,
    );
    this.name = 'StorageRootChangeRefusedError';
  }
}

export class SessionHandle {
  /**
   * Per-run execution handles: registration, lookup, change listeners, and
   * subagent lineage. Owns the status subscription bound to the hub
   * {@link status} publishes on.
   */
  readonly executions: ExecutionRegistry;
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
  private readonly restartRepairQueue = new PQueue({ concurrency: 1 });
  private readonly restartRepairAbort = new AbortController();
  private storageGeneration = 0;
  /** LIFO owner for the session's constructor-registered teardown. */
  private readonly teardown = new DisposableStore();
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
    const executions = new ExecutionRegistry({
      streamStatus: status,
      events,
      approvals,
      publishResult: (event, streamId) => this.publishRunEvent(streamId, event),
      releaseRootExecutionLease: (executionId) =>
        this.releaseExecutionLease(executionId),
    });

    this.executions = executions;
    this.events = events;
    this.status = status;
    this.transcripts = transcripts;
    this.followUps = followUps;
    // The sidecar store is a session artifact exactly like `transcripts`: the
    // session projects its own run events into it and flushes it below, so no
    // host has to construct, attach, and flush one of its own.
    this.snapshots = init.snapshots ?? new StreamSnapshotStore();
    // The summary sink mirrors snapshot-owned display metadata into the
    // always-resident stream summaries, so sidebars and all-streams metadata
    // paths read summaries instead of per-stream sidecars (#9947). Always
    // writable: this constructor rejects read-only transcript stores above.
    this.detachSnapshotEvents = this.snapshots.attachSessionEvents(events, {
      summaryMetaSink: (stream, meta) =>
        transcripts.recordSummaryMeta(stream, meta),
      summaryMetaSource: (stream) => transcripts.getSummaryMeta(stream),
    });
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
    liveSessions.add(this);
    // Register teardown in reverse LIFO order so `teardown.dispose()` runs the
    // session's shutdown sequence top-to-bottom: drain traces, abort and
    // dispose restart repair, then unwind each owner in dependency order,
    // finally leaving `liveSessions`.
    this.teardown.add(() => {
      liveSessions.delete(this);
    });
    this.teardown.add(() => this.missedTerminalResults.clear());
    this.teardown.add(() => {
      for (const detach of [...this.resultListenerDetachers]) detach();
    });
    this.teardown.add(() => this.artifactFlushers.clear());
    this.teardown.add(() => this.detachSnapshotEvents());
    this.teardown.add(() => this.interactions.dispose());
    this.teardown.add(() => this.modelRetries.dispose());
    // Drop bypass state before the interaction slot settles pending approvals.
    this.teardown.add(() => this.approvals.clearAll());
    this.teardown.add(() => this.executions.dispose());
    this.teardown.add(() => this.followUps.dispose());
    this.teardown.add(() => this.restartRepairAbort.abort());
    this.teardown.add(() => this.flushPendingTraces());
    if (
      this.transcripts.mode.kind === 'persistent' &&
      init.restartRepair !== 'deferred'
    ) {
      this.restartRepairPromise = this.ensureRestartRepair();
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
    return this.ensureRestartRepair().then(() => undefined);
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
    // A storage-root change is refused, not queued, while any execution is
    // live: a run writes under the root it was claimed in, so the two may not
    // overlap. The hold is taken before any session state moves, so a refusal
    // changes nothing; while it is held, launches and resumes are refused.
    let releaseHold: () => void;
    try {
      releaseHold = this.executions.holdLifecycle(
        (live) => new StorageRootChangeRefusedError(live),
        () =>
          new Error(
            'TeXRA is changing its storage location. Start this run again in a moment.',
          ),
      );
    } catch (error) {
      return Promise.reject(error);
    }
    this.storageGeneration += 1;
    const generation = this.storageGeneration;
    const repair = this.enqueueRestartRepair(() =>
      this.repairStoresAfterRestart(generation, true, hooks).finally(
        releaseHold,
      ),
    );
    this.restartRepairPromise = repair;
    return repair;
  }

  private enqueueRestartRepair<T>(work: () => Promise<T>): Promise<T> {
    // `add` widens to `T | void` for abort/timeout options; neither is used.
    return this.restartRepairQueue.add(work) as Promise<T>;
  }

  /**
   * Start the restart-repair pass for the current storage generation, or reuse
   * the in-flight one. Shared by the constructor and {@link waitUntilReady}.
   */
  private ensureRestartRepair(): Promise<unknown> {
    if (!this.restartRepairPromise) {
      this.restartRepairPromise = this.enqueueRestartRepair(() =>
        this.repairStoresAfterRestart(this.storageGeneration),
      );
    }
    return this.restartRepairPromise;
  }

  /**
   * Whether a repair pass started for `generation` may no longer mutate: a
   * later storage generation owns the stores, or session teardown aborted
   * repair. Both reads are pure, so every checkpoint below re-reads them.
   */
  private isRepairSuperseded(generation: number): boolean {
    return (
      generation !== this.storageGeneration ||
      this.restartRepairAbort.signal.aborted
    );
  }

  private async repairStoresAfterRestart(
    generation: number,
    reloadTranscripts = false,
    transitionHooks?: WorkspaceStorageTransitionHooks,
  ): Promise<boolean> {
    try {
      if (this.restartRepairAbort.signal.aborted) return false;
      if (reloadTranscripts) {
        return await this.replaceStoresAfterStorageRootChange(
          generation,
          transitionHooks,
        );
      }
      if (generation !== this.storageGeneration) return false;
      await this.snapshots.preload([...this.computeStartupSeedSet()]);
      if (this.isRepairSuperseded(generation)) return false;
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
    if (this.isRepairSuperseded(generation)) return false;
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
      this.snapshots.evictAll();
      await this.snapshots.preload([...this.computeStartupSeedSet()]);
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
        await this.snapshots.preload([...this.computeStartupSeedSet()]);
        this.status.clearAll();
        // Each phase is restored in one step: the applier treats a RUNNING
        // fact as a run start, so no intermediate phase may be published.
        for (const [streamId, state] of previousStatus) {
          this.status.transition(
            streamId,
            state.phase,
            STREAM_TRANSITION_CAUSE.ROLLBACK,
            { substate: state.substate },
          );
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

  /**
   * The bounded set of streams seeded from their sidecars at startup: every
   * transcript-unfinished stream plus the transitive parent chain behind each
   * one, so active runs and their provenance are resident while settled
   * history stays lazy (#9947). Parent edges come from the always-resident
   * summary mirror, not the sidecars being seeded.
   */
  private computeStartupSeedSet(): ReadonlySet<StreamTabId> {
    const seed = new Set<StreamTabId>();
    const pending = [...this.transcripts.getUnfinishedStreamIds()];
    for (let streamId = pending.pop(); streamId; streamId = pending.pop()) {
      if (seed.has(streamId)) continue;
      seed.add(streamId);
      const parent = this.transcripts.getSummaryMeta(streamId)?.parentStreamId;
      if (parent && !seed.has(parent)) pending.push(parent);
    }
    return seed;
  }

  /**
   * Classify every stream that can carry a run this process does not run,
   * and record what the classification proves. Candidates are the bounded
   * startup seed (transcript-unfinished streams plus their parent chain)
   * and every stream whose execution still holds a resume checkpoint: a
   * stopped or failed run closes its transcript group and keeps its
   * checkpoint, so it is not transcript-unfinished yet must still offer
   * Resume after a restart. The checkpoint set comes from one scan of the
   * execution directory (flow-record `stat` + metadata), never from reading
   * transcripts, so hydration stays bounded (#9947). A stream live in this
   * process (RUNNING/WAITING with a flow context) is never a candidate:
   * in-memory phases are facts about this registry, and startup never
   * remembers one for a run it does not own.
   */
  private async runRestartRepair(generation: number): Promise<void> {
    if (this.isRepairSuperseded(generation)) return;
    const unfinished = new Set(this.transcripts.getUnfinishedStreamIds());
    const candidateSet = new Set(this.computeStartupSeedSet());
    // The scan reads the authoritative `meta.streamId` edge, so it also
    // resolves ownership for a stream whose sidecar and summary mirror never
    // persisted an execution id (a crash before either projection flushed).
    // Resident sidecar identity, merged below, still wins over this seed.
    const scannedExecutionIds = new Map<StreamTabId, ExecutionId>();
    try {
      const { references, unreadable } = await listExecutionStreamReferences({
        checkpointedOnly: true,
      });
      for (const { streamId, executionId } of references) {
        candidateSet.add(streamId);
        scannedExecutionIds.set(streamId, executionId);
      }
      // A checkpointed execution whose storage could not be read has no
      // `meta.streamId` to offer. Its stream is still a candidate: attribute
      // it through the resident execution-id channels so classification
      // reports it unclassified with the cause instead of letting the row
      // vanish from discovery into the ready default.
      if (unreadable.size > 0) {
        const residentExecutionIds = this.snapshots.getExecutionIdMap();
        for (const streamId of this.transcripts.keys()) {
          const executionId = residentExecutionIds.get(streamId);
          if (executionId && unreadable.has(executionId)) {
            candidateSet.add(streamId);
          }
        }
      }
    } catch (error) {
      // The scan proves nothing when it fails; the seed still gets classified.
      logger.warn(
        'Could not list checkpointed executions during restart repair; stopped runs outside the startup seed are not classified',
        { data: error },
      );
    }
    if (this.isRepairSuperseded(generation)) return;
    const candidates = [...candidateSet].filter(
      (streamId) =>
        this.transcripts.has(streamId) &&
        !isInFlightPhase(this.status.get(streamId)),
    );
    const statusGenerationsAtScan = new Map<StreamTabId, object | undefined>();
    for (const streamId of candidates) {
      statusGenerationsAtScan.set(
        streamId,
        this.status.getGeneration(streamId),
      );
    }
    // Resident snapshot records already resolved their execution id from the
    // sidecar when they were seeded (#9947). A candidate outside both the
    // checkpointed scan and the resident set resolves through the authored
    // `meta.streamId` index — one full-directory read, only when needed. A
    // stream absent from all three stays unmapped and is closed as
    // interrupted with nothing recorded.
    const executionIds = new Map([
      ...scannedExecutionIds,
      ...this.snapshots.getExecutionIdMap(),
    ]);
    const unmapped = candidates.filter(
      (streamId) => !executionIds.has(streamId),
    );
    // Streams the index could not prove unowned. Their state is unknown, so
    // they are shown as unavailable (Delete clears them, Resume re-reads)
    // instead of being settled as interrupted on a guess.
    const unreadableStreams = new Map<StreamTabId, string>();
    if (unmapped.length > 0) {
      try {
        const { byStream, unreadable } = await readExecutionStreamIndex();
        for (const streamId of unmapped) {
          const executionId = byStream.get(streamId);
          if (executionId) executionIds.set(streamId, executionId);
        }
        // An execution whose storage could not be read has no `meta.streamId`
        // to attribute, and it may be the owner of any stream still unmapped
        // here. Attribute the unreadable rows to those streams rather than
        // letting them fall through to the ready default.
        if (unreadable.size > 0) {
          const cause = `${unreadable.size} execution record(s) could not be read`;
          for (const streamId of unmapped) {
            if (!executionIds.has(streamId)) {
              unreadableStreams.set(streamId, cause);
            }
          }
        }
      } catch (error) {
        // The index proves nothing when it fails, so neither does the absence
        // of these streams from it.
        const cause = `execution identity unreadable (${toErrorMessage(error)})`;
        for (const streamId of unmapped) unreadableStreams.set(streamId, cause);
        logger.warn(
          'Could not read the stream index during restart repair; unmapped streams are left unavailable',
          { data: error },
        );
      }
    }
    if (this.isRepairSuperseded(generation)) return;
    for (const [streamId, cause] of unreadableStreams) {
      if (
        this.status.getGeneration(streamId) ===
        statusGenerationsAtScan.get(streamId)
      ) {
        this.status.markUnavailable(streamId, streamUnreadableMessage(cause));
      }
    }

    // The ownership scan is async. Refresh resident ownership once here so
    // the map is current, then let `repairRestartedStreams` revalidate each
    // candidate immediately before mutation.
    for (const streamId of candidates) {
      const residentExecutionId = this.snapshots.getRunMetadata(streamId, {
        quiet: true,
      }).executionId;
      if (residentExecutionId) {
        executionIds.set(streamId, residentExecutionId);
      }
    }

    await repairRestartedStreams({
      streamStatus: this.status,
      executionIds,
      // A candidate with no execution is settled only when its transcript is
      // still open (closing it as interrupted is the one honest fact); a
      // closed stream with nothing to classify keeps no phase.
      repairStreams: candidates.filter(
        (streamId) =>
          !unreadableStreams.has(streamId) &&
          (executionIds.has(streamId) || unfinished.has(streamId)),
      ),
      isRepairCandidateCurrent: (streamId, expectedExecutionId) => {
        if (
          this.status.getGeneration(streamId) !==
          statusGenerationsAtScan.get(streamId)
        ) {
          return false;
        }
        const residentExecutionId = this.snapshots.getRunMetadata(streamId, {
          quiet: true,
        }).executionId;
        return (
          residentExecutionId === undefined ||
          residentExecutionId === expectedExecutionId
        );
      },
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
   * constructor callback, which needs the identical
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
   * Tear down everything this session owns through the constructor-registered
   * LIFO store. The store aggregates each disposer's failure and still runs
   * the remaining disposers, including the final `liveSessions` removal.
   */
  dispose(): void {
    this.teardown.dispose();
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
 * given its own: the CANCELLED outcome, its flow record preserved so
 * `deriveResumability` can still offer the checkpoint, and its lease record
 * deleted rather than left for a later launch to prove dead.
 *
 * Bounded by the caller's phase deadline — a host that cannot exit because a
 * release is slow would be worse than the unsettled record. Once `signal`
 * fires, every remaining execution is named in the log instead of being
 * silently skipped: what is left behind is recoverable (the next launch
 * proves this process dead from its pid) but not free.
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
        `Host exit deadline passed before execution ${executionId} was settled; its lease record survives until a later launch proves this process gone`,
      );
      continue;
    }
    // Skips both a run whose driver already settled it and one this process
    // never owned (a run another TeXRA process holds).
    if (!ownsExecutionLease(executionId)) continue;
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
      });
    } catch (error) {
      logger.warn(
        `Failed to settle execution ${executionId} at host exit; a later launch classifies it from its checkpoint`,
        { data: error },
      );
    }
  }
}

let cachedDefaultSession: SessionHandle | undefined;
let defaultSessionFallbackWarned = false;

type DefaultSessionInit = Omit<SessionHandleInit, 'flushers'>;

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

/**
 * Resolve the session an emit should target: an explicit session, else the
 * active run's session, else the process default. This is {@link currentSession}
 * with an explicit-session override, plus `tryDefaultSession()` instead of
 * the throwing `defaultSession()` so bootstrap-tolerant callers (e.g. local
 * storage commands that notify goal state with no observer live) can skip the
 * emit rather than throw. Callers that must not silently drop the emit fall
 * back to `defaultSession()` themselves.
 *
 * A resolved owner is only used when it carries an event hub: an explicit
 * override or run-context session without `.events` (e.g. a call-site stub
 * threaded in for wake-decision routing) falls through to the process default
 * rather than crashing the emit. This preserves the `owner?.events ? owner :
 * defaultSession()` guard the collapsed call sites originally hand-rolled.
 */
export function resolveEmitSession(
  session?: SessionHandle,
): SessionHandle | undefined {
  const owner = session ?? getRunContextSession(tryUseRunContext());
  return owner?.events ? owner : tryDefaultSession();
}
