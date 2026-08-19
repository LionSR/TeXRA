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
  type ContextStateData,
  type ConversationProgress,
  type StreamStage,
  type StreamIdentityFields,
  type StreamPhase,
  type StreamTabId,
  AgentCategory,
} from '@shared/schemas';
import { compareByNewestCreationTime } from '@shared/streams/streamOrdering';
import type { StreamLogStore, StreamSnapshotStore } from '@transcript';

/**
 * Config-derived display fields: undefined until the stream's `RunConfig`
 * resolves in the summary mirror, then always populated together from that
 * one `AgentConfig`. Display data only — what the run IS travels as the
 * parsed `RunIdentity` beside it. `instruction` carries only a process
 * run's command line (the one config field tab rendering consumes); agent
 * runs' full instruction text stays on the sidecar/config authority.
 */
interface SessionStreamConfigDetails {
  instruction?: string;
  model?: string;
  workingDirectory?: string;
}

/**
 * Canonical current metadata used by every session stream consumer. The
 * identity/pointer fields are the shared {@link StreamIdentityFields} shape
 * (declared once beside `StreamTabInfoSchema`), so this record and the wire
 * tab info cannot drift apart field-by-field.
 */
export interface SessionStreamMetadata extends StreamIdentityFields {
  config?: SessionStreamConfigDetails;
}

/**
 * The stored slice of {@link SessionStreamMetadata}. `creationTimestamp` is
 * not in it: the transcript dates a tab, so it is computed on read rather than
 * carried through every patch that has nothing to say about it.
 */
type StoredStreamMetadata = Omit<SessionStreamMetadata, 'creationTimestamp'>;
const EMPTY_STORED_STREAM_METADATA: StoredStreamMetadata = Object.freeze({});

/** Ephemeral session state per stream (not persisted). */
interface StreamSessionState {
  metadata: StoredStreamMetadata;
}

interface CachedStreamMetadata {
  readonly stored: StoredStreamMetadata;
  readonly summary: ReturnType<StreamLogStore['getSummaryMeta']>;
  readonly firstTimestamp: number | undefined;
  readonly removed: boolean;
  readonly value: Readonly<SessionStreamMetadata>;
}

/**
 * Backend-owned ephemeral counters, updated during streaming.
 */
export interface StreamExecutionState {
  category: (typeof AgentCategory)[keyof typeof AgentCategory];
  conversationProgress: ConversationProgress;
  stage?: StreamStage;
  /**
   * Latest context-window occupancy reported by the model handler that served
   * this stream's last response — the only authority on the window actually
   * used, which a static model-registry lookup cannot reproduce for
   * subscription-capped or compacted turns. Absent until a response reports
   * input tokens against a known window; carried across runs on the same
   * stream, like the latest usage gauge it sits beside.
   */
  contextState?: ContextStateData;
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
  private readonly _streamMetadataCache = new Map<
    StreamTabId,
    CachedStreamMetadata
  >();
  /**
   * Per-stream incarnation generation, bumped only by a legitimate claim on
   * the identity (`claimStreamIdentity`, from a workflow attachment with live
   * execution evidence). A removal captures the generation it saw and only
   * commits if the generation is unchanged, so a fresh deterministic run that
   * starts while an old delete is queued invalidates that delete instead of
   * being erased.
   */
  private readonly _streamIncarnations = new Map<StreamTabId, number>();
  /**
   * Identities removed this session, mapped to the incarnation they were
   * removed at. The fact applier refuses any later fact naming a removed
   * stream, so a stale status, roster, edge, or attachment fact cannot
   * re-mint the transcript, execution, or metadata state deletion dropped.
   * This map is the single owner of that rejection.
   *
   * Durable sidecar finality is owned by {@link SessionStores} + the snapshot
   * store's staged-deletion/eviction write guards, not by this tombstone; its
   * "removal is final" semantics are scoped to this in-memory projection.
   *
   * Lifecycle: deliberately uncapped, because every eviction policy invented
   * so far reopens resurrection for an evicted id and would be a false
   * finality claim. An entry retires when a fresh workflow attachment
   * legitimately re-claims the identity (live-execution evidence → {@link
   * SessionFactApplier}), or when the whole storage root is replaced
   * (`resetAfterStorageRootChange`). Otherwise it lives for the session — the
   * proven horizon for in-flight facts.
   */
  private readonly _removedStreams = new Map<StreamTabId, number>();

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
   * `buildStreamInfos` renders. Provisionally removed streams are excluded;
   * membership and rotation otherwise depend only on creation time, so this
   * answers them without building tab infos or touching the worktree resolver.
   */
  selectableStreamNames(): StreamTabId[] {
    return this.streamLogs
      .keys()
      .filter((name) => !this.isStreamRemoved(name))
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
      state = { metadata: {} };
      this._sessionState.set(stream, state);
    }
    return state;
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
    stored: StoredStreamMetadata,
    meta: ReturnType<StreamLogStore['getSummaryMeta']>,
  ): StoredStreamMetadata {
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

  /** Replace one live metadata record and invalidate its derived view. */
  private setStoredStreamMetadata(
    stream: StreamTabId,
    metadata: StoredStreamMetadata,
  ): void {
    this.getOrCreateSession(stream).metadata = metadata;
    this._streamMetadataCache.delete(stream);
  }

  /**
   * Apply metadata known before durable task state catches up. Mentioned
   * fields replace the stored ones — a key with an explicit `undefined`
   * clears it (e.g. detaching a parent); unmentioned fields pass through
   * verbatim. The durable authority is overlaid at read time
   * (`getStreamMetadata`), so late events cannot override authoritative
   * config, execution, hierarchy, or description data.
   */
  updateStreamMetadata(
    stream: StreamTabId,
    patch: Partial<StoredStreamMetadata>,
  ): void {
    const { metadata } = this.getOrCreateSession(stream);
    this.setStoredStreamMetadata(stream, { ...metadata, ...patch });
  }

  /** Start a run fresh, dropping this session's live-only metadata. */
  resetStreamMetadataForRun(stream: StreamTabId): void {
    this.setStoredStreamMetadata(stream, {});
  }

  /**
   * Read effective metadata. For a live stream this lazily creates the
   * ephemeral record. A removed stream is read read-only from the durable
   * summary mirror: the tombstone gate calls this to inspect a re-claimed
   * identity, and minting the ephemeral record here would undo the deletion
   * the barrier exists to protect.
   */
  getStreamMetadata(stream: StreamTabId): Readonly<SessionStreamMetadata> {
    const removed = this.isStreamRemoved(stream);
    const session = removed ? undefined : this.getOrCreateSession(stream);
    const stored = session?.metadata ?? EMPTY_STORED_STREAM_METADATA;
    const summary = this.streamLogs.getSummaryMeta(stream);
    const firstTimestamp = this.streamLogs.getTimestampRange(stream).first;
    const cached = this._streamMetadataCache.get(stream);
    if (
      cached?.stored === stored &&
      cached.summary === summary &&
      cached.firstTimestamp === firstTimestamp &&
      cached.removed === removed
    ) {
      return cached.value;
    }
    const value: Readonly<SessionStreamMetadata> = {
      ...this.applySummaryMetadata(stored, summary),
      // A stream with no transcript entry yet has no durable timestamp to
      // recover; keep the previously reported provisional value so ordering
      // stays stable, minting one only on the very first read.
      creationTimestamp:
        firstTimestamp ?? cached?.value.creationTimestamp ?? Date.now(),
    };
    this._streamMetadataCache.set(stream, {
      stored,
      summary,
      firstTimestamp,
      removed,
      value,
    });
    return value;
  }

  setStreamParent(
    stream: StreamTabId,
    parent: StreamTabId | null | undefined,
  ): void {
    this.updateStreamMetadata(stream, { parentStreamId: parent ?? undefined });
  }

  setStreamDescription(stream: StreamTabId, description: string): void {
    this.updateStreamMetadata(stream, { description });
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

  /**
   * Read host-facing execution state. Parent rosters remain canonical while a
   * child deletion is provisional; this shared projection hides tombstoned
   * children from every host until that deletion settles.
   */
  getStreamState(stream: StreamTabId): StreamExecutionState | undefined {
    const state = this._streamStates.get(stream);
    if (!state) return undefined;
    const subagents = state.subagents.filter(
      (child) => !this.isStreamRemoved(child.childStreamId),
    );
    return subagents.length === state.subagents.length
      ? state
      : { ...state, subagents };
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

  /**
   * Begin a removal barrier for `stream`, capturing its current incarnation.
   * Explicit ownership: `created` is true only when this call installed a new
   * barrier. When a barrier already exists (a `removeStream` fact racing a
   * direct delete, or a command racing a fact-path removal) the existing
   * incarnation is returned with `created === false`, so a caller that finds
   * one can avoid starting a second deletion or touching/retiring a barrier
   * it does not own.
   *
   * Canonical parent rosters remain untouched while deletion is provisional.
   * The shared read projection hides matching rows from every host.
   */
  beginStreamRemoval(stream: StreamTabId): {
    incarnation: number;
    created: boolean;
    changedRosterParents: StreamTabId[];
  } {
    const existing = this._removedStreams.get(stream);
    if (existing !== undefined) {
      return {
        incarnation: existing,
        created: false,
        changedRosterParents: [],
      };
    }
    const incarnation = this.incarnationOf(stream);
    this._removedStreams.set(stream, incarnation);
    this._streamMetadataCache.delete(stream);

    return {
      incarnation,
      created: true,
      changedRosterParents: this.rosterParentsContaining(stream),
    };
  }

  /**
   * A legitimate workflow attachment claims a deterministic stream identity:
   * bump its incarnation and drop any removal barrier, so the new run's facts
   * flow and any queued deletion captured against the previous incarnation is
   * stale. Called only when the applier has live-execution evidence for the
   * claim — never from a bare `run.start`, which a delayed stale event could
   * replay after the deletion committed.
   */
  claimStreamIdentity(stream: StreamTabId): {
    incarnation: number;
    changedRosterParents: StreamTabId[];
  } {
    const incarnation = this.incarnationOf(stream) + 1;
    this._streamIncarnations.set(stream, incarnation);
    // Rows from the prior incarnation must not become visible when dropping its
    // tombstone. A fresh authoritative roster can add the new identity back.
    const changedRosterParents = this.scrubStreamFromRosters(stream);
    this._removedStreams.delete(stream);
    // A re-claimed identity starts a fresh run: drop any ephemeral session and
    // execution state the previous incarnation left behind (a provisional
    // removal may not have committed yet). The status machine is left alone —
    // the fresh run has already tracked its own phase there.
    this._sessionState.delete(stream);
    this._streamStates.delete(stream);
    this._streamMetadataCache.delete(stream);
    return { incarnation, changedRosterParents };
  }

  /** Whether `stream` was removed this session and must not be resurrected. */
  isStreamRemoved(stream: StreamTabId): boolean {
    return this._removedStreams.has(stream);
  }

  /**
   * Current live-execution evidence for a re-claim: the execution registry
   * holds a handle for this exact stream. A fresh workflow relaunch tracks its
   * handle before its attachment fact lands, while a replayed `run.start`
   * does not, so this is the gate that lets a legitimate re-claim through and
   * keeps a stale fact from reopening a committed tombstone.
   */
  hasLiveStreamExecution(stream: StreamTabId): boolean {
    return this.session.executions.getAgentHandleByStream(stream) !== undefined;
  }

  /**
   * Drop the tombstone only if it still belongs to `expectedIncarnation`.
   * Canonical rosters already contain the newest authoritative rows, so retiring
   * the projection barrier reveals them in their original order. A fresh claim
   * or newer deletion invalidates this settlement through the incarnation check.
   */
  retireStreamTombstone(
    stream: StreamTabId,
    expectedIncarnation: number,
  ): { retired: boolean; changedRosterParents: StreamTabId[] } {
    if (this._removedStreams.get(stream) !== expectedIncarnation) {
      return { retired: false, changedRosterParents: [] };
    }

    const changedRosterParents = this.rosterParentsContaining(stream);
    this._removedStreams.delete(stream);
    this._streamMetadataCache.delete(stream);
    return { retired: true, changedRosterParents };
  }

  /**
   * Finalize this incarnation's tombstone and scrub its canonical roster rows.
   * Returns the parents whose host-facing projection must be refreshed.
   */
  commitStreamTombstone(
    stream: StreamTabId,
    expectedIncarnation: number,
  ): { committed: boolean; changedRosterParents: StreamTabId[] } {
    if (this._removedStreams.get(stream) !== expectedIncarnation) {
      return { committed: false, changedRosterParents: [] };
    }
    return {
      committed: true,
      changedRosterParents: this.scrubStreamFromRosters(stream),
    };
  }

  private rosterParentsContaining(stream: StreamTabId): StreamTabId[] {
    const parents: StreamTabId[] = [];
    for (const [parent, state] of this._streamStates) {
      if (state.subagents.some((child) => child.childStreamId === stream)) {
        parents.push(parent);
      }
    }
    return parents;
  }

  private scrubStreamFromRosters(stream: StreamTabId): StreamTabId[] {
    const changedParents: StreamTabId[] = [];
    for (const [parent, state] of this._streamStates) {
      const subagents = state.subagents.filter(
        (child) => child.childStreamId !== stream,
      );
      if (subagents.length === state.subagents.length) continue;
      this._streamStates.set(parent, { ...state, subagents });
      changedParents.push(parent);
    }
    return changedParents;
  }

  private incarnationOf(stream: StreamTabId): number {
    return this._streamIncarnations.get(stream) ?? 0;
  }

  private isCurrentIncarnation(
    stream: StreamTabId,
    incarnation: number,
  ): boolean {
    return this.incarnationOf(stream) === incarnation;
  }

  async clearStream(
    stream: StreamTabId,
    options?: { readonly expectedIncarnation?: number },
  ): Promise<DeleteStreamResult> {
    const expectedIncarnation =
      options?.expectedIncarnation ?? this.incarnationOf(stream);
    if (!this.isCurrentIncarnation(stream, expectedIncarnation)) {
      return 'superseded';
    }

    // The removal barrier is installed by the caller (the fact applier for a
    // `removeStream` fact, or `ProgressBackend` for a host command) before
    // this storage await, and that caller owns its retirement and buffered-fact
    // replay. This method only commits the durable delete and the tombstone.
    const deletion = await this.stores.deleteStream(stream, {
      // Per-incarnation fence: a re-claimed identity (newer incarnation)
      // cancels this deletion mid-flight.
      shouldDelete: () =>
        this.isCurrentIncarnation(stream, expectedIncarnation),
      expectedIncarnation,
    });
    if (deletion !== 'deleted') return deletion;
    if (!this.isCurrentIncarnation(stream, expectedIncarnation)) {
      return 'superseded';
    }

    this.streamStatus.clearStream(stream);
    this._sessionState.delete(stream);
    this._streamStates.delete(stream);
    this._streamMetadataCache.delete(stream);
    this._removedStreams.set(stream, expectedIncarnation);

    return 'deleted';
  }

  async clearAll(): Promise<DeleteAllStreamsResult> {
    this.logger.warn(
      '[Persistence] clearAll() called - this will delete all persisted data!',
      { data: { stack: new Error().stack } },
    );

    // Capture the ephemeral-only identity set before the bulk delete awaits:
    // this operation may only clear/tombstone identities that existed when it
    // began. A stream created during the bulk snapshot (a fresh run) is not in
    // this set and must survive untouched. `deleteAll` still reports the exact
    // durable identities it committed as `deleted`, and that result is the
    // sole source for tombstoning durable streams — deriving them from a
    // pre-delete enumeration would reintroduce the TOCTOU this barrier exists
    // to close.
    const preExistingEphemeral = new Set<StreamTabId>([
      ...this._streamStates.keys(),
      ...this._sessionState.keys(),
      ...Array.from(this.streamStatus.entries(), ([stream]) => stream),
    ]);
    const identitiesAtStart = new Set<StreamTabId>([
      ...preExistingEphemeral,
      ...this._streamIncarnations.keys(),
      ...this.streamLogs.keys(),
    ]);
    const incarnationsAtStart = new Map(this._streamIncarnations);
    const deletion = await this.stores.deleteAll({
      shouldDelete: (stream) =>
        // Sessionless staged residue is intentionally absent from the live
        // transcript map and remains eligible for cleanup. A fresh run that
        // appears after the snapshot has a live transcript and is fenced out.
        (identitiesAtStart.has(stream) || !this.streamLogs.has(stream)) &&
        this.incarnationOf(stream) === (incarnationsAtStart.get(stream) ?? 0),
    });
    const retained = new Set([...deletion.active, ...deletion.failed]);
    const clearIdentity = (stream: StreamTabId): void => {
      this.streamStatus.clearStream(stream);
      this._sessionState.delete(stream);
      this._streamStates.delete(stream);
      this._streamMetadataCache.delete(stream);
      this.scrubStreamFromRosters(stream);
      this._removedStreams.set(stream, this.incarnationOf(stream));
    };
    for (const stream of deletion.deleted) clearIdentity(stream);
    // Ephemeral-only identities (for example a RUNNING transition that created
    // execution/status state without ever minting a durable transcript) are
    // invisible to `SessionStores.deleteAll`, so the exact durable `deleted`
    // set cannot contain them. Clear and tombstone the pre-existing ones too,
    // but never clear durable identities the bulk delete reported retained and
    // never clear a stream that appeared after the snapshot.
    for (const stream of preExistingEphemeral) {
      if (retained.has(stream) || this._removedStreams.has(stream)) continue;
      clearIdentity(stream);
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

  /**
   * Drop workspace-scoped caches before loading a replacement storage root.
   * The incarnation generations are an identity projection over the old
   * root's stream ids, so they reset with the tombstones: a re-claimed
   * identity in the new root must start from incarnation 0 again.
   */
  resetAfterStorageRootChange(): void {
    this._sessionState.clear();
    this._streamStates.clear();
    this._streamMetadataCache.clear();
    this._removedStreams.clear();
    this._streamIncarnations.clear();
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
