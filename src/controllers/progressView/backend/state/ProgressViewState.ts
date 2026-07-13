import pMap from 'p-map';
import { z } from 'zod';

import { StreamSnapshotStore, type StreamLogStore } from '@transcript';
import type { AgentTrace } from '@agent/trace';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import type { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import {
  defaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { isInFlightPhase } from '@common/constants/streamStatus';
import { createChannelTrace } from '@logger';
import {
  AgentCategoryFilterSchema,
  ContextStateDataSchema,
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type RunOutcome,
  StreamTabInfoBaseSchema,
  type ActiveChildInfo,
  type AgentCategoryFilter,
  type ConversationProgress,
  type ContextStateData,
  type RoundStage,
  type StreamTabId,
} from '@shared/schemas';
import {
  PersistedState,
  createBackendStorage,
} from '@shared/state/PersistedState';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { GoalStore } from '@tools/goal';
import { clamp } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { SessionStores } from './SessionStores';
import type { MementoStorage } from '@controllers/progressView/backend/persistence/PersistentMapManager';

/** Bounded fan-out for the one-time legacy-instruction backfill at load(),
 *  mirroring `StreamSnapshotStore`'s own per-stream disk-read concurrency. */
const LEGACY_INSTRUCTION_BACKFILL_CONCURRENCY = 8;

/** Ephemeral stream metadata hints, displayed before TaskState is fully populated. */
const StreamHintsSchema = StreamTabInfoBaseSchema.pick({
  agent: true,
  agentCategory: true,
  inputFile: true,
  isRemote: true,
  creationTimestamp: true,
  executionId: true,
  parentStreamId: true,
  description: true,
}).partial();

export type StreamHints = z.infer<typeof StreamHintsSchema>;

/** Ephemeral session state per stream (not persisted). */
const StreamSessionStateSchema = z.object({
  hints: StreamHintsSchema.prefault({}),
  contextState: ContextStateDataSchema.nullable().prefault(null),
});

type StreamSessionState = z.output<typeof StreamSessionStateSchema>;

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
  activeSubagents: ActiveChildInfo[];
  finishedSubagentCount: number;
  activeProcesses: ActiveChildInfo[];
  finishedProcessCount: number;
}

/**
 * Per-stream child-activity badge counts, projected from
 * {@link StreamExecutionState}. Sent to the webview on tab switch and whenever
 * subagent/process activity changes.
 */
export type StreamBadgeSnapshot = Pick<
  StreamExecutionState,
  | 'activeSubagents'
  | 'finishedSubagentCount'
  | 'activeProcesses'
  | 'finishedProcessCount'
>;

function createExecutionState(
  kind: (typeof AgentCategory)[keyof typeof AgentCategory],
): StreamExecutionState {
  return {
    kind,
    conversationProgress: { toolCallCount: 0 },
    activeSubagents: [],
    finishedSubagentCount: 0,
    activeProcesses: [],
    finishedProcessCount: 0,
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
    storage: MementoStorage,
    snapshots = new StreamSnapshotStore(),
    session: SessionHandle = defaultSession(),
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
    this.snapshots = snapshots;
    this.stores = new SessionStores({
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
    if (!isInFlightPhase(this.streamStatus.get(streamId))) {
      this.streamLogs.releaseEntries(streamId);
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

  private getOrCreateSession(stream: StreamTabId): StreamSessionState {
    let state = this._sessionState.get(stream);
    if (!state) {
      state = StreamSessionStateSchema.parse({});
      this._sessionState.set(stream, state);
    }
    return state;
  }

  updateStreamHints(streamTabId: StreamTabId, hints: StreamHints): void {
    const state = this.getOrCreateSession(streamTabId);
    const creationTimestamp =
      state.hints.creationTimestamp ?? hints.creationTimestamp ?? Date.now();
    state.hints = StreamHintsSchema.parse({
      ...state.hints,
      ...hints,
      creationTimestamp,
    });
  }

  getStreamHints(streamTabId: StreamTabId): StreamHints {
    return this._sessionState.get(streamTabId)?.hints ?? {};
  }

  clearStreamHints(streamTabId: StreamTabId): void {
    const state = this._sessionState.get(streamTabId);
    if (state) {
      state.hints =
        state.hints.creationTimestamp === undefined
          ? {}
          : { creationTimestamp: state.hints.creationTimestamp };
    }
  }

  // todos/plan are owned + persisted by StreamSnapshotStore (workPlan.json).

  getContextState(stream: StreamTabId): ContextStateData | undefined {
    return this._sessionState.get(stream)?.contextState ?? undefined;
  }

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

  /** Reset per-run ephemeral counters when a new run starts on the same stream. */
  resetFinishedChildCounters(stream: StreamTabId): void {
    const current = this._streamStates.get(stream);
    if (!current) return;

    const needsReset =
      current.finishedSubagentCount !== 0 ||
      current.finishedProcessCount !== 0 ||
      current.conversationProgress.toolCallCount !== 0 ||
      current.roundStage !== undefined;

    if (needsReset) {
      this._streamStates.set(stream, {
        ...current,
        finishedSubagentCount: 0,
        finishedProcessCount: 0,
        conversationProgress: { toolCallCount: 0 },
        roundStage: undefined,
      });
    }
  }

  getStreamState(stream: StreamTabId): StreamExecutionState | undefined {
    return this._streamStates.get(stream);
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

  async clearStream(stream: StreamTabId): Promise<void> {
    // Clear in-memory state
    this.streamStatus.clearStream(stream);
    this._sessionState.delete(stream);
    this._streamStates.delete(stream);

    await this.stores.deleteStream(stream);

    // Update active stream *after* deletion so keys() no longer includes it.
    if (this._prefs.get('activeStream') === stream) {
      this._prefs.update({ activeStream: this.topmostStreamTab() });
    }
  }

  async clearAll(): Promise<void> {
    this.logger.warn(
      '[Persistence] clearAll() called - this will delete all persisted data!',
      { data: { stack: new Error().stack } },
    );

    // Clear in-memory state
    this.streamStatus.clearAll();
    this._sessionState.clear();
    this._streamStates.clear();
    this._prefs.reset();

    await this.stores.deleteAll();
  }

  async load(): Promise<void> {
    this.logger.info('[Persistence] Starting state load from storage');

    // Load stream logs first — they define the set of known streams
    await this.streamLogs.reload();

    const streamIds = this.streamLogs.keys();
    this.logger.info(`[Persistence] Discovered ${streamIds.length} stream(s)`);

    const sweep = await this.stores.sweepOrphanedStreams(new Set(streamIds));
    if (sweep.streams.length > 0) {
      this.logger.info(
        `[Persistence] Removed ${sweep.streams.length} orphaned stream sidecar(s) and ${sweep.executionIds.length} execution dir(s)`,
        { data: sweep },
      );
    }

    await this.snapshots.load(streamIds);

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

          await this.streamLogs.ensureLoaded(streamId);
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

          this.streamLogs.append(streamId, {
            id: `legacy-instruction:${streamId}:${timestamp}`,
            type: STREAM_LOG_ENTRY_TYPES.LOG,
            level: LOG_LEVELS.INFO,
            timestamp,
            messageType: MESSAGE_TYPES.USER_MESSAGE,
            text: legacyInstruction.text,
            data: { source: 'legacyInstruction' },
          });
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
