import PQueue from 'p-queue';

import { RUN_FACT_EVENT_TYPES } from '@agent/trace';
import type { DeleteStreamResult, SessionStores } from '@agent/storage';
import { detachSubagentsOnStop } from '@agent/runtime/detachSubagentsOnStop';
import type { HostApprovalBypassStateUpdate } from '@agent/runtime/HostInteractions';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  WebviewBridge,
  type ProgressViewMessageSender,
} from '@controllers/progressView/backend/WebviewBridge';
import { LitSessionRenderer } from '@controllers/progressView/backend/LitSessionRenderer';
import { ProgressPresentationState } from '@controllers/progressView/backend/ProgressPresentationState';
import type { GetProgressStreamControls } from '@controllers/progressView/progressStreamControls';
import {
  SessionFactApplier,
  type SessionRunFactEvent,
} from '@controllers/session/SessionFactApplier';
import { SessionState } from '@controllers/session/SessionState';
import type { PresentedStreamId } from '@controllers/session/SessionRendererPort';
import {
  buildApprovalRequestHandlerSet,
  createProgressBackendUiConfig,
  type ApprovalRequestHandlerSet,
  type BuildApprovalRequestHandlerSetParams,
} from '@controllers/progressView/backend/progressBackendUiConfig';
import { createLog } from '@logger/logUtils';
import type { StateStore } from '@platform/interfaces';
import type {
  ProgressViewOutboundMessage,
  SetActiveStreamPayload,
  StreamTabId,
} from '@shared/schemas';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { RETRY_REQUEST_CLEARED_CAUSE } from '@shared/copy/interactionCancellation';
import { isInFlightPhase } from '@shared/streams/streamStatus';
import type { TranscriptPresentationLease } from '@transcript/StreamLogStore';
import { canUseStreamDataDir } from '@transcript/streamDataPaths';
import { aggregateError } from '@utils/core';

const log = createLog('ProgressBackend');

type ProgressBackendApprovalOptions = Omit<
  BuildApprovalRequestHandlerSetParams,
  'renderer'
>;

interface ProgressBackendLifecycleOptions {
  cleanupDeletedStream(stream: StreamTabId): void;
  cleanupDeletedStreams(options: { allDeleted: boolean }): void;
  rebuildRenderedStreams(options: { syncActiveStream: boolean }): Promise<void>;
  notifyDeletionRetained(
    activeCount: number,
    failedCount: number,
  ): Promise<void> | void;
}

export interface ProgressBackendOptions {
  storage: StateStore;
  stores?: SessionStores;
  sendMessage: ProgressViewMessageSender;
  hasTarget(): boolean;
  approvals: ProgressBackendApprovalOptions;
  lifecycle: ProgressBackendLifecycleOptions;
  reportTranscriptLoadError(error: unknown, stream: StreamTabId | ''): void;
  getStreamControls: GetProgressStreamControls;
  /** Session that owns this backend's coordination state. */
  session: SessionHandle;
  /**
   * `session` when the caller has already loaded and swept the session's
   * stores at process start. A process-owned session has opened the canonical
   * live store, so a replacement presentation must not reload or sweep it.
   */
  stateOwnership?: 'backend' | 'session';
  /**
   * Commands this host's progressView inbound registry declares
   * `unsupported(...)` — pass `() => unsupportedCommands(registry)`. Threaded
   * to {@link LitSessionRenderer} so the frontend's capability gating stays a
   * projection of the registry.
   */
  getUnsupportedCommands?: () => readonly string[];
}

/**
 * Host-neutral progress-view backend composition.
 *
 * Hosts provide only storage, transport, and UI callbacks. The state manager,
 * message builders, log bridge, and session event handler are constructed as one
 * graph so extension and desktop can converge on the same backend boundary.
 */
export class ProgressBackend {
  readonly state: SessionState;
  readonly presentation: ProgressPresentationState;
  /** The single owner of Lit/progress-view delivery for this backend. */
  readonly renderer: LitSessionRenderer;
  readonly webviewBridge: WebviewBridge;
  readonly approvalHandlers: ApprovalRequestHandlerSet;
  readonly setApprovalBypassState: (
    update: HostApprovalBypassStateUpdate,
  ) => void;
  private readonly factApplier: SessionFactApplier;
  private readonly session: SessionHandle;
  private readonly lifecycle: ProgressBackendLifecycleOptions;
  private readonly reportTranscriptLoadError: ProgressBackendOptions['reportTranscriptLoadError'];
  private readonly postMessage: (message: ProgressViewOutboundMessage) => void;
  private readonly stateOwnership: 'backend' | 'session';
  private readonly hasPendingPermissions: (streamId: string) => boolean;
  private readonly storageOperationQueue = new PQueue({ concurrency: 1 });
  private readonly detachEventListeners: Array<() => void> = [];
  private activationGeneration = 0;
  private latestActivationTarget: PresentedStreamId = '';
  private readonly inFlightActivationGenerations = new Set<number>();
  private transcriptPresentationLease?: TranscriptPresentationLease;
  private disposed = false;

  constructor(options: ProgressBackendOptions) {
    this.session = options.session;
    this.stateOwnership = options.stateOwnership ?? 'backend';
    this.lifecycle = options.lifecycle;
    this.reportTranscriptLoadError = options.reportTranscriptLoadError;
    this.postMessage = (message) => {
      if (!options.hasTarget()) return;
      // View refreshes are best-effort; a closed transport must not take down
      // the backend. The async wrapper funnels sync throws and rejections into
      // one reporting path, logged at debug like `WebviewBridge.deliver` — the
      // next full refresh re-sends whatever this frame carried.
      void (async () => options.sendMessage(message))().catch(
        (error: unknown) => {
          log.debug('Failed to deliver message to webview', {
            data: { command: message.command, error },
          });
        },
      );
    };
    this.state = new SessionState(this.session, options.stores);
    this.presentation = new ProgressPresentationState(options.storage);
    this.webviewBridge = new WebviewBridge(
      this.state.streamLogs,
      options.sendMessage,
      () => this.presentation.activeStream || null,
    );
    this.renderer = new LitSessionRenderer(
      this.state,
      options.getStreamControls,
      this.webviewBridge,
      this.postMessage,
      options.hasTarget,
      () => this.presentation.activeStream,
      options.getUnsupportedCommands,
    );

    this.approvalHandlers = buildApprovalRequestHandlerSet({
      ...options.approvals,
      renderer: this.renderer,
    });
    const ui = createProgressBackendUiConfig({
      handlers: this.approvalHandlers,
      renderer: this.renderer,
      canSend: options.approvals.canSend,
    });
    this.hasPendingPermissions = ui.hasPendingPermissions;
    this.factApplier = new SessionFactApplier(this.state, this.renderer, {
      deleteStream: (stream, expectedIncarnation, beforeRetainedRepair) =>
        this.deleteStream(stream, expectedIncarnation, beforeRetainedRepair),
      // The committed selection, plus the target of an activation still in
      // flight: an activation preloads the sidecar before it selects, so a
      // terminal status landing in that window must not evict what the
      // imminent `syncStreamContent` is about to read. Gated on the in-flight
      // set because `latestActivationTarget` is sticky — it survives a failed
      // or superseded activation, and would otherwise pin that stream's
      // record for the rest of the session.
      isStreamPresented: (stream) =>
        !this.disposed &&
        ((this.renderer.isAvailable() &&
          this.presentation.activeStream === stream) ||
          (this.latestActivationTarget === stream &&
            this.inFlightActivationGenerations.has(this.activationGeneration))),
    });
    this.setApprovalBypassState = ui.setApprovalBypassState;
  }

  /** Rebuild stream tabs and, when requested, rehydrate the active viewport. */
  async syncRenderedStreams(options: {
    syncActiveStream: boolean;
  }): Promise<void> {
    const selectableStreams = this.state.selectableStreamNames();
    const activeStream = this.presentation.activeStream;
    const desiredStream = this.presentation.choose(selectableStreams);
    const rosterActiveStream = selectableStreams.includes(activeStream)
      ? activeStream
      : '';
    const pendingSelectableActivation =
      this.inFlightActivationGenerations.has(this.activationGeneration) &&
      this.latestActivationTarget !== '' &&
      selectableStreams.includes(this.latestActivationTarget);
    let projectedStream = options.syncActiveStream
      ? desiredStream
      : rosterActiveStream;
    if (options.syncActiveStream && pendingSelectableActivation) {
      projectedStream = this.latestActivationTarget;
    }
    this.renderer.sendStreamMetadata(projectedStream, rosterActiveStream);
    if (!options.syncActiveStream) return;
    if (pendingSelectableActivation) {
      // A structural refresh must not supersede a newer user selection that
      // the backend has already accepted and is still hydrating.
      return;
    }

    try {
      await this.hydrateAndCommitSelection(desiredStream, {
        notifyActivation: activeStream !== desiredStream,
      });
    } catch (error) {
      this.reportTranscriptLoadError(error, desiredStream);
    }
  }

  /** Select and render one existing stream without rebuilding the tab list. */
  async activateStream(
    stream: PresentedStreamId,
    requestId?: string,
  ): Promise<void> {
    // The fact path re-claims a deterministic workflow stream before it
    // reaches this call; every other removed identity must not be focused,
    // even when `streamLogs` still has a summary for a provisional removal
    // that has not committed yet.
    if (
      stream &&
      (this.state.isStreamRemoved(stream) || !this.state.streamLogs.has(stream))
    ) {
      // A newer rejected request still supersedes every older hydration. Its
      // visual intent is settled back to the confirmed selection below.
      this.activationGeneration += 1;
      this.latestActivationTarget = stream;
      if (requestId) {
        this.renderer.settleStreamSelection(
          requestId,
          'rejected',
          this.presentation.activeStream,
        );
      }
      return;
    }
    try {
      const committed = await this.hydrateAndCommitSelection(stream, {
        notifyActivation: true,
      });
      if (!committed) await this.recoverFromFailedActivation(stream);
      if (requestId) {
        this.renderer.settleStreamSelection(
          requestId,
          committed ? 'accepted' : 'superseded',
          this.presentation.activeStream,
        );
      }
    } catch (error) {
      this.reportTranscriptLoadError(error, stream);
      await this.recoverFromFailedActivation(stream);
      if (requestId) {
        this.renderer.settleStreamSelection(
          requestId,
          'rejected',
          this.presentation.activeStream,
        );
      }
    }
  }

  /**
   * If deletion removed the confirmed stream while a replacement was loading,
   * recover from that replacement's failure with one different survivor. A
   * newer activation or explicit deselection always remains authoritative.
   */
  private async recoverFromFailedActivation(
    failedStream: StreamTabId,
  ): Promise<void> {
    if (
      this.presentation.activeStream !== '' ||
      this.latestActivationTarget !== failedStream ||
      this.inFlightActivationGenerations.has(this.activationGeneration)
    ) {
      return;
    }
    const fallback = this.presentation.choose(
      this.state
        .selectableStreamNames()
        .filter((stream) => stream !== failedStream),
    );
    if (!fallback) return;

    try {
      // This is deliberately one-shot. A failed fallback is reported but does
      // not recurse through the roster or retry a known failed target.
      await this.hydrateAndCommitSelection(fallback, {
        notifyActivation: true,
      });
    } catch (error) {
      this.reportTranscriptLoadError(error, fallback);
    }
  }

  private async hydrateAndCommitSelection(
    stream: StreamTabId | '',
    options: {
      notifyActivation: boolean;
    },
  ): Promise<boolean> {
    const generation = ++this.activationGeneration;
    this.latestActivationTarget = stream;
    if (!stream) {
      const previousStream = this.selectPresentedStream('');
      this.releasePresentationLeases();
      if (this.renderer.isAvailable()) {
        this.renderer.onActiveStreamChanged('');
        this.renderer.syncStreamContent('');
        if (previousStream) {
          this.renderer.releaseStreamContent(previousStream);
        }
      }
      return true;
    }
    if (!this.renderer.isAvailable()) {
      this.selectPresentedStream(stream);
      this.releasePresentationLeases();
      return true;
    }

    const leasePromise = this.state.streamLogs.ensureLoaded(stream, {
      retainForPresentation: true,
    });
    this.inFlightActivationGenerations.add(generation);
    const hydration = await Promise.allSettled([
      leasePromise,
      this.state.snapshots.preload([stream]),
    ]);
    this.inFlightActivationGenerations.delete(generation);
    const transcriptLeaseResult = hydration[0];
    const failures = hydration.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    // An activation that never commits leaves behind exactly what it
    // hydrated: the transcript lease it took, and a sidecar record the
    // preload above made resident. Nothing later revisits this stream — it
    // never becomes the committed selection — so both are released here.
    const abandonActivation = () => {
      if (transcriptLeaseResult.status === 'fulfilled') {
        transcriptLeaseResult.value.close();
      }
      this.factApplier.retireSidecarIfFinishedChild(stream);
    };
    if (generation !== this.activationGeneration) {
      abandonActivation();
      return false;
    }
    if (!this.state.streamLogs.has(stream)) {
      abandonActivation();
      return false;
    }
    if (failures.length > 0) {
      abandonActivation();
      throw aggregateError(
        failures.map((failure) => failure.reason),
        `Failed to hydrate stream ${stream}`,
      );
    }
    // Narrows the union for the .value reads below; the failures check above
    // has already thrown for any rejection.
    if (transcriptLeaseResult.status !== 'fulfilled')
      throw transcriptLeaseResult.reason;

    const previousStream = this.presentation.activeStream;
    const previousTranscriptLease = this.transcriptPresentationLease;
    this.transcriptPresentationLease = transcriptLeaseResult.value;
    this.selectPresentedStream(stream);
    if (options.notifyActivation) this.renderer.onActiveStreamChanged(stream);
    this.renderer.syncStreamContent(stream);
    if (previousStream && previousStream !== stream) {
      this.renderer.releaseStreamContent(previousStream);
    }
    if (previousTranscriptLease !== transcriptLeaseResult.value)
      previousTranscriptLease?.close();
    return true;
  }

  /**
   * Move the committed selection, and retire what it replaced. Every path
   * that changes the selection goes through this, so a finished child that
   * was presented — and therefore skipped by the terminal-status rule — is
   * released exactly once, whichever path replaced it and whether or not a
   * renderer was available at the time.
   */
  private selectPresentedStream(next: PresentedStreamId): PresentedStreamId {
    const previous = this.presentation.activeStream;
    this.presentation.select(next);
    if (previous && previous !== next) {
      this.factApplier.retireSidecarIfFinishedChild(previous);
    }
    return previous;
  }

  private releasePresentationLeases(): void {
    const transcriptLease = this.transcriptPresentationLease;
    this.transcriptPresentationLease = undefined;
    transcriptLease?.close();
  }

  /** Apply presentation policy carried beside a stream attachment fact. */
  private handleStreamPresentationRequest(
    payload: SetActiveStreamPayload,
  ): void {
    const stream = payload.streamId;
    if (!stream) {
      void this.hydrateAndCommitSelection('', { notifyActivation: true });
      return;
    }
    if (payload.suppressViewSwitch === true) return;
    const current = this.presentation.activeStream;
    if (current && this.hasPendingPermissions(current)) return;
    void this.activateStream(stream);
  }

  /** Awaitable status application for tests and hosts that cannot fire-and-forget. */
  applyStreamStatus(
    ...args: Parameters<SessionFactApplier['setStreamStatus']>
  ): ReturnType<SessionFactApplier['setStreamStatus']> {
    return this.factApplier.setStreamStatus(...args);
  }

  /**
   * Admit one session fact through the applier, then apply presentation
   * policy for an accepted attachment. A refused attachment (removed stream)
   * must not activate or lease.
   */
  private admitSessionFact(
    fact: Parameters<SessionFactApplier['handleSessionFact']>[0],
  ): boolean {
    const admitted = this.factApplier.handleSessionFact(fact);
    if (admitted && fact.type === 'setActiveStream') {
      this.handleStreamPresentationRequest(fact.payload);
    }
    return admitted;
  }

  /** Inject a session fact (tests / rare host seeds). Prefer the hub in production. */
  applySessionFact(
    fact: Parameters<SessionFactApplier['handleSessionFact']>[0],
  ): boolean {
    return this.admitSessionFact(fact);
  }

  /** Inject a run fact (tests / rare host seeds). Prefer the hub in production. */
  applyRunFact(...args: Parameters<SessionFactApplier['handleRunFact']>): void {
    this.factApplier.handleRunFact(...args);
  }

  /**
   * Stop `stream`'s run in this process — the one owner of the cancel-then-stop
   * body both hosts used to duplicate.
   *
   * A user-initiated stop (the toolbar button, through
   * `PROGRESS_VIEW_COMMANDS.STOP_STREAM`) also clears a pending retry request,
   * so the retry UI goes away with the run. Deletion's implicit stop calls
   * {@link stopRun} instead: it is not an answer to a retry prompt.
   *
   * Stays `async` even though the body is synchronous: the inbound dispatcher
   * only attaches `.catch(onError)` when a handler returns a Promise, so a
   * `void` return would let a synchronous throw from `stopAgentStream` escape
   * `dispatchInbound` as an unhandled rejection instead of the error log and
   * user-facing toast.
   */
  async stopStream(stream: StreamTabId): Promise<void> {
    // Session-level cancel, not adapter-level: it settles session-owned pending
    // interactions *and* forwards to the attached host adapter, so the
    // RETRY_REQUEST_CLEARED_CAUSE selector is the one the retry settlement sees.
    this.session.interactions.cancel({
      streamId: stream,
      kind: 'retry',
      cause: RETRY_REQUEST_CLEARED_CAUSE,
    });
    this.stopRun(stream);
  }

  /** Stop the run without touching a pending retry request. */
  private stopRun(stream: StreamTabId): void {
    this.session.executions.stopAgentStream(stream, {
      detachActiveChildren: detachSubagentsOnStop(),
    });
  }

  /**
   * Delete a stream's durable state. Resolves to the retention outcome so the
   * session-fact applier can keep its removal barrier provisional until the
   * deletion commits: `active`/`failed` mean the stream still lives.
   */
  async deleteStream(
    stream: StreamTabId,
    expectedIncarnation?: number,
    beforeRetainedRepair?: (outcome: 'active' | 'failed') => void,
  ): Promise<DeleteStreamResult | undefined> {
    const wasActive = this.presentation.activeStream === stream;
    const activationGeneration = this.activationGeneration;

    // A host command (no caller incarnation) owns its removal barrier and
    // pending buffer through the applier, exactly like a `removeStream` fact.
    // If a fact-path barrier already owns this identity, do not start a second
    // deletion or touch that barrier.
    let commandRemoval: { incarnation: number; created: boolean } | undefined;
    if (expectedIncarnation === undefined) {
      commandRemoval = this.factApplier.beginCommandRemoval(stream);
      if (!commandRemoval.created) return 'superseded';
      expectedIncarnation = commandRemoval.incarnation;
    }
    const releaseDeletionClaim = this.state.stores.claimStreamDeletion(
      stream,
      expectedIncarnation,
    );

    let retained: DeleteStreamResult | undefined;
    try {
      retained = await this.enqueuePreparedStorageOperation(
        // Pre-delete preparation is the one failure shape we can classify: it
        // definitely did not delete anything, so report `failed` and let the
        // applier retire the provisional barrier. A post-delete failure is
        // ambiguous and stays a rejection, so the barrier is kept.
        () =>
          this.prepareStreamDeletion(stream).catch((error) => {
            log.warn(
              `Stream ${stream} was retained because deletion preparation failed`,
              { data: error },
            );
            return true;
          }),
        (preparationRetained) => {
          if (preparationRetained) {
            return Promise.resolve('failed' as const);
          }
          return this.deleteStreamNow(
            stream,
            wasActive,
            activationGeneration,
            expectedIncarnation,
          );
        },
      );
    } catch (error) {
      releaseDeletionClaim();
      if (commandRemoval) {
        this.factApplier.abortCommandRemoval(
          stream,
          commandRemoval.incarnation,
          commandRemoval.created,
        );
      }
      throw error;
    }
    releaseDeletionClaim();

    const retainedOutcome =
      retained === 'active' || retained === 'failed' ? retained : undefined;
    if (commandRemoval) {
      // Retire a retained command-owned tombstone before rebuilding the tab
      // rail. selectableStreamNames() deliberately hides provisional
      // removals, so repairing presentation first would omit the stream that
      // durable cleanup just reported as still live.
      this.factApplier.completeCommandRemoval(
        stream,
        commandRemoval.incarnation,
        retained,
        commandRemoval.created,
      );
    } else if (retainedOutcome) {
      // A fact-path removal owns its barrier in SessionFactApplier. Let it
      // retire and replay before this retained-state rebuild enumerates the
      // selectable rail, which deliberately hides provisional removals.
      beforeRetainedRepair?.(retainedOutcome);
    }

    if (retainedOutcome) {
      await this.repairAfterDeletion({
        syncActiveStream: true,
        retainedNotify: {
          activeCount: retainedOutcome === 'active' ? 1 : 0,
          failedCount: retainedOutcome === 'failed' ? 1 : 0,
        },
        warnings: {
          rebuild: {
            message:
              'Failed to rebuild rendered streams after a retained deletion',
            data: { stream, retained },
          },
          notify: {
            message: 'Failed to notify after a retained stream deletion',
            data: { stream, retained },
          },
        },
      });
    }

    return retained;
  }

  /** Whether local durable state exists for `stream` (log or task snapshot). */
  private hasDeletableStreamData(stream: StreamTabId): boolean {
    // Read config presence from the always-resident summary mirror: deletion
    // sweeps over historical streams must not force per-stream sidecar reads.
    return (
      this.state.streamLogs.has(stream) ||
      Boolean(this.state.getStreamMetadata(stream).config)
    );
  }

  /**
   * Per-stream prepare shared by single- and all-delete: stop an in-flight
   * stream we own locally. The deletion itself runs as a step on the stream's
   * execution lane (`SessionStores.deleteStream`), so it lands only after the
   * stopped generation has disposed; nothing here needs to wait for it.
   */
  private async prepareStreamDeletionCore(
    stream: StreamTabId,
  ): Promise<boolean> {
    const ownedLocally =
      this.session.executions.getAgentHandleByStream(stream) !== undefined;
    if (ownedLocally && isInFlightPhase(this.session.status.get(stream))) {
      this.stopRun(stream);
    }
    return false;
  }

  private async prepareStreamDeletion(stream: StreamTabId): Promise<boolean> {
    if (!canUseStreamDataDir(stream)) return false;
    if (!this.hasDeletableStreamData(stream)) return false;
    return this.prepareStreamDeletionCore(stream);
  }

  /**
   * Whether an activation that started after `generationAtStart` expresses a
   * selection intent a finishing deletion must respect: an explicit
   * deselection, or a switch to some stream other than the deleted one that
   * still has a transcript. Anything else (a switch to the deleted stream
   * itself, or to an identity that no longer exists) lets the deletion path
   * choose the surviving selection.
   */
  private newerIntentControlsSelection(
    generationAtStart: number,
    deletedStream?: StreamTabId,
  ): boolean {
    if (generationAtStart === this.activationGeneration) return false;
    const target = this.latestActivationTarget;
    return (
      target === '' ||
      (target !== deletedStream && this.state.streamLogs.has(target))
    );
  }

  private async deleteStreamNow(
    stream: StreamTabId,
    wasActive: boolean,
    activationGenerationAtStart: number,
    expectedIncarnation?: number,
  ): Promise<DeleteStreamResult | undefined> {
    // `undefined` means the deletion never ran (reserved id / cannot-use data
    // dir), not "deleted": the command path relies on a committed deletion
    // being reported as `deleted` so it keeps the tombstone it just installed.
    if (!canUseStreamDataDir(stream)) return undefined;

    const hadDeletableData = this.hasDeletableStreamData(stream);
    // An undefined expectedIncarnation falls back to the current incarnation
    // inside `clearStream`, matching the no-options call this replaces.
    const deletion = await this.state.clearStream(stream, {
      expectedIncarnation,
    });
    if (deletion !== 'deleted') {
      return deletion;
    }
    // `clearStream` deleted and tombstoned the stream, so report `deleted`
    // even when it had no durable data (ephemeral-only): the caller must not
    // retire the tombstone a stale fact could then resurrect through.
    if (!hadDeletableData) return 'deleted';

    this.lifecycle.cleanupDeletedStream(stream);
    this.webviewBridge.clearStream(stream);
    const selectionWasDeleted = this.presentation.activeStream === stream;
    if (selectionWasDeleted) {
      this.presentation.select('');
      this.releasePresentationLeases();
    }

    const remainingStreams = this.state.selectableStreamNames();
    const activeAfterClear = this.presentation.activeStream;
    const hasVisibleActive =
      activeAfterClear !== '' && remainingStreams.includes(activeAfterClear);
    const newerActivationPending =
      activationGenerationAtStart !== this.activationGeneration;
    const newerIntentControls = this.newerIntentControlsSelection(
      activationGenerationAtStart,
      stream,
    );
    // A concurrent switch to a surviving stream still needs reassertion after
    // DELETE_STREAM. A concurrent explicit deselection is presentation intent
    // and must remain empty rather than being replaced by a fallback.
    const shouldActivateStream =
      !newerIntentControls &&
      (selectionWasDeleted || (wasActive && hasVisibleActive));

    this.postMessage({
      command: PROGRESS_VIEW_COMMANDS.DELETE_STREAM,
      stream,
    });

    const nextActive = hasVisibleActive
      ? activeAfterClear
      : this.presentation.choose(remainingStreams);
    if (shouldActivateStream && nextActive) {
      // DELETE_STREAM clears the frontend selection when the deleted tab was
      // active. Reassert the surviving selection even when a concurrent
      // activation already selected it while storage deletion was pending.
      await this.activateStream(nextActive);
    } else if (!newerActivationPending) {
      // The deleted stream was not the active one, so only the stream list
      // changed; the active stream's content is still on screen and correct.
      await this.lifecycle.rebuildRenderedStreams({ syncActiveStream: false });
    }
    return 'deleted';
  }

  async deleteAllStreams(): Promise<void> {
    const activationGeneration = this.activationGeneration;
    const outcome = await this.enqueuePreparedStorageOperation(
      () => this.prepareAllStreamDeletions(),
      () => this.deleteAllStreamsNow(),
    );
    const newerIntentControls =
      this.newerIntentControlsSelection(activationGeneration);
    await this.repairAfterDeletion({
      syncActiveStream: !outcome.allDeleted && !newerIntentControls,
      retainedNotify: outcome.allDeleted
        ? undefined
        : {
            activeCount: outcome.activeCount,
            failedCount: outcome.failedCount,
          },
      warnings: {
        rebuild: {
          message: 'Failed to rebuild rendered streams after bulk deletion',
          data: { allDeleted: outcome.allDeleted },
        },
        notify: {
          message: 'Failed to notify after a retained bulk deletion',
          data: {
            activeCount: outcome.activeCount,
            failedCount: outcome.failedCount,
          },
        },
      },
    });
  }

  /**
   * Best-effort presentation repair, each failure isolated so a broken
   * rebuild cannot suppress the retention notification and neither can
   * make the deletion outcome disappear. The session-fact applier must
   * still see `active`/`failed` and retire its provisional tombstone.
   */
  private async repairAfterDeletion(options: {
    syncActiveStream: boolean;
    retainedNotify?: { activeCount: number; failedCount: number };
    warnings: {
      rebuild: { message: string; data: Record<string, unknown> };
      notify: { message: string; data: Record<string, unknown> };
    };
  }): Promise<void> {
    try {
      await this.lifecycle.rebuildRenderedStreams({
        syncActiveStream: options.syncActiveStream,
      });
    } catch (error) {
      log.warn(options.warnings.rebuild.message, {
        data: { ...options.warnings.rebuild.data, error },
      });
    }
    if (!options.retainedNotify) return;
    try {
      await this.lifecycle.notifyDeletionRetained(
        options.retainedNotify.activeCount,
        options.retainedNotify.failedCount,
      );
    } catch (error) {
      log.warn(options.warnings.notify.message, {
        data: { ...options.warnings.notify.data, error },
      });
    }
  }

  private async prepareAllStreamDeletions(): Promise<void> {
    // Runs the per-stream prepare over every known stream — deliberately
    // without the single-delete guards, so in-flight reserved-segment streams
    // are still stopped before clearAll() exactly as before the shared core.
    // `clearAll` reports ownership-read and lane refusals through its own
    // failed set.
    await Promise.all(
      this.state.streamLogs
        .keys()
        .map((stream) => this.prepareStreamDeletionCore(stream)),
    );
  }

  private async deleteAllStreamsNow(): Promise<{
    allDeleted: boolean;
    activeCount: number;
    failedCount: number;
  }> {
    const streamIds = this.state.streamLogs.keys();
    const retained = await this.state.clearAll();
    const retainedStreams = new Set([...retained.active, ...retained.failed]);
    const deleted = streamIds.filter((stream) => !retainedStreams.has(stream));
    for (const stream of deleted) {
      this.lifecycle.cleanupDeletedStream(stream);
      this.webviewBridge.clearStream(stream);
    }
    const allDeleted = retainedStreams.size === 0;
    if (allDeleted) {
      this.presentation.reset();
      this.releasePresentationLeases();
    } else if (!retainedStreams.has(this.presentation.activeStream)) {
      // The rebuild below chooses the ordered fallback, hydrates transcript
      // and sidecar state, then persists it. Do not confirm before hydration.
      this.presentation.select('');
      this.releasePresentationLeases();
    }
    this.lifecycle.cleanupDeletedStreams({ allDeleted });
    if (allDeleted) {
      this.postMessage({ command: PROGRESS_VIEW_COMMANDS.DELETE_ALL });
    } else {
      for (const stream of deleted) {
        this.postMessage({
          command: PROGRESS_VIEW_COMMANDS.DELETE_STREAM,
          stream,
        });
      }
    }
    return {
      allDeleted,
      activeCount: retained.active.size,
      failedCount: retained.failed.size,
    };
  }

  load(): Promise<void> {
    return this.enqueueStorageOperation(async () => {
      await this.session.waitUntilReady();
      await this.state.load(this.stateOwnership);
    });
  }

  /**
   * Serialize storage operations against each other, so a deletion never
   * interleaves with a concurrent load or another deletion.
   */
  private enqueueStorageOperation<T>(work: () => Promise<T>): Promise<T> {
    // `add` widens to `T | void` for abort/timeout options; neither is used,
    // so every enqueued operation runs and resolves with its result.
    return this.storageOperationQueue.add(work) as Promise<T>;
  }

  /**
   * Reserve queue order before stopping executions, but perform that
   * preparation outside the queue, so an earlier queued deletion waiting on
   * the same execution leases can still observe their release.
   */
  private enqueuePreparedStorageOperation<T, P>(
    prepare: () => Promise<P>,
    work: (prepared: P) => Promise<T>,
  ): Promise<T> {
    const preparation = Promise.resolve().then(prepare);
    // If an earlier queue entry is still running, attach a rejection handler
    // until this operation reaches the same promise.
    void preparation.catch(() => undefined);
    return this.enqueueStorageOperation(() => preparation.then(work));
  }

  /**
   * Attach this backend's session-fact listeners. {@link dispose} detaches
   * them, so a fact emitted afterwards reaches no handler and callers need no
   * subscription handle of their own. Attaching after disposal is a no-op:
   * a host can close its window while its presentation is still being built.
   */
  setupEventListeners(): void {
    if (this.disposed) return;
    this.detachEventListeners.push(
      this.session.events.subscribe(
        (sessionEvent) => {
          if (sessionEvent.scope !== 'session') return;
          this.admitSessionFact(sessionEvent.event);
        },
        { scope: 'session' },
      ),
      this.session.events.subscribe(
        (sessionEvent) => {
          if (sessionEvent.scope !== 'run') return;
          this.factApplier.handleRunFact(
            sessionEvent.streamId,
            // Narrowed by the subscription filter below, which admits only
            // `RUN_FACT_EVENT_TYPES`.
            sessionEvent.event as SessionRunFactEvent,
          );
        },
        { scope: 'run', types: RUN_FACT_EVENT_TYPES },
      ),
    );
  }

  /** The backend's single teardown: no host holds a second disposal handle. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const detach of this.detachEventListeners.splice(0)) detach();
    // Disposal is this host's last "stops presenting", and the session
    // outlives the window, so nothing else would revisit a finished child
    // that was still selected. The selection itself is a persisted user
    // preference and stays as it is; `isStreamPresented` reads `disposed`,
    // so the rule already sees this host as presenting nothing.
    const presented = this.presentation.activeStream;
    if (presented) this.factApplier.retireSidecarIfFinishedChild(presented);
    this.factApplier.dispose();
    this.activationGeneration += 1;
    this.releasePresentationLeases();
    this.webviewBridge.dispose();
  }
}
