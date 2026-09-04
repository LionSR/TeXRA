import {
  finalizeRun,
  getExecutionStore,
  readExecutionMetaCore,
  SessionStores,
  type DeleteAllStreamsResult,
  type DeleteStreamResult,
} from '@agent/storage';
import {
  inspectExecutionLease,
  runWithInactiveExecutionLease,
  type ExecutionLeasePresence,
} from '@agent/storage/executionLease';
import { flowKey } from '@agent/node/persistedFlow';
import type { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import type {
  StreamPhaseState,
  StreamStatusMachine,
} from '@agent/runtime/StreamStatusService';
import {
  defaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { createSessionStores } from '@controllers/session/createSessionStores';
import { createLog } from '@logger/logUtils';
import {
  type ActiveChildInfo,
  type ContextStateData,
  type ConversationProgress,
  type SessionEventBody,
  withEnvelope,
  type StreamStage,
  type ExecutionId,
  type RunOutcome,
  type StreamIdentityFields,
  type StreamPhase,
  type StreamTabId,
  AgentCategory,
  RUN_OUTCOME,
  STREAM_PHASE,
  STREAM_SUBSTATE,
} from '@shared/schemas';
import { fold } from '@shared/session/sessionFold';
import {
  createSessionView,
  type SessionView,
} from '@shared/session/sessionView';
import { compareByNewestCreationTime } from '@shared/streams/streamOrdering';
import { isTerminalOutcomePhase } from '@shared/streams/streamStatus';
import {
  streamHeldMessage,
  streamUnreadableMessage,
} from '@shared/streams/streamStatusDisplay';
import type { StreamLogStore, StreamSnapshotStore } from '@transcript';
import { toErrorMessage } from '@utils/errors/errorMessage';

/** Seq counter key for session-scoped view events (no stream). */
const SESSION_SEQ_KEY = 'session';

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
 * Ephemeral session-only state for one stream: live metadata patches plus
 * backend-owned execution counters. The two are always created and cleared
 * together (`claimStreamIdentity`, `clearEphemeralStreamState`), so they
 * share one map entry rather than two separately-keyed maps; `execution` is
 * still optional because a stream can accrue metadata (e.g. a description
 * set before RUNNING) before `getOrCreateStreamState` ever mints it.
 *
 * `_streamMetadataCache` (a derived read cache invalidated by comparing
 * `metadata`/summary/timestamp identity), `_streamIncarnations` (identity
 * generation, which must outlive an ephemeral clear), and `_removedStreams`
 * (tombstones, which must outlive the very ephemeral state they retire) each
 * have a genuinely different lifetime and stay as separate maps.
 */
interface EphemeralStreamState {
  metadata: StoredStreamMetadata;
  execution?: StreamExecutionState;
}

/**
 * What {@link SessionState.hydrateRunFacts} learned about the run a stream
 * last carried: enough for {@link SessionState.resolveStreamPhase} to say
 * what happened to a stream with no live flow context in this process, and
 * nothing more.
 *
 * In memory only — nothing here is written to a sidecar or a summary file,
 * and a fresh process learns it again the next time the row is opened.
 *
 * Display-only. Each field was true at the instant the row was opened, so a
 * caller about to WRITE (open, resume, delete) re-reads the authority under
 * the lease instead of trusting them: a process-local mirror cannot observe
 * another host's finalize.
 */
interface RunPhaseFacts {
  /** `ExecutionMeta.outcome`: absent for a run that never finalized. */
  readonly outcome?: RunOutcome;
  /** Whether a resumable flow checkpoint file exists (existence, not validity). */
  readonly checkpointPresent?: boolean;
  /** Who held the execution lease when the row was opened. */
  readonly lease?: ExecutionLeasePresence;
  /** Why this stream's execution authority could not be read, if it could not. */
  readonly authorityFailure?: string;
}

/**
 * What {@link SessionState.resolveStreamPhase} decided about one stream, and
 * on what evidence. See that method for the meaning of each `origin`.
 */
interface ResolvedStreamPhase {
  readonly state?: StreamPhaseState;
  readonly origin: 'live' | 'derived' | 'pending' | 'none';
  readonly detail?: string;
}

/**
 * Host-neutral session state.
 *
 * Coordinates two persistence stores — `streamLogs` (transcript) and
 * `snapshots` (all per-stream sidecar: output files, usage, todos, plan, and
 * meta) — plus ephemeral in-memory execution state. Workflow instructions
 * live in the log stream, not in separate progress-view state.
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
  private readonly _ephemeralState = new Map<
    StreamTabId,
    EphemeralStreamState
  >();
  private readonly _streamMetadataCache = new Map<
    StreamTabId,
    CachedStreamMetadata
  >();
  /**
   * What each opened row's last run turned out to be — see
   * {@link RunPhaseFacts}. Written by {@link hydrateRunFacts}, which only the
   * row-open paths call, so this map holds an entry per row the user has
   * actually opened rather than one per stream in the workspace. Dropped when
   * the stream's execution changes hands, and with the stream itself.
   */
  private readonly _runFacts = new Map<StreamTabId, RunPhaseFacts>();
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
   * SessionFactApplier}). Otherwise it lives for the session — the proven
   * horizon for in-flight facts.
   */
  private readonly _removedStreams = new Map<StreamTabId, number>();

  readonly streamStatus: StreamStatusMachine;
  readonly followUps: ToolUseFollowUpQueue;

  /**
   * The one session state every renderer reads (PRD one-fold-three-renderers,
   * 5.1): the fold over the facts this session has admitted. Replaced on
   * every applied event, never mutated. In lane 1 the fact applier feeds it
   * in process and this class stamps the envelope; lane 2's `SessionEvents`
   * publisher owns seq, owner token, and timestamp, and the counter below
   * leaves with it.
   */
  view: SessionView;
  private readonly viewSeq = new Map<string, number>();
  private readonly viewDropped = new Set<StreamTabId>();

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
    // This process is alive: its own owner token is the one live owner the
    // in-process fold knows, so a request this session is waiting on folds
    // as waiting. Lane 2's lease reader replaces the snapshot with every
    // owner it can prove alive.
    this.view = fold(createSessionView(), {
      type: 'owner.liveness',
      owners: [session.ownerId],
    });
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

  /**
   * Fold one admitted fact into {@link view}. The existence rule (5.2) is
   * enforced here as well as in the fold: a fact for a stream the view has
   * no `run.start` for is dropped and logged once per stream, so a publisher
   * that skips the existence fact is loud, not a ghost tab. In lane 1 the
   * hydrated streams of an earlier session have no `run.start` until lane 2
   * replays them, so their facts are expected to land here.
   *
   * The envelope's owner is this session's token for every fact it appends
   * in process; `run.start` carries the launcher's own, which is the same
   * token on a live path. `run.start` also carries the roster's creation
   * timestamp so the view orders streams the way the roster does; every
   * other fact carries none of its own and is stamped at fold time, which
   * lane 2's publisher replaces with the append time.
   *
   * The reservation precedes existence by design: `tryAcquire` publishes
   * the STARTING status before the launcher commits `run.start`, so that
   * one status is expected here and dropped without a warning.
   */
  applySessionEvent(
    streamId: StreamTabId | null,
    body: SessionEventBody,
    ownerId: string | null = this.session.ownerId,
  ): void {
    if (
      streamId !== null &&
      body.type !== 'run.start' &&
      !this.view.streams.has(streamId)
    ) {
      const reservation =
        body.type === 'status' &&
        (body.substate === STREAM_SUBSTATE.STARTING ||
          body.substate === STREAM_SUBSTATE.RESUMING);
      if (!reservation && !this.viewDropped.has(streamId)) {
        this.viewDropped.add(streamId);
        this.logger.warn('Dropping view facts for a stream with no run.start', {
          data: { streamId, type: body.type },
        });
      }
      return;
    }
    const seqKey = streamId ?? SESSION_SEQ_KEY;
    const seq = (this.viewSeq.get(seqKey) ?? 0) + 1;
    this.viewSeq.set(seqKey, seq);
    const timestamp =
      body.type === 'run.start' && streamId !== null
        ? this.getStreamMetadata(streamId).creationTimestamp
        : Date.now();
    this.view = fold(
      this.view,
      withEnvelope(body, { streamId, seq, ownerId, timestamp }),
    );
  }

  // -- Ephemeral session state ------------------------------------------------

  private getOrCreateEphemeral(stream: StreamTabId): EphemeralStreamState {
    let state = this._ephemeralState.get(stream);
    if (!state) {
      state = { metadata: {} };
      this._ephemeralState.set(stream, state);
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
    this.getOrCreateEphemeral(stream).metadata = metadata;
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
    const { metadata } = this.getOrCreateEphemeral(stream);
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
    const ephemeral = removed ? undefined : this.getOrCreateEphemeral(stream);
    const stored = ephemeral?.metadata ?? EMPTY_STORED_STREAM_METADATA;
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

  // -- Stream phase ------------------------------------------------------------

  /**
   * Read what this stream's last run turned out to be, for the row the user
   * just opened. Four small reads against that row's execution: the
   * read-only lease inspection (a dead claim reports as absent and is
   * unlinked by the next claim, never by this call), one `exists` stat for
   * the flow checkpoint (never a parse of the often ~600 KB record), a
   * core-schema parse of the execution row for the outcome, and the run
   * record — the same pair of authority reads the sidecar preload makes, so
   * a row the preload found unreadable can never look healthy here.
   *
   * Called from the row-open paths only, one stream at a time — never over a
   * roster. That is the whole point: an unopened row renders from the
   * always-resident summary tier, and {@link resolveStreamPhase}'s unhydrated
   * arm already answers for it, so no startup pass has to walk the history to
   * make the first screen correct.
   *
   * Never throws. A read that fails lands in `authorityFailure`, which the
   * rule renders read-only with the cause rather than as a run that never
   * happened.
   *
   * The one write it can make is {@link settleInterruptedRun}, for the row
   * the tuple proves nobody is producing and nobody ever finished. It happens
   * here rather than on a timer because a settle is a write over shared
   * execution and transcript state: bounding it to the row a user just opened
   * is what keeps it one stream per user action instead of a background pass
   * racing every other host over the whole history.
   *
   * ORDERING INVARIANT — lease, then checkpoint, then outcome, sequentially.
   * A foreign finalize writes the outcome, deletes the checkpoint, then
   * releases the lease. Reading in that same order means a free lease is
   * always followed by the outcome read that a finalize which released it has
   * already written. Any other order (a parallel batch included) can splice
   * "lease free, no checkpoint" observed after the finalize onto "no outcome"
   * observed before it, and leave the row reading Ready.
   */
  async hydrateRunFacts(stream: StreamTabId): Promise<void> {
    // The always-resident summary mirror is the FK: a caller that preloaded
    // the sidecar first (every row-open path does) has already backfilled it
    // for a legacy row whose summary predates the mirror.
    const executionId = this.getStreamMetadata(stream).executionId;
    // The incarnation is the one fact every legitimate re-claim bumps,
    // including a deterministic re-run that reuses the same execution id and
    // a `claimStreamIdentity` that drops a tombstone without touching the
    // mirror; the execution-id comparison alone would miss both.
    const incarnation = this.incarnationOf(stream);
    // Re-checked after every read below: a deletion, a re-claim, or a fresh
    // execution during one makes this tuple somebody else's.
    const stillThisRun = (): boolean =>
      !this.isStreamRemoved(stream) &&
      this.incarnationOf(stream) === incarnation &&
      this.getStreamMetadata(stream).executionId === executionId;

    let facts = await this.readRunFacts(executionId);
    if (!stillThisRun()) return;
    // Nobody is producing this stream, nobody ever recorded what happened to
    // it, and its transcript is still open: the run was interrupted, and this
    // row's open is the one user action in a position to say so durably. A
    // failed authority read leaves no lease behind, so requiring `free` also
    // excludes an authority this process could not read.
    if (
      executionId !== undefined &&
      facts.lease?.status === 'free' &&
      facts.outcome === undefined &&
      this.streamLogs.hasUnfinishedOutput(stream) &&
      (await this.settleInterruptedRun(stream, executionId))
    ) {
      // The row must render what the settle wrote, not the tuple that asked
      // for it: this re-read is where the CANCELLED outcome enters the facts.
      facts = await this.readRunFacts(executionId);
      if (!stillThisRun()) return;
    }
    // Published even when it is empty: the entry's existence is what says
    // this row has been read, and an empty tuple is the honest answer for a
    // stream that never had an execution.
    this._runFacts.set(stream, Object.freeze(facts));
  }

  /**
   * Record the interruption of the one run this row's open found abandoned,
   * so a host that died mid-flight stops leaving a transcript that renders as
   * in-progress forever (#7276) and a run with no durable outcome at all.
   *
   * `runWithInactiveExecutionLease` is both the lock and the liveness proof:
   * it grants its claim only when no live process owns the execution, so a
   * refusal is a live owner and means no write whatsoever. Inside the claim
   * the outcome is read again — the one fact that can have changed since the
   * unsynchronized tuple read — and `keepExistingOutcome` keeps the decision
   * and the write in a single locked cycle even if a finalize lands between
   * the two.
   *
   * The checkpoint is preserved whatever its state: this records an
   * interruption, it never cleans up after one, and a cancelled run's
   * checkpoint is exactly what the user resumes from.
   *
   * One stream per call, from the row-open path only. Nothing here walks a
   * roster: a run nobody opens is settled the day somebody opens it.
   *
   * @returns Whether the CANCELLED outcome was written. `false` leaves the
   *   read-time derivation in place, which already renders the row as
   *   interrupted — the settle makes it durable, it does not make it visible.
   */
  private async settleInterruptedRun(
    stream: StreamTabId,
    executionId: ExecutionId,
  ): Promise<boolean> {
    try {
      const maintenance = await runWithInactiveExecutionLease(
        executionId,
        async () => {
          const meta = await readExecutionMetaCore(
            getExecutionStore(executionId),
          );
          if (meta?.outcome != null) return false;
          const finalized = await finalizeRun({
            executionId,
            outcome: RUN_OUTCOME.CANCELLED,
            flowRecord: 'preserve',
            keepExistingOutcome: true,
            report: (error) =>
              this.logger.warn(error.message, {
                data: { stream, executionId, error },
              }),
          });
          if (!finalized.ok) return false;
          await this.streamLogs.endRunningGroupsForStreams(
            [stream],
            Date.now(),
            RUN_OUTCOME.CANCELLED,
          );
          await this.streamLogs.flush();
          return true;
        },
      );
      if (maintenance.status === 'active') {
        this.logger.debug(
          `Left stream ${stream} unsettled: execution ${executionId} is held by a live process.`,
        );
        return false;
      }
      if (maintenance.value) {
        this.logger.info(
          `Settled interrupted run ${executionId} for stream ${stream} as ${RUN_OUTCOME.CANCELLED}.`,
          { data: { stream, executionId } },
        );
      }
      return maintenance.value;
    } catch (error) {
      this.logger.warn(
        `Could not settle interrupted run ${executionId} for stream ${stream}: ${toErrorMessage(error)}`,
        { data: { stream, executionId, error } },
      );
      return false;
    }
  }

  private async readRunFacts(
    executionId: ExecutionId | undefined,
  ): Promise<RunPhaseFacts> {
    if (!executionId) return {};
    try {
      const store = getExecutionStore(executionId);
      const lease = await inspectExecutionLease(executionId);
      const checkpointPresent = await store.exists(flowKey(executionId));
      // Core-only, and strict on the core: a malformed row is an unreadable
      // authority, but a malformed OPTIONAL `workflow` projection must not
      // cost a valid outcome beside it.
      const meta = await readExecutionMetaCore(store);
      // The same config read the sidecar preload makes, and the reason it is
      // here: that preload catches an unreadable `config.json` into its own
      // authority failure, so without this read the row would come back with a
      // healthy tuple and render as completed/cancelled off a run whose
      // authority is half unreadable. Last, so the lease → checkpoint →
      // outcome ordering above is untouched.
      await store.readConfig();
      return {
        checkpointPresent,
        lease,
        ...(meta?.outcome !== undefined && { outcome: meta.outcome }),
      };
    } catch (error) {
      this.logger.warn(
        `Could not read run phase facts for execution ${executionId}.`,
        { data: { executionId, error } },
      );
      return { authorityFailure: toErrorMessage(error) };
    }
  }

  /**
   * Drop a stream's run facts. Called when a fresh run takes the stream over
   * — the previous run's outcome, checkpoint, and lease are not this run's —
   * and when the stream itself is cleared.
   */
  clearRunFacts(stream: StreamTabId): void {
    this._runFacts.delete(stream);
  }

  /**
   * The one read-time rule for a stream's phase, and the only place that
   * decides what a stream with no live flow context in this process is.
   *
   * `origin` says where the answer came from, and that is the second half of
   * the contract:
   * - `live` — this process owns a producer for the stream (a phase, a launch
   *   reservation, or a hold). Nothing derived may override it.
   * - `derived` — no producer exists anywhere: the lease is free and the
   *   durable facts say what happened. Only this value licenses a reader to
   *   treat the stream's rows as final.
   * - `pending` — this row has not been opened yet, so the run tuple is
   *   unknown rather than absent. It converges when the row is opened and
   *   {@link hydrateRunFacts} reads it.
   * - `none` — read, lease free, and nothing durable is left of the run.
   *
   * `detail` is the human sentence for a stream that has no phase and cannot
   * get one (held elsewhere, or unreadable); a caller renders it read-only
   * with the `unavailable` sentinel. Pure and synchronous: every fact it
   * reads is already resident (the status machine, the always-resident
   * transcript summary, and the run tuple this row's own open captured). It
   * never writes and never starts a read.
   */
  resolveStreamPhase(stream: StreamTabId): ResolvedStreamPhase {
    const live = this.streamStatus.getStreamState(stream);
    // The hold is read before the phase because `markUnavailable` keeps the
    // phase the stream already had on the hold entry, so such an entry
    // answers `getStreamState` too. Taking the phase first would drop the
    // detail and offer the terminal buttons on a run this process does not
    // own — both facts belong to the caller.
    const hold = this.streamStatus.holdState(stream);
    if (hold !== undefined) {
      return { ...(live ? { state: live } : {}), origin: 'live', detail: hold };
    }
    if (live) return { state: live, origin: 'live' };

    // The run tuple this row's own open read, not the sidecar record: asking
    // it here neither loads a sidecar nor pins one resident (#9947). Absent
    // means the row has never been opened — the tuple is unknown rather than
    // empty. The transcript summary is resident for every stream either way,
    // so a transcript left open is enough to say the run was interrupted
    // without reading anything, which is what an unopened row renders from.
    const run = this._runFacts.get(stream);
    if (!run) {
      return this.streamLogs.hasUnfinishedOutput(stream)
        ? { state: { phase: STREAM_PHASE.CANCELLED }, origin: 'derived' }
        : { origin: 'pending' };
    }

    if (run.authorityFailure !== undefined) {
      return {
        origin: 'derived',
        detail: streamUnreadableMessage(run.authorityFailure),
      };
    }
    // A live foreign owner is not a finished run: an inferred terminal phase
    // here would offer Resume and Delete on a run another process is
    // executing. A lease this process holds with no live flow context is a
    // registry/lease disagreement — neither foreign nor ready.
    if (run.lease?.status === 'held') {
      return { origin: 'derived', detail: streamHeldMessage(run.lease.owner) };
    }
    if (run.lease?.status === 'owned') {
      return {
        origin: 'derived',
        detail: streamUnreadableMessage(
          'lease owned by this process with no live run',
        ),
      };
    }
    if (run.outcome) {
      return { state: { phase: run.outcome }, origin: 'derived' };
    }
    // No outcome and nobody alive to write one: the run was interrupted. A
    // surviving checkpoint or an unclosed transcript is the evidence, and
    // CANCELLED is the value every downstream table already renders for it.
    if (run.checkpointPresent || this.streamLogs.hasUnfinishedOutput(stream)) {
      return { state: { phase: STREAM_PHASE.CANCELLED }, origin: 'derived' };
    }
    return { origin: 'none' };
  }

  /**
   * {@link resolveStreamPhase}'s phase alone, for the render paths that only
   * need what the status machine used to answer.
   */
  getStreamPhaseState(stream: StreamTabId): StreamPhaseState | undefined {
    return this.resolveStreamPhase(stream).state;
  }

  /**
   * The outcome this stream's run durably settled on, or `undefined` while
   * anything can still move it. The one fact that licenses a reader to
   * repaint an unclosed task group or an unsettled call card as interrupted,
   * shared by every host so the CLI and the progress view never decide it
   * differently — and, for a group, the value the host-exit drain would have
   * written into its `GROUP_END`, so what a reader paints before settlement
   * is what it reads back after.
   *
   * Two ways to be final, both of which need the terminal outcome first — a
   * live run publishes CANCELLED the instant a user stops it, while its
   * stages are still writing their `GROUP_END` rows:
   * - `derived`: no producer exists anywhere, so the durable facts are the
   *   whole story ({@link resolveStreamPhase}).
   * - `live` with nothing left in this process to write: the phase entry is
   *   this process's own, but `finalizeRunTerminal` untracks the execution
   *   BEFORE it stores the terminal phase, so a run that left a group open
   *   (a throwing `stage.end()`) keeps answering `live` forever otherwise. A
   *   hold is excluded by its `detail`, and a launch reservation cannot reach
   *   here at all — a reserved entry reports RUNNING, never an outcome.
   */
  streamDurableOutcome(stream: StreamTabId): RunOutcome | undefined {
    const resolved = this.resolveStreamPhase(stream);
    const phase = resolved.state?.phase;
    if (!isTerminalOutcomePhase(phase)) return undefined;
    if (resolved.origin === 'derived') return phase;
    return resolved.origin === 'live' &&
      resolved.detail === undefined &&
      !this.hasLiveStreamExecution(stream)
      ? phase
      : undefined;
  }

  /** {@link streamDurableOutcome} as the bit alone, for the readers that only
   *  need to know that nothing can move the run any more. */
  streamDurablyFinal(stream: StreamTabId): boolean {
    return this.streamDurableOutcome(stream) !== undefined;
  }

  // todos/plan are owned + persisted by StreamSnapshotStore (workPlan.json).

  // -- Ephemeral execution state ----------------------------------------------

  getOrCreateStreamState(
    stream: StreamTabId,
    agentCategory: (typeof AgentCategory)[keyof typeof AgentCategory],
  ): StreamExecutionState {
    const ephemeral = this.getOrCreateEphemeral(stream);
    const existing = ephemeral.execution;
    if (!existing) {
      const state: StreamExecutionState = {
        category: agentCategory,
        conversationProgress: { toolCallCount: 0 },
        subagents: [],
      };
      ephemeral.execution = state;
      return state;
    }
    // Roster facts may provision a ToolUse placeholder before RUNNING supplies
    // the real category. Refresh category in place — do not wipe `subagents`.
    if (existing.category !== agentCategory) {
      const state: StreamExecutionState = {
        ...existing,
        category: agentCategory,
      };
      ephemeral.execution = state;
      return state;
    }
    return existing;
  }

  updateStreamState(
    stream: StreamTabId,
    updater: (prev: StreamExecutionState) => StreamExecutionState,
  ): void {
    const current = this._ephemeralState.get(stream)?.execution;
    if (current) {
      this.getOrCreateEphemeral(stream).execution = updater(current);
    }
  }

  /** Reset per-run ephemeral child state when a new run starts on the same
   *  stream — retained finished children belong to the previous run. */
  resetPerRunChildState(stream: StreamTabId): void {
    const current = this._ephemeralState.get(stream)?.execution;
    if (!current) return;

    const liveSubagents = current.subagents.filter(
      (child) => child.finishedAt === undefined,
    );
    const needsReset =
      liveSubagents.length !== current.subagents.length ||
      current.conversationProgress.toolCallCount !== 0 ||
      current.stage !== undefined;

    if (needsReset) {
      this.getOrCreateEphemeral(stream).execution = {
        ...current,
        subagents: liveSubagents,
        conversationProgress: { toolCallCount: 0 },
        stage: undefined,
      };
    }
  }

  /**
   * Read host-facing execution state. Parent rosters remain canonical while a
   * child deletion is provisional; this shared projection hides tombstoned
   * children from every host until that deletion settles.
   */
  getStreamState(stream: StreamTabId): StreamExecutionState | undefined {
    const state = this._ephemeralState.get(stream)?.execution;
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
    for (const [parent, ephemeral] of this._ephemeralState) {
      const state = ephemeral.execution;
      if (!state) continue;
      const tracksChild = state.subagents.some(
        (child) =>
          child.childStreamId === childStreamId && child.status !== phase,
      );
      if (!tracksChild) continue;
      ephemeral.execution = {
        ...state,
        subagents: state.subagents.map((child) =>
          child.childStreamId === childStreamId
            ? { ...child, status: phase }
            : child,
        ),
      };
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
   * stale. Called by the applier for a fresh workflow `run.start` whose
   * `ownerId` is in `view.liveOwners` (live-owner evidence), never for a
   * `run.start` whose owner cannot be proven alive: a delayed stale event
   * replayed after the deletion committed carries an owner that is not.
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
    this._ephemeralState.delete(stream);
    this._streamMetadataCache.delete(stream);
    this._runFacts.delete(stream);
    return { incarnation, changedRosterParents };
  }

  /** Whether `stream` was removed this session and must not be resurrected. */
  isStreamRemoved(stream: StreamTabId): boolean {
    return this._removedStreams.has(stream);
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
    for (const [parent, ephemeral] of this._ephemeralState) {
      if (
        ephemeral.execution?.subagents.some(
          (child) => child.childStreamId === stream,
        )
      ) {
        parents.push(parent);
      }
    }
    return parents;
  }

  private scrubStreamFromRosters(stream: StreamTabId): StreamTabId[] {
    const changedParents: StreamTabId[] = [];
    for (const [parent, ephemeral] of this._ephemeralState) {
      const state = ephemeral.execution;
      if (!state) continue;
      const subagents = state.subagents.filter(
        (child) => child.childStreamId !== stream,
      );
      if (subagents.length === state.subagents.length) continue;
      ephemeral.execution = { ...state, subagents };
      changedParents.push(parent);
    }
    return changedParents;
  }

  /** Drop the ephemeral status/session/execution/metadata-cache/run-fact
   *  state a cleared stream leaves behind. Callers still own tombstoning it in
   *  `_removedStreams` and, for `clearAll`, scrubbing rosters. */
  private clearEphemeralStreamState(stream: StreamTabId): void {
    this.streamStatus.clearStream(stream);
    this._ephemeralState.delete(stream);
    this._streamMetadataCache.delete(stream);
    this._runFacts.delete(stream);
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

    this.clearEphemeralStreamState(stream);
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
      ...this._ephemeralState.keys(),
      ...this.streamStatus.getAllStreamStates().keys(),
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
      this.clearEphemeralStreamState(stream);
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

  async load(): Promise<void> {
    this.logger.info('[Persistence] Starting state load from storage');

    // The session owns transcript opening and sidecar hydration; a
    // presentation must never reload those live stores. The leftover-stream
    // sweep (dropping leftover background shells, then orphaned persisted
    // state) is the host process's own, scheduled off this path once its UI is
    // up — see `scheduleLeftoverStreamSweep`. A presentation may therefore
    // attach before it has run, and never waits for it; this only drains
    // deletions that have already started.
    await this.stores.waitForPendingStreamDeletions();

    this.logger.info(
      `[Persistence] Discovered ${this.streamLogs.keys().length} stream(s)`,
    );

    // No all-streams metadata loop: stream metadata is assembled lazily in
    // `getStreamMetadata` from the always-resident summary mirror, so a load
    // has nothing to seed per stream (#9947).

    this.logger.info('[Persistence] Managers loaded');

    this.logger.info('[Persistence] State load complete');
  }
}
