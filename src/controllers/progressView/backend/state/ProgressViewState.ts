import pMap from 'p-map';
import { z } from 'zod';

import type { AgentTrace } from '@agent/trace';
import { createChannelTrace } from '@agent/trace';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import type { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import {
  defaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import {
  SessionStores,
  type DeleteAllStreamsResult,
  type DeleteStreamResult,
} from '@agent/runtime/SessionStores';
import type { StateStore } from '@platform/interfaces';
import {
  AgentCategoryFilterSchema,
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type RunOutcome,
  type ActiveChildInfo,
  type AgentCategoryFilter,
  type ConversationProgress,
  type ExecutionId,
  type PhaseStage,
  type RoundStage,
  type StreamTabId,
} from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import {
  PersistedState,
  createBackendStorage,
} from '@shared/state/PersistedState';
import { isProcessAgent } from '@shared/streams/agentKind';
import { isActivePhase } from '@shared/streams/streamStatus';
import { GoalStore } from '@tools/goal';
import type { StreamLogStore, StreamSnapshotStore } from '@transcript';
import { clamp } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
/** Bounded fan-out for the one-time legacy-instruction backfill at load(),
 *  mirroring `StreamSnapshotStore`'s own per-stream disk-read concurrency. */
const LEGACY_INSTRUCTION_BACKFILL_CONCURRENCY = 8;

/**
 * Config-derived run details: undefined until the stream's `RunConfig`
 * snapshot resolves (see `applySnapshotMetadata`), at which point `kind` and
 * every field below are always populated together from that one `AgentConfig`
 * — they can't drift independently of each other the way top-level
 * `ProgressStreamMetadata` fields (set by separate calls at separate times)
 * can. `kind` mirrors the three owners `buildStreamTabInfo` renders
 * differently: a `process` runs a raw OS tool, an `agent` is LLM-driven, and
 * a `workflowScript` is a deterministic orchestration container whose worker
 * agents run in child streams.
 */
type ProgressStreamRunDetails =
  | {
      kind: 'process';
      agent: string;
      instruction: string;
      workingDirectory?: string;
    }
  | {
      kind: 'agent';
      agent: string;
      inputFile?: string;
      model: string;
      instruction: string;
      workingDirectory?: string;
    }
  | {
      kind: 'workflowScript';
      workflowName: string;
      instruction: string;
      workingDirectory?: string;
    };

/** Canonical current metadata used by every progress-view stream consumer. */
export interface ProgressStreamMetadata {
  agentCategory?: AgentCategory;
  isRemote?: boolean;
  creationTimestamp: number;
  executionId?: ExecutionId;
  parentStreamId?: StreamTabId;
  description?: string;
  run?: ProgressStreamRunDetails;
}

/** Ephemeral session state per stream (not persisted). */
interface StreamSessionState {
  metadata: ProgressStreamMetadata;
}

/** Active stream identifier, or empty string when no stream is selected. */
export type ActiveStreamId = StreamTabId | '';

/** Schema for consolidated progress view preferences. */
const ProgressViewPrefsSchema = z.object({
  activeStream: z.string().prefault('') as z.ZodType<ActiveStreamId>,
  agentCategoryFilter: AgentCategoryFilterSchema.prefault('all'),
});

type ProgressViewPrefs = z.infer<typeof ProgressViewPrefsSchema>;

/**
 * Backend-owned ephemeral counters, updated during streaming.
 */
export interface StreamExecutionState {
  kind: (typeof AgentCategory)[keyof typeof AgentCategory];
  conversationProgress: ConversationProgress;
  roundStage?: RoundStage;
  phaseStage?: PhaseStage;
  /** Live children plus the finished ones retained for display (`finishedAt`
   *  set). */
  subagents: ActiveChildInfo[];
}

/**
 * Per-stream child-activity roster, projected from
 * {@link StreamExecutionState}. Sent to the webview on tab switch and whenever
 * subagent activity changes.
 */
export type StreamBadgeSnapshot = Pick<StreamExecutionState, 'subagents'>;

function createExecutionState(
  kind: (typeof AgentCategory)[keyof typeof AgentCategory],
): StreamExecutionState {
  return {
    kind,
    conversationProgress: { toolCallCount: 0 },
    subagents: [],
  };
}

/**
 * Core state management for the progress view.
 *
 * Coordinates two persistence stores — `streamLogs` (transcript) and
 * `snapshots` (all per-stream sidecar: output files, usage, todos, plan, and
 * meta) — plus ephemeral in-memory execution state and preferences. Workflow
 * instructions live in the log stream (new runs write them directly; legacy
 * runs are backfilled there during load), not in separate progress-view state.
 */
export class ProgressViewState {
  // -- Persistence managers ---------------------------------------------------
  readonly streamLogs: StreamLogStore;
  /** Single owner of all per-stream sidecar state (output files, usage, todos,
   * plan, taskState/executionId/parent/description + meta queries). */
  readonly snapshots: StreamSnapshotStore;
  /** Atomic lifecycle owner across streamLogs, streamData, and executions. */
  readonly stores: SessionStores;

  // -- Preferences ------------------------------------------------------------
  private _prefs!: PersistedState<ProgressViewPrefs>;

  // -- Ephemeral state (session-only, not persisted) --------------------------
  private _streamStates = new Map<StreamTabId, StreamExecutionState>();
  private _sessionState = new Map<StreamTabId, StreamSessionState>();

  readonly streamStatus: StreamStatusMachine;
  readonly followUps: ToolUseFollowUpQueue;

  private readonly logger: AgentTrace;
  private readonly session: SessionHandle;

  constructor(
    storage: StateStore,
    session: SessionHandle = defaultSession(),
    stores?: SessionStores,
  ) {
    this.logger = createChannelTrace('ProgressViewState');
    this.session = session;
    this.streamStatus = session.status;
    this._prefs = new PersistedState(
      createBackendStorage(storage),
      WorkspaceStateKey.PROGRESS_VIEW_PREFS,
      ProgressViewPrefsSchema,
    );
    this.streamLogs = session.transcripts;
    this.followUps = session.followUps;
    this.snapshots = session.snapshots;
    this.stores =
      stores ??
      new SessionStores({
        streamLogs: this.streamLogs,
        snapshots: this.snapshots,
        goalEntries: {
          forget: (stream) => GoalStore.forget(stream, this.session),
          forgetMany: (streams) => GoalStore.forgetMany(streams, this.session),
        },
      });
  }

  // -- Preferences ------------------------------------------------------------

  get activeStream(): ActiveStreamId {
    return this._prefs.get('activeStream');
  }

  set activeStream(stream: ActiveStreamId) {
    this._prefs.update({ activeStream: stream });
  }

  /**
   * Compute which stream should be active given available streams (pure query).
   */
  pickValidActiveStream(availableStreams: StreamTabId[]): StreamTabId {
    const current = this._prefs.get('activeStream');
    if (availableStreams.includes(current)) {
      return current;
    }
    return availableStreams[0] || current;
  }

  /**
   * Release a previously-active stream's entries if its status is not
   * in-flight. `ProgressFactApplier.setStreamStatus` intentionally skips
   * eviction for the active tab, so every active-stream switch path must
   * call this on the stream being moved away from to close the loop.
   */
  releasePreviousActive(streamId: StreamTabId): void {
    if (!isActivePhase(this.streamStatus.get(streamId))) {
      this.streamLogs.requestEviction(streamId);
    }
  }

  get agentCategoryFilter(): AgentCategoryFilter {
    return this._prefs.get('agentCategoryFilter');
  }

  set agentCategoryFilter(filter: AgentCategoryFilter) {
    if (!AgentCategoryFilterSchema.safeParse(filter).success) {
      this.logger.warn(`Invalid agent filter: ${filter}, defaulting to 'all'`);
      filter = 'all';
    }
    this._prefs.update({ agentCategoryFilter: filter });
  }

  // -- Ephemeral session state ------------------------------------------------

  private getOrCreateSession(
    stream: StreamTabId,
    creationTimestamp?: number,
  ): StreamSessionState {
    let state = this._sessionState.get(stream);
    if (!state) {
      state = {
        metadata: {
          creationTimestamp:
            this.streamLogs.getFirstTimestamp(stream) ??
            creationTimestamp ??
            Date.now(),
        },
      };
      this._sessionState.set(stream, state);
    }
    return state;
  }

  private applySnapshotMetadata(
    stream: StreamTabId,
    metadata: ProgressStreamMetadata,
  ): void {
    const config = this.snapshots.getRunConfig(stream);
    if (config) {
      const descriptor = this.snapshots.getRunDescriptor(stream);
      const identityName = descriptor?.agent ?? config.agent;
      const runKind =
        descriptor?.kind ??
        (isProcessAgent(config.agent) ? 'process' : 'agent');
      metadata.agentCategory = descriptor?.category ?? config.agentCategory;
      const workingDirectory = config.workingDirectory ?? undefined;
      if (runKind === 'workflowScript') {
        metadata.run = {
          kind: 'workflowScript',
          workflowName: identityName,
          instruction: config.instruction,
          workingDirectory,
        };
      } else if (runKind === 'process') {
        metadata.run = {
          kind: 'process',
          agent: identityName,
          instruction: config.instruction,
          workingDirectory,
        };
      } else {
        metadata.run = {
          kind: 'agent',
          agent: identityName,
          inputFile: config.inputFiles?.at(0),
          model: config.model,
          instruction: config.instruction,
          workingDirectory,
        };
      }
    }

    metadata.executionId =
      this.snapshots.getExecutionId(stream) ?? metadata.executionId;
    metadata.parentStreamId =
      this.snapshots.getParentStreamId(stream) ?? metadata.parentStreamId;
    metadata.description =
      this.snapshots.getDescription(stream) ?? metadata.description;
  }

  /**
   * Apply metadata known before durable task state catches up. Snapshot-owned
   * fields are re-applied here so late events cannot override authoritative
   * config, execution, hierarchy, or description data.
   */
  updateStreamMetadata(
    stream: StreamTabId,
    patch: Partial<ProgressStreamMetadata>,
  ): void {
    const state = this.getOrCreateSession(stream, patch.creationTimestamp);
    const creationTimestamp = state.metadata.creationTimestamp;
    state.metadata = { ...state.metadata, ...patch, creationTimestamp };
    this.applySnapshotMetadata(stream, state.metadata);
  }

  /** Re-apply newly loaded snapshot authority without changing live-only data. */
  refreshStreamMetadataFromSnapshot(stream: StreamTabId): void {
    const metadata = this.getOrCreateSession(stream).metadata;
    this.applySnapshotMetadata(stream, metadata);
  }

  /**
   * Start a run from durable metadata, retaining only the tab's original
   * creation time from its previous provisional/live record.
   */
  resetStreamMetadataForRun(stream: StreamTabId): void {
    const state = this.getOrCreateSession(stream);
    state.metadata = {
      creationTimestamp: state.metadata.creationTimestamp,
    };
    this.applySnapshotMetadata(stream, state.metadata);
  }

  /**
   * Read effective metadata, creating the ephemeral record when needed. Once
   * the transcript has entries, its actual first timestamp replaces any
   * provisional or restored timestamp used before the log became available.
   */
  getStreamMetadata(stream: StreamTabId): Readonly<ProgressStreamMetadata> {
    const metadata = this.getOrCreateSession(stream).metadata;
    const firstTimestamp = this.streamLogs.getFirstTimestamp(stream);
    if (firstTimestamp !== undefined) {
      metadata.creationTimestamp = firstTimestamp;
    }
    return metadata;
  }

  setStreamParent(
    stream: StreamTabId,
    parent: StreamTabId | null | undefined,
  ): void {
    const metadata = this.getOrCreateSession(stream).metadata;
    metadata.parentStreamId = parent ?? undefined;
  }

  setStreamDescription(stream: StreamTabId, description: string): void {
    this.getOrCreateSession(stream).metadata.description = description;
  }

  // todos/plan are owned + persisted by StreamSnapshotStore (workPlan.json).

  // -- Ephemeral execution state ----------------------------------------------

  getOrCreateStreamState(
    stream: StreamTabId,
    agentCategory: (typeof AgentCategory)[keyof typeof AgentCategory],
  ): StreamExecutionState {
    const existing = this._streamStates.get(stream);
    if (!existing || existing.kind !== agentCategory) {
      const state = createExecutionState(agentCategory);
      this._streamStates.set(stream, state);
      return state;
    }
    return existing;
  }

  updateStreamState(
    stream: StreamTabId,
    updater: (prev: StreamExecutionState) => StreamExecutionState,
  ): void {
    const current = this._streamStates.get(stream);
    if (current) {
      this._streamStates.set(stream, updater(current));
    }
  }

  /** Reset per-run ephemeral child state when a new run starts on the same
   *  stream — retained finished children belong to the previous run. */
  resetPerRunChildState(stream: StreamTabId): void {
    const current = this._streamStates.get(stream);
    if (!current) return;

    const retainedSubagents = current.subagents.filter(
      (child) => child.finishedAt !== undefined,
    );
    const needsReset =
      retainedSubagents.length > 0 ||
      current.conversationProgress.toolCallCount !== 0 ||
      current.roundStage !== undefined ||
      current.phaseStage !== undefined;

    if (needsReset) {
      this._streamStates.set(stream, {
        ...current,
        subagents: current.subagents.filter(
          (child) => child.finishedAt === undefined,
        ),
        conversationProgress: { toolCallCount: 0 },
        roundStage: undefined,
        phaseStage: undefined,
      });
    }
  }

  getStreamState(stream: StreamTabId): StreamExecutionState | undefined {
    return this._streamStates.get(stream);
  }

  /**
   * Project a stream's child roster for the wire. `streamStatus` — not the
   * roster row — owns a subagent's phase: a child's roster drop can arrive
   * BEFORE its terminal status (the cancel path untracks the handle, then
   * transitions the stream), so the status stamped into a retained row at drop
   * time can read `running` forever. Resolve it here, at the one boundary every
   * roster-carrying payload passes through — badges, the tab-switch content
   * sync, and the structural `UPDATE_STREAMS` / `UPDATE_STREAM_METADATA`
   * rebuild alike — so no send path can ship the stale stamped value.
   */
  projectChildRosters(state: StreamExecutionState): StreamBadgeSnapshot {
    return {
      subagents: state.subagents.map((child) =>
        child.kind === 'subagent'
          ? {
              ...child,
              status:
                this.streamStatus.get(child.childStreamId) ?? child.status,
            }
          : child,
      ),
    };
  }

  getAllStreamStates(): ReadonlyMap<StreamTabId, StreamExecutionState> {
    return this._streamStates;
  }

  async endRunningTaskGroups(
    now: number = Date.now(),
    streamIds?: readonly StreamTabId[],
    status?: RunOutcome,
  ): Promise<StreamTabId[]> {
    const affectedFromLogs = streamIds
      ? await this.streamLogs.endRunningGroupsForStreams(streamIds, now, status)
      : await this.streamLogs.endRunningGroups(now, [], status);
    if (affectedFromLogs.length > 0) {
      await this.streamLogs.save();
    }
    return affectedFromLogs;
  }

  // -- Lifecycle --------------------------------------------------------------

  waitForOwnedExecutionRelease(stream: StreamTabId): Promise<void> {
    return this.stores.waitForOwnedExecutionRelease(stream);
  }

  async clearStream(stream: StreamTabId): Promise<DeleteStreamResult> {
    const deletion = await this.stores.deleteStream(stream);
    if (deletion !== 'deleted') return deletion;

    this.streamStatus.clearStream(stream);
    this._sessionState.delete(stream);
    this._streamStates.delete(stream);

    // Update active stream *after* deletion so keys() no longer includes it.
    if (this._prefs.get('activeStream') === stream) {
      this._prefs.update({ activeStream: this.topmostStreamTab() });
    }
    return 'deleted';
  }

  async clearAll(): Promise<DeleteAllStreamsResult> {
    this.logger.warn(
      '[Persistence] clearAll() called - this will delete all persisted data!',
      { data: { stack: new Error().stack } },
    );

    const knownStreams = new Set<StreamTabId>([
      ...this.streamLogs.keys(),
      ...this._sessionState.keys(),
      ...this._streamStates.keys(),
      ...[...this.streamStatus.entries()].map(([stream]) => stream),
    ]);
    const deletion = await this.stores.deleteAll();
    const retainedStreams = new Set([...deletion.active, ...deletion.failed]);
    for (const stream of knownStreams) {
      if (retainedStreams.has(stream)) continue;
      this.streamStatus.clearStream(stream);
      this._sessionState.delete(stream);
      this._streamStates.delete(stream);
    }
    if (retainedStreams.size === 0) {
      this._prefs.reset();
    } else if (!retainedStreams.has(this._prefs.get('activeStream'))) {
      this._prefs.update({ activeStream: this.topmostStreamTab() });
    }
    return deletion;
  }

  async load(stateOwnership: 'backend' | 'session' = 'backend'): Promise<void> {
    this.logger.info('[Persistence] Starting state load from storage');

    // ProgressBackend waits for SessionHandle readiness before entering this
    // method. The session owns transcript opening and sidecar hydration; a
    // presentation must never reload those live stores.
    await this.stores.waitForPendingStreamDeletions();

    const streamIds = this.streamLogs.keys();
    this.logger.info(`[Persistence] Discovered ${streamIds.length} stream(s)`);

    if (stateOwnership === 'backend') {
      const sweep = await this.stores.sweepOrphanedStreams(new Set(streamIds));
      if (sweep.streams.length > 0) {
        this.logger.info(
          `[Persistence] Removed ${sweep.streams.length} orphaned stream sidecar(s) and ${sweep.executionIds.length} execution dir(s)`,
          { data: sweep },
        );
      }
    }
    for (const stream of streamIds) {
      this.resetStreamMetadataForRun(stream);
    }

    const restoredLegacyInstructionCount =
      await this.backfillLegacyWorkflowInstructions(streamIds);
    if (restoredLegacyInstructionCount > 0) {
      this.logger.info(
        `[Persistence] Restored ${restoredLegacyInstructionCount} legacy workflow instruction(s) into stream logs`,
      );
    }

    this.logger.info('[Persistence] Managers loaded');

    this.validateActiveStream();

    this.logger.info('[Persistence] State load complete');
  }

  /** Drop workspace-scoped caches before loading a replacement storage root. */
  resetAfterStorageRootChange(): void {
    this._prefs.reload();
    this._sessionState.clear();
    this._streamStates.clear();
  }

  /**
   * Flush pending writes from all managers.
   */
  async flush(): Promise<void> {
    this.session.flushPendingTraces();
    await Promise.all([this.streamLogs.flush(), this.snapshots.flush()]);
  }

  // -- Private helpers --------------------------------------------------------

  /**
   * Backfill each stream's archived pre-#3061 per-run instruction (see
   * `readLegacyInstruction` in `@transcript`) into its log as a user-message
   * entry, if not already present. Covers workflow tabs created before the
   * one-run-per-tab refactor (2026-04-19) whose only record of the original
   * prompt is the archival `legacyInstructions.json`/`runInstructions.json`
   * sidecar — there is no retention policy or GC for `streamData/`, so those
   * tabs can still be reopened today. Bounded fan-out mirrors
   * `StreamSnapshotStore`'s own per-stream disk-read concurrency.
   */
  private async backfillLegacyWorkflowInstructions(
    streamIds: readonly StreamTabId[],
  ): Promise<number> {
    let restoredCount = 0;

    await pMap(
      streamIds,
      async (streamId) => {
        try {
          const legacyInstruction =
            await this.snapshots.readLegacyInstruction(streamId);
          if (!legacyInstruction) return;

          const text = legacyInstruction.text.trim();
          if (!text) return;

          const writer = await this.streamLogs.loadAndAcquireWriter(
            streamId,
            `legacy-instruction:${streamId}`,
          );
          try {
            const log = this.streamLogs.get(streamId);
            if (!log) return;

            const alreadyPresent = log
              .getRange(0, log.head)
              .some(
                (entry) =>
                  entry.type === STREAM_LOG_ENTRY_TYPES.LOG &&
                  entry.messageType === MESSAGE_TYPES.USER_MESSAGE &&
                  entry.text?.trim() === text,
              );
            if (alreadyPresent) return;

            const firstTimestamp = log.firstTimestamp;
            const baseTimestamp =
              legacyInstruction.timestamp ?? firstTimestamp ?? Date.now();
            const timestamp =
              firstTimestamp == null
                ? baseTimestamp
                : clamp(baseTimestamp, 0, firstTimestamp - 1);

            writer.append({
              id: `legacy-instruction:${streamId}:${timestamp}`,
              type: STREAM_LOG_ENTRY_TYPES.LOG,
              level: LOG_LEVELS.INFO,
              timestamp,
              messageType: MESSAGE_TYPES.USER_MESSAGE,
              text: legacyInstruction.text,
              data: { source: 'legacyInstruction' },
            });
          } finally {
            writer.close();
          }
          restoredCount++;
        } catch (err) {
          this.logger.warn(
            `[Persistence] Failed to backfill legacy instruction for ${streamId}: ${toErrorMessage(err)}`,
            { data: err },
          );
        }
      },
      { concurrency: LEGACY_INSTRUCTION_BACKFILL_CONCURRENCY },
    );

    return restoredCount;
  }

  /**
   * The topmost (newest) visible stream tab, or '' when none exist.
   *
   * `streamLogs.keys()` is ascending by creation time (load() sorts by
   * `firstTimestamp` ASC, session additions are appended), but the sidebar
   * renders newest-first, so `.at(-1)` matches the topmost visible tab rather
   * than the oldest one at the bottom.
   */
  private topmostStreamTab(): ActiveStreamId {
    return this.streamLogs.keys().at(-1) ?? '';
  }

  /** Validate activeStream against available streams after load */
  private validateActiveStream(): void {
    const savedActiveStream = this._prefs.get('activeStream');
    if (!savedActiveStream || !this.streamLogs.has(savedActiveStream)) {
      const fallback = this.topmostStreamTab();
      if (fallback !== savedActiveStream) {
        this._prefs.update({ activeStream: fallback });
      }
    }
  }
}
