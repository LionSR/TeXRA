import {
  SessionStores,
  type DeleteAllStreamsResult,
  type DeleteStreamResult,
} from '@agent/storage';
import type { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import type { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import {
  defaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { createSessionStores } from '@controllers/session/sessionStores';
import { createLog } from '@logger/logUtils';
import {
  type ActiveChildInfo,
  type ConversationProgress,
  type ExecutionId,
  type StreamStage,
  type RunIdentity,
  type StreamPhase,
  type StreamTabId,
  type UserFollowUpSupport,
  AgentCategory,
} from '@shared/schemas';
import { compareByNewestCreationTime } from '@shared/streams/streamOrdering';
import type { StreamLogStore, StreamSnapshotStore } from '@transcript';

/**
 * Config-derived display fields: undefined until the stream's `RunConfig`
 * resolves in the summary mirror, then always populated together from that
 * one `AgentConfig`. Display data only — what the run IS travels as the
 * parsed {@link RunIdentity} beside it. `instruction` carries only a process
 * run's command line (the one config field tab rendering consumes); agent
 * runs' full instruction text stays on the sidecar/config authority.
 */
interface SessionStreamConfigDetails {
  instruction?: string;
  model?: string;
  workingDirectory?: string;
}

/** Canonical current metadata used by every session stream consumer. */
export interface SessionStreamMetadata {
  /** The run's identity, verbatim from `run.start` or the durable store. */
  identity?: RunIdentity;
  userFollowUpSupport?: UserFollowUpSupport;
  agentCategory?: AgentCategory;
  isRemote?: boolean;
  creationTimestamp: number;
  executionId?: ExecutionId;
  parentStreamId?: StreamTabId;
  description?: string;
  config?: SessionStreamConfigDetails;
}

/**
 * The stored slice of {@link SessionStreamMetadata}. `creationTimestamp` is
 * not in it: the transcript dates a tab, so it is computed on read rather than
 * carried through every patch that has nothing to say about it.
 */
type StoredStreamMetadata = Omit<SessionStreamMetadata, 'creationTimestamp'>;

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

/**
 * Backend-owned ephemeral counters, updated during streaming.
 */
export interface StreamExecutionState {
  category: (typeof AgentCategory)[keyof typeof AgentCategory];
  conversationProgress: ConversationProgress;
  stage?: StreamStage;
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
 * Host-neutral session state.
 *
 * Coordinates two persistence stores — `streamLogs` (transcript) and
 * `snapshots` (all per-stream sidecar: output files, usage, todos, plan, and
 * meta) — plus ephemeral in-memory execution state. Workflow
 * instructions live in the log stream (new runs write them directly; legacy
 * runs are backfilled there during load), not in separate progress-view state.
 */
export class SessionState {
  // -- Persistence managers ---------------------------------------------------
  readonly streamLogs: StreamLogStore;
  /** Single owner of all per-stream sidecar state (output files, usage, todos,
   * plan, runConfig/executionId/parent/description + meta queries). */
  readonly snapshots: StreamSnapshotStore;
  /** Atomic lifecycle owner across streamLogs, streamData, and executions. */
  readonly stores: SessionStores;

  // -- Ephemeral state (session-only, not persisted) --------------------------
  private readonly _streamStates = new Map<StreamTabId, StreamExecutionState>();
  private readonly _sessionState = new Map<StreamTabId, StreamSessionState>();

  readonly streamStatus: StreamStatusMachine;
  readonly followUps: ToolUseFollowUpQueue;

  private readonly logger: ReturnType<typeof createLog>;
  private readonly session: SessionHandle;

  constructor(
    session: SessionHandle = defaultSession(),
    stores?: SessionStores,
  ) {
    this.logger = createLog('SessionState');
    this.session = session;
    this.streamStatus = session.status;
    this.streamLogs = session.transcripts;
    this.followUps = session.followUps;
    this.snapshots = session.snapshots;
    this.stores = stores ?? createSessionStores(session);
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

  // -- Ephemeral session state ------------------------------------------------

  private getOrCreateSession(stream: StreamTabId): StreamSessionState {
    let state = this._sessionState.get(stream);
    if (!state) {
      state = {
        metadata: {},
        provisionalCreationTimestamp:
          this.streamLogs.getTimestampRange(stream).first ?? Date.now(),
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
   * in the patch with an explicit `undefined`.
   */
  private applyMetadataPatch(
    current: StoredStreamMetadata,
    patch: Partial<StoredStreamMetadata>,
  ): StoredStreamMetadata {
    return { ...current, ...patch };
  }

  /**
   * Overlay the durable metadata authority — the snapshot-fed summary
   * mirror, always resident for every known stream (#9947) — on top of this
   * session's live-only patches. Applied at read time, so there is no stored
   * copy of authority data to go stale and no refresh plumbing: `identity`
   * overlays only once the mirror has one, follow-up support is always
   * replaced because absence must fail closed, `agentCategory`/`config`
   * overlay together from one resolved `AgentConfig`, and `executionId`/
   * `parentStreamId`/`description` fall back to the stored value so a
   * mirror that hasn't caught up can never clear a live field.
   */
  private applySummaryMetadata(
    stream: StreamTabId,
    stored: StoredStreamMetadata,
  ): StoredStreamMetadata {
    const meta = this.streamLogs.getSummaryMeta(stream);
    const merged: StoredStreamMetadata = { ...stored };
    if (meta?.identity) merged.identity = meta.identity;
    merged.userFollowUpSupport = meta?.userFollowUpSupport;
    if (meta?.agentCategory) {
      merged.agentCategory = meta.agentCategory;
      merged.config = {
        instruction: meta.command,
        model: meta.model,
        workingDirectory: meta.workingDirectory,
      };
    }
    merged.executionId = meta?.executionId ?? stored.executionId;
    merged.parentStreamId = meta?.parentStreamId ?? stored.parentStreamId;
    merged.description = meta?.description ?? stored.description;
    return merged;
  }

  /**
   * Apply metadata known before durable task state catches up. The durable
   * authority is overlaid at read time (`getStreamMetadata`), so late events
   * cannot override authoritative config, execution, hierarchy, or
   * description data.
   */
  updateStreamMetadata(
    stream: StreamTabId,
    patch: Partial<StoredStreamMetadata>,
  ): void {
    const state = this.getOrCreateSession(stream);
    state.metadata = this.applyMetadataPatch(state.metadata, patch);
  }

  /** Start a run fresh, dropping this session's live-only metadata. */
  resetStreamMetadataForRun(stream: StreamTabId): void {
    this.getOrCreateSession(stream).metadata = {};
  }

  /**
   * Read effective metadata, creating the ephemeral record when needed. The
   * transcript's first entry dates the tab as soon as one exists; until then
   * the record's provisional timestamp stands in.
   */
  getStreamMetadata(stream: StreamTabId): Readonly<SessionStreamMetadata> {
    const session = this.getOrCreateSession(stream);
    const firstTimestamp = this.streamLogs.getTimestampRange(stream).first;
    if (firstTimestamp !== undefined) {
      session.provisionalCreationTimestamp = firstTimestamp;
    }
    return {
      ...this.applySummaryMetadata(stream, session.metadata),
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
    if (!existing) {
      const state: StreamExecutionState = {
        category: agentCategory,
        conversationProgress: { toolCallCount: 0 },
        subagents: [],
      };
      this._streamStates.set(stream, state);
      return state;
    }
    // Roster facts may provision a ToolUse placeholder before RUNNING supplies
    // the real category. Refresh category in place — do not wipe `subagents`.
    if (existing.category !== agentCategory) {
      const state: StreamExecutionState = {
        ...existing,
        category: agentCategory,
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
      current.stage !== undefined;

    if (needsReset) {
      this._streamStates.set(stream, {
        ...current,
        subagents: current.subagents.filter(
          (child) => child.finishedAt === undefined,
        ),
        conversationProgress: { toolCallCount: 0 },
        stage: undefined,
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
          child.childStreamId === childStreamId && child.status !== phase,
      );
      if (!tracksChild) continue;
      this._streamStates.set(parent, {
        ...state,
        subagents: state.subagents.map((child) =>
          child.childStreamId === childStreamId
            ? { ...child, status: phase }
            : child,
        ),
      });
      changedParents.push(parent);
    }
    return changedParents;
  }

  // -- Lifecycle --------------------------------------------------------------

  async clearStream(stream: StreamTabId): Promise<DeleteStreamResult> {
    const deletion = await this.stores.deleteStream(stream);
    if (deletion !== 'deleted') return deletion;

    this.streamStatus.clearStream(stream);
    this._sessionState.delete(stream);
    this._streamStates.delete(stream);

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
    return deletion;
  }

  async load(stateOwnership: 'backend' | 'session' = 'backend'): Promise<void> {
    this.logger.info('[Persistence] Starting state load from storage');

    // ProgressBackend waits for SessionHandle readiness before entering this
    // method. The session owns transcript opening and sidecar hydration; a
    // presentation must never reload those live stores.
    await this.stores.waitForPendingStreamDeletions();

    this.logger.info(
      `[Persistence] Discovered ${this.streamLogs.keys().length} stream(s)`,
    );

    // The extension's presentation *is* its process owner, so it runs the
    // shared startup sweep here; the desktop and CLI run it from theirs, where
    // this state is not the owner of these stores. Sweeping before the loop
    // below means no metadata is built for a stream this load then deletes.
    if (stateOwnership === 'backend') {
      await this.stores.sweepLeftoverStreams();
    }
    // No all-streams metadata loop: stream metadata is assembled lazily in
    // `getStreamMetadata` from the always-resident summary mirror, so a load
    // has nothing to seed per stream (#9947).

    this.logger.info('[Persistence] Managers loaded');

    this.logger.info('[Persistence] State load complete');
  }

  /** Drop workspace-scoped caches before loading a replacement storage root. */
  resetAfterStorageRootChange(): void {
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
}
