import pMap from 'p-map';
import { z } from 'zod';

import type { AgentTrace } from '@agent/trace';
import { createChannelTrace } from '@agent/trace';
import {
  SessionStores,
  type DeleteAllStreamsResult,
  type DeleteStreamResult,
} from '@agent/storage';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import type { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import {
  defaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import type { StateStore } from '@platform/interfaces';
import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type ActiveChildInfo,
  type ConversationProgress,
  type ExecutionId,
  type PhaseStage,
  type RoundStage,
  type StreamPhase,
  type StreamTabId,
} from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import {
  PersistedState,
  createBackendStorage,
} from '@shared/state/PersistedState';
import { isProcessAgent } from '@shared/streams/agentKind';
import { compareByNewestCreationTime } from '@shared/streams/streamOrdering';
import { isActivePhase } from '@shared/streams/streamStatus';
import { releaseStreamResources } from '@tools/approval';
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

/**
 * The stored slice of {@link ProgressStreamMetadata}. `creationTimestamp` is
 * not in it: the transcript dates a tab, so it is computed on read rather than
 * carried through every patch that has nothing to say about it.
 */
type StoredStreamMetadata = Omit<ProgressStreamMetadata, 'creationTimestamp'>;

/** Ephemeral session state per stream (not persisted). */
interface StreamSessionState {
  metadata: StoredStreamMetadata;
  /**
   * Creation time to report until the transcript has a first entry to date the
   * tab by. Latched to that entry's timestamp once one exists, so a later
   * eviction cannot move an established tab back to when this session first
   * saw it.
   */
  provisionalCreationTimestamp: number;
}

/** Active stream identifier, or empty string when no stream is selected. */
export type ActiveStreamId = StreamTabId | '';

/** Schema for consolidated progress view preferences. */
const ProgressViewPrefsSchema = z.object({
  activeStream: z.string().prefault('') as z.ZodType<ActiveStreamId>,
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
   * plan, runConfig/executionId/parent/description + meta queries). */
  readonly snapshots: StreamSnapshotStore;
  /** Atomic lifecycle owner across streamLogs, streamData, and executions. */
  readonly stores: SessionStores;

  // -- Preferences ------------------------------------------------------------
  private readonly _prefs: PersistedState<ProgressViewPrefs>;

  // -- Ephemeral state (session-only, not persisted) --------------------------
  private readonly _streamStates = new Map<StreamTabId, StreamExecutionState>();
  private readonly _sessionState = new Map<StreamTabId, StreamSessionState>();

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
        onCanonicalStreamDeleted: (stream) => {
          this.session.status.clearStream(stream);
          releaseStreamResources(stream, this.session);
        },
      });
  }

  // -- Preferences ------------------------------------------------------------

  get activeStream(): ActiveStreamId {
    return this._prefs.get('activeStream');
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
   * eviction for the active tab, so the switch below closes the loop on the
   * stream being moved away from.
   */
  private releasePreviousActive(streamId: StreamTabId): void {
    if (!isActivePhase(this.streamStatus.get(streamId))) {
      this.streamLogs.requestEviction(streamId);
    }
  }

  /**
   * The single writer of the active tab: moves the selection to `next` and
   * releases the tab left behind. There is no `activeStream` setter, so no
   * switching path can forget the release above.
   */
  switchActiveStream(next: ActiveStreamId): void {
    const previous = this._prefs.get('activeStream');
    if (previous === next) return;
    this._prefs.update({ activeStream: next });
    if (previous) this.releasePreviousActive(previous);
  }

  /**
   * Stream tabs offered for selection, newest first — the order
   * `buildStreamInfos` renders. Membership and rotation only depend on
   * creation time, so this answers them without building tab infos or
   * touching the worktree resolver.
   */
  selectableStreamNames(): StreamTabId[] {
    return this.streamLogs
      .keys()
      .map((name) => ({
        name,
        creationTimestamp: this.getStreamMetadata(name).creationTimestamp,
      }))
      .sort(compareByNewestCreationTime)
      .map((entry) => entry.name);
  }

  /**
   * Re-select the active tab from the tabs currently offered, and switch to
   * it. When nothing is selectable the tab is cleared rather than picked:
   * `pickValidActiveStream`'s `[] || current` fallback would otherwise sticky
   * on a stream the caller no longer shows.
   */
  rotateActiveStream(selectableStreams: StreamTabId[]): ActiveStreamId {
    const next =
      selectableStreams.length === 0
        ? ''
        : this.pickValidActiveStream(selectableStreams);
    this.switchActiveStream(next);
    return next;
  }

  // -- Ephemeral session state ------------------------------------------------

  private getOrCreateSession(stream: StreamTabId): StreamSessionState {
    let state = this._sessionState.get(stream);
    if (!state) {
      state = {
        metadata: {},
        provisionalCreationTimestamp:
          this.streamLogs.getFirstTimestamp(stream) ?? Date.now(),
      };
      this._sessionState.set(stream, state);
    }
    return state;
  }

  /**
   * The single writer for {@link StoredStreamMetadata}: every mutation site
   * below builds a `Partial<StoredStreamMetadata>` patch and routes it
   * through here rather than assigning fields by hand. A field the patch
   * doesn't mention is preserved verbatim from `current` — callers that want
   * to clear a field (e.g. detaching a parent) do so by including that key
   * in the patch with an explicit `undefined`, same as before this was
   * centralized.
   */
  private applyMetadataPatch(
    current: StoredStreamMetadata,
    patch: Partial<StoredStreamMetadata>,
  ): StoredStreamMetadata {
    return { ...current, ...patch };
  }

  /**
   * Build the snapshot-owned slice of a metadata patch: `agentCategory` and
   * `run` are only ever set together, atomically, from one `RunConfig` (see
   * the {@link ProgressStreamRunDetails} doc) and are therefore omitted from
   * the patch entirely when no config has resolved yet, rather than being
   * patched to `undefined` — that is what lets `run`'s three-owner union
   * stay all-or-nothing instead of drifting field-by-field. `executionId`,
   * `parentStreamId`, and `description` fall back to the current value when
   * the snapshot store doesn't have one yet, so a patch built before that
   * data loads can never clear a field the snapshot hasn't caught up to.
   */
  private buildSnapshotMetadataPatch(
    stream: StreamTabId,
    current: StoredStreamMetadata,
  ): Partial<StoredStreamMetadata> {
    const patch: Partial<StoredStreamMetadata> = {};
    const config = this.snapshots.getRunConfig(stream);
    if (config) {
      // The descriptor is the run's identity, taken whole: a stream whose meta
      // predates descriptors has none, and then the config answers for all
      // three fields rather than each one falling back on its own, which is
      // what kept a descriptor's agent from being paired with the config's
      // category. Every descriptor carries its kind, so nothing re-derives it.
      const identity = this.snapshots.getRunDescriptor(stream) ?? {
        agent: config.agent,
        category: config.agentCategory,
        kind: isProcessAgent(config.agent) ? 'process' : 'agent',
      };
      patch.agentCategory = identity.category;
      const workingDirectory = config.workingDirectory ?? undefined;
      if (identity.kind === 'workflowScript') {
        patch.run = {
          kind: 'workflowScript',
          workflowName: identity.agent,
          instruction: config.instruction,
          workingDirectory,
        };
      } else if (identity.kind === 'process') {
        patch.run = {
          kind: 'process',
          agent: identity.agent,
          instruction: config.instruction,
          workingDirectory,
        };
      } else {
        patch.run = {
          kind: 'agent',
          agent: identity.agent,
          inputFile: config.inputFiles?.at(0),
          model: config.model,
          instruction: config.instruction,
          workingDirectory,
        };
      }
    }

    patch.executionId =
      this.snapshots.getExecutionId(stream) ?? current.executionId;
    patch.parentStreamId =
      this.snapshots.getParentStreamId(stream) ?? current.parentStreamId;
    patch.description =
      this.snapshots.getDescription(stream) ?? current.description;

    return patch;
  }

  private applySnapshotMetadata(
    stream: StreamTabId,
    current: StoredStreamMetadata,
  ): StoredStreamMetadata {
    return this.applyMetadataPatch(
      current,
      this.buildSnapshotMetadataPatch(stream, current),
    );
  }

  /**
   * Apply metadata known before durable task state catches up. Snapshot-owned
   * fields are re-applied here so late events cannot override authoritative
   * config, execution, hierarchy, or description data.
   */
  updateStreamMetadata(
    stream: StreamTabId,
    patch: Partial<StoredStreamMetadata>,
  ): void {
    const state = this.getOrCreateSession(stream);
    const merged = this.applyMetadataPatch(state.metadata, patch);
    state.metadata = this.applySnapshotMetadata(stream, merged);
  }

  /** Re-apply newly loaded snapshot authority without changing live-only data. */
  refreshStreamMetadataFromSnapshot(stream: StreamTabId): void {
    const state = this.getOrCreateSession(stream);
    state.metadata = this.applySnapshotMetadata(stream, state.metadata);
  }

  /** Start a run from durable metadata, dropping this session's live-only data. */
  resetStreamMetadataForRun(stream: StreamTabId): void {
    const state = this.getOrCreateSession(stream);
    state.metadata = this.applySnapshotMetadata(stream, {});
  }

  /**
   * Read effective metadata, creating the ephemeral record when needed. The
   * transcript's first entry dates the tab as soon as one exists; until then
   * the record's provisional timestamp stands in.
   */
  getStreamMetadata(stream: StreamTabId): Readonly<ProgressStreamMetadata> {
    const session = this.getOrCreateSession(stream);
    const firstTimestamp = this.streamLogs.getFirstTimestamp(stream);
    if (firstTimestamp !== undefined) {
      session.provisionalCreationTimestamp = firstTimestamp;
    }
    return {
      ...session.metadata,
      creationTimestamp: session.provisionalCreationTimestamp,
    };
  }

  setStreamParent(
    stream: StreamTabId,
    parent: StreamTabId | null | undefined,
  ): void {
    const state = this.getOrCreateSession(stream);
    state.metadata = this.applyMetadataPatch(state.metadata, {
      parentStreamId: parent ?? undefined,
    });
  }

  setStreamDescription(stream: StreamTabId, description: string): void {
    const state = this.getOrCreateSession(stream);
    state.metadata = this.applyMetadataPatch(state.metadata, { description });
  }

  // todos/plan are owned + persisted by StreamSnapshotStore (workPlan.json).

  // -- Ephemeral execution state ----------------------------------------------

  getOrCreateStreamState(
    stream: StreamTabId,
    agentCategory: (typeof AgentCategory)[keyof typeof AgentCategory],
  ): StreamExecutionState {
    const existing = this._streamStates.get(stream);
    if (!existing || existing.kind !== agentCategory) {
      const state: StreamExecutionState = {
        kind: agentCategory,
        conversationProgress: { toolCallCount: 0 },
        subagents: [],
      };
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
   * Carry a child stream's phase into every roster row that tracks it, and
   * return the parents whose rosters changed. `streamStatus` owns a subagent's
   * phase and this is the single write that lands it in a roster, so every send
   * path ships stored data. Rows are keyed by their own `childStreamId` rather
   * than by the parent-link snapshot: a child's roster drop can arrive BEFORE
   * its terminal phase (the cancel path untracks the handle, then transitions
   * the stream), and a detached child loses the parent link entirely while its
   * retained row lives on under the former parent.
   */
  recordChildPhase(
    childStreamId: StreamTabId,
    phase: StreamPhase,
  ): StreamTabId[] {
    const changedParents: StreamTabId[] = [];
    for (const [parent, state] of this._streamStates) {
      const tracksChild = state.subagents.some(
        (child) =>
          child.kind === 'subagent' &&
          child.childStreamId === childStreamId &&
          child.status !== phase,
      );
      if (!tracksChild) continue;
      this._streamStates.set(parent, {
        ...state,
        subagents: state.subagents.map((child) =>
          child.kind === 'subagent' && child.childStreamId === childStreamId
            ? { ...child, status: phase }
            : child,
        ),
      });
      changedParents.push(parent);
    }
    return changedParents;
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
      ...Array.from(this.streamStatus.entries(), ([stream]) => stream),
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
