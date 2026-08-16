import PQueue from 'p-queue';

import { RUN_FACT_EVENT_TYPES } from '@agent/trace';
import type { DeleteStreamResult, SessionStores } from '@agent/storage';
import type { HostApprovalBypassStateUpdate } from '@agent/runtime/HostInteractions';
import {
  defaultSession,
  type SessionHandle,
  type WorkspaceStorageTransitionHooks,
} from '@agent/runtime/SessionHandle';
import {
  WebviewBridge,
  type ProgressViewMessageSender,
} from '@controllers/progressView/backend/WebviewBridge';
import { LitSessionRenderer } from '@controllers/progressView/backend/LitSessionRenderer';
import { ProgressPresentationState } from '@controllers/progressView/backend/ProgressPresentationState';
import { ProgressStreamProjectionBuilder } from '@controllers/progressView/backend/ProgressStreamProjectionBuilder';
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
import { STREAM_PHASE } from '@shared/schemas';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { isInFlightPhase } from '@shared/streams/streamStatus';
import type { TranscriptPresentationLease } from '@transcript/StreamLogStore';
import { canUseStreamDataDir } from '@transcript/streamDataPaths';

const log = createLog('ProgressBackend');

type ProgressBackendApprovalOptions = Omit<
  BuildApprovalRequestHandlerSetParams,
  'renderer'
>;

interface ProgressBackendLifecycleOptions {
  stopStream(
    stream: StreamTabId,
    options?: { clearRetryRequest?: boolean },
  ): Promise<void> | void;
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
  getStreamControls?: GetProgressStreamControls;
  /** Session that owns this backend's coordination state (defaults to the process session). */
  session?: SessionHandle;
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
  readonly projections: ProgressStreamProjectionBuilder;
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
  private storageGeneration = 0;
  private presentationReloadPending = false;
  private activationGeneration = 0;
  private latestActivationTarget: PresentedStreamId = '';
  private readonly inFlightActivationGenerations = new Set<number>();
  private transcriptPresentationLease?: TranscriptPresentationLease;
  private disposed = false;

  constructor(options: ProgressBackendOptions) {
    this.session = options.session ?? defaultSession();
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
    this.projections = new ProgressStreamProjectionBuilder(
      this.state,
      options.getStreamControls,
    );
    this.webviewBridge = new WebviewBridge(
      this.state.streamLogs,
      options.sendMessage,
      () => this.presentation.activeStream || null,
    );
    this.renderer = new LitSessionRenderer(
      this.projections,
      this.state.snapshots,
      this.state.followUps,
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
      deleteStream: (stream) => this.deleteStream(stream),
    });
    this.setApprovalBypassState = ui.setApprovalBypassState;
  }

  /** Rebuild stream tabs and, when requested, rehydrate the active viewport. */
  async syncRenderedStreams(options: {
    syncActiveStream: boolean;
    theme?: 'dark' | 'light';
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
    this.renderer.sendStreamMetadata(
      this.projections.streamRoster(
        projectedStream,
        this.state.streamStatus.getAllStreamStates(),
      ),
      rosterActiveStream,
      options.theme,
    );
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
    if (stream && !this.state.streamLogs.has(stream)) {
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
      const previousStream = this.presentation.activeStream;
      this.presentation.select('');
      this.releasePresentationLeases();
      if (this.renderer.isAvailable()) {
        this.renderer.onActiveStreamChanged('');
        this.renderer.syncStreamContent('', { includeActiveState: true });
        if (previousStream) {
          this.renderer.releaseStreamContent(previousStream);
        }
      }
      return true;
    }
    if (!this.renderer.isAvailable()) {
      this.presentation.select(stream);
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
    const snapshotLeaseResult = hydration[1];
    const failures = hydration.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (generation !== this.activationGeneration) {
      if (transcriptLeaseResult.status === 'fulfilled')
        transcriptLeaseResult.value.close();
      return false;
    }
    if (!this.state.streamLogs.has(stream)) {
      if (transcriptLeaseResult.status === 'fulfilled')
        transcriptLeaseResult.value.close();
      return false;
    }
    if (failures.length > 0) {
      if (transcriptLeaseResult.status === 'fulfilled')
        transcriptLeaseResult.value.close();
      if (failures.length === 1) throw failures[0].reason;
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `Failed to hydrate stream ${stream}`,
      );
    }
    if (transcriptLeaseResult.status !== 'fulfilled')
      throw transcriptLeaseResult.reason;
    if (snapshotLeaseResult.status !== 'fulfilled')
      throw snapshotLeaseResult.reason;

    const previousStream = this.presentation.activeStream;
    const previousTranscriptLease = this.transcriptPresentationLease;
    this.transcriptPresentationLease = transcriptLeaseResult.value;
    this.presentation.select(stream);
    if (options.notifyActivation) this.renderer.onActiveStreamChanged(stream);
    this.renderer.syncStreamContent(stream, { includeActiveState: true });
    if (previousStream && previousStream !== stream) {
      this.renderer.releaseStreamContent(previousStream);
    }
    if (previousTranscriptLease !== transcriptLeaseResult.value)
      previousTranscriptLease?.close();
    return true;
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

  /**
   * Cancel every still-running stream because the app itself is going away.
   * App-lifecycle only (extension deactivating); not a session fact.
   */
  markAllRunningTasksAsCancelled(): void {
    for (const [stream, status] of this.state.streamStatus.entries()) {
      if (status === STREAM_PHASE.RUNNING) {
        this.state.streamStatus.transition(
          stream,
          STREAM_PHASE.CANCELLED,
          'restart-repair',
        );
      }
    }
  }

  /** Awaitable status application for tests and hosts that cannot fire-and-forget. */
  applyStreamStatus(
    ...args: Parameters<SessionFactApplier['setStreamStatus']>
  ): ReturnType<SessionFactApplier['setStreamStatus']> {
    return this.factApplier.setStreamStatus(...args);
  }

  /** Inject a session fact (tests / rare host seeds). Prefer the hub in production. */
  applySessionFact(
    ...args: Parameters<SessionFactApplier['handleSessionFact']>
  ): boolean {
    const admitted = this.factApplier.handleSessionFact(...args);
    const [fact] = args;
    if (admitted && fact.type === 'setActiveStream') {
      this.handleStreamPresentationRequest(fact.payload);
    }
    return admitted;
  }

  /** Inject a run fact (tests / rare host seeds). Prefer the hub in production. */
  applyRunFact(...args: Parameters<SessionFactApplier['handleRunFact']>): void {
    this.factApplier.handleRunFact(...args);
  }

  async stopStream(stream: StreamTabId): Promise<void> {
    await this.lifecycle.stopStream(stream, {
      clearRetryRequest: true,
    });
  }

  /**
   * Delete a stream's durable state. Resolves to the retention outcome so the
   * session-fact applier can keep its removal barrier provisional until the
   * deletion commits: `active`/`failed` mean the stream still lives.
   */
  async deleteStream(
    stream: StreamTabId,
  ): Promise<DeleteStreamResult | undefined> {
    const wasActive = this.presentation.activeStream === stream;
    const activationGeneration = this.activationGeneration;
    const storageGeneration = this.storageGeneration;
    const retained = await this.enqueuePreparedStorageOperation(
      () => this.prepareStreamDeletion(stream),
      (ownershipReadFailed) => {
        if (storageGeneration !== this.storageGeneration) {
          return Promise.resolve(undefined);
        }
        if (ownershipReadFailed) {
          return Promise.resolve('failed' as const);
        }
        return this.deleteStreamNow(stream, wasActive, activationGeneration);
      },
    );
    if (retained) {
      // Best-effort presentation repair: a rebuild/notification failure must
      // not make the deletion outcome disappear, or the session-fact applier
      // would keep its provisional tombstone on a stream the store retained.
      try {
        await this.lifecycle.rebuildRenderedStreams({ syncActiveStream: true });
        await this.lifecycle.notifyDeletionRetained(
          retained === 'active' ? 1 : 0,
          retained === 'failed' ? 1 : 0,
        );
      } catch (error) {
        log.debug('Failed to rebuild/notify after a retained stream deletion', {
          data: { stream, retained, error },
        });
      }
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
   * stream we own locally, then wait for the execution-lease release. The
   * `waitForOwnedExecutionRelease` no-ops for streams with no owned execution,
   * so the all-delete path can run it over every stream without changing
   * behavior.
   */
  private async prepareStreamDeletionCore(
    stream: StreamTabId,
  ): Promise<boolean> {
    const ownedLocally =
      this.session.executions.getAgentHandleByStream(stream) !== undefined;
    if (ownedLocally && isInFlightPhase(this.session.status.get(stream))) {
      await this.lifecycle.stopStream(stream);
    }

    // A terminal child is untracked before its artifact flush releases the
    // execution lease. Auto-close can land in that interval, so the handle is
    // not a reliable indication that local durable writes have finished.
    try {
      await this.state.stores.waitForOwnedExecutionRelease(stream);
      return false;
    } catch (error) {
      log.warn(
        `Stream ${stream} was retained because its execution ownership could not be read`,
        { data: error },
      );
      return true;
    }
  }

  private async prepareStreamDeletion(stream: StreamTabId): Promise<boolean> {
    if (!canUseStreamDataDir(stream)) return false;
    if (!this.hasDeletableStreamData(stream)) return false;
    return this.prepareStreamDeletionCore(stream);
  }

  private async deleteStreamNow(
    stream: StreamTabId,
    wasActive: boolean,
    activationGenerationAtStart: number,
  ): Promise<'active' | 'failed' | undefined> {
    if (!canUseStreamDataDir(stream)) return undefined;

    const hadDeletableData = this.hasDeletableStreamData(stream);
    const deletion = await this.state.clearStream(stream);
    if (deletion !== 'deleted') {
      return deletion;
    }
    if (!hadDeletableData) return undefined;

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
    const newerIntentControlsSelection =
      newerActivationPending &&
      (this.latestActivationTarget === '' ||
        (this.latestActivationTarget !== stream &&
          this.state.streamLogs.has(this.latestActivationTarget)));
    // A concurrent switch to a surviving stream still needs reassertion after
    // DELETE_STREAM. A concurrent explicit deselection is presentation intent
    // and must remain empty rather than being replaced by a fallback.
    const shouldActivateStream =
      (selectionWasDeleted && !newerIntentControlsSelection) ||
      (wasActive && hasVisibleActive && !newerIntentControlsSelection);

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
    return undefined;
  }

  async deleteAllStreams(): Promise<void> {
    const activationGeneration = this.activationGeneration;
    const storageGeneration = this.storageGeneration;
    const outcome = await this.enqueuePreparedStorageOperation(
      () => this.prepareAllStreamDeletions(),
      (_prepared) =>
        storageGeneration === this.storageGeneration
          ? this.deleteAllStreamsNow()
          : Promise.resolve(undefined),
    );
    if (!outcome) return;
    const newerIntentControlsSelection =
      activationGeneration !== this.activationGeneration &&
      (this.latestActivationTarget === '' ||
        this.state.streamLogs.has(this.latestActivationTarget));
    await this.lifecycle.rebuildRenderedStreams({
      syncActiveStream: !outcome.allDeleted && !newerIntentControlsSelection,
    });
    if (!outcome.allDeleted) {
      await this.lifecycle.notifyDeletionRetained(
        outcome.activeCount,
        outcome.failedCount,
      );
    }
  }

  private async prepareAllStreamDeletions(): Promise<void> {
    // Runs the per-stream prepare over every known stream — deliberately
    // without the single-delete guards, so in-flight reserved-segment streams
    // are still stopped before clearAll() exactly as before the shared core.
    // Ownership-read failures are already converted to a per-stream result by
    // `prepareStreamDeletionCore`; `clearAll` reports those streams through
    // its own failed set.
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
      await this.loadPresentationState();
    });
  }

  /** Replace session stores and presentation caches after a workspace move. */
  reloadAfterStorageRootChange(
    transitionHooks?: WorkspaceStorageTransitionHooks,
  ): Promise<void> {
    const reload = async () => {
      let sessionReloadError: unknown;
      let storageRootReplaced = false;
      try {
        storageRootReplaced = transitionHooks
          ? await this.session.reloadAfterStorageRootChange(transitionHooks)
          : await this.session.reloadAfterStorageRootChange();
      } catch (error) {
        sessionReloadError = error;
      }
      if (sessionReloadError || storageRootReplaced) {
        this.storageGeneration += 1;
        this.presentationReloadPending = true;
      }
      if (!this.presentationReloadPending) return;
      this.state.resetAfterStorageRootChange();
      this.presentation.reload();
      this.releasePresentationLeases();
      this.webviewBridge.clearAll();
      try {
        await this.loadPresentationState();
        this.presentationReloadPending = false;
      } catch (presentationReloadError) {
        if (sessionReloadError) {
          throw new AggregateError(
            [sessionReloadError, presentationReloadError],
            'Failed to replace session storage and reload its presentation',
          );
        }
        throw presentationReloadError;
      }
      if (sessionReloadError) throw sessionReloadError;
    };
    return this.enqueueStorageOperation(reload);
  }

  private loadPresentationState(): Promise<void> {
    return this.state.load(this.stateOwnership);
  }

  /**
   * Serialize operations whose filesystem work must observe one workspace
   * root from beginning to end.
   */
  private enqueueStorageOperation<T>(work: () => Promise<T>): Promise<T> {
    // `add` widens to `T | void` for abort/timeout options; neither is used,
    // so every enqueued operation runs and resolves with its result.
    return this.storageOperationQueue.add(work) as Promise<T>;
  }

  /**
   * Reserve queue order before stopping executions, but perform that
   * preparation outside the queue. An earlier root replacement may be waiting
   * for the same execution leases and must be able to observe their release.
   */
  private enqueuePreparedStorageOperation<T, P>(
    prepare: () => Promise<P>,
    work: (prepared: P) => Promise<T>,
  ): Promise<T> {
    let prepared!: P;
    let publishPreparation!: (value: PromiseLike<void>) => void;
    const preparation = new Promise<void>((resolve) => {
      publishPreparation = resolve;
    });
    const operation = this.enqueueStorageOperation(async () => {
      await preparation;
      return work(prepared);
    });
    const pendingPreparation = Promise.resolve().then(async () => {
      prepared = await prepare();
    });
    // If an earlier queue entry is still running, attach a rejection handler
    // until this operation reaches the same promise.
    void preparation.catch(() => undefined);
    publishPreparation(pendingPreparation);
    return operation;
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
          const admitted = this.factApplier.handleSessionFact(
            sessionEvent.event,
          );
          // A refused attachment (removed stream) must not activate or lease.
          if (admitted && sessionEvent.event.type === 'setActiveStream') {
            this.handleStreamPresentationRequest(sessionEvent.event.payload);
          }
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
    this.factApplier.dispose();
    this.activationGeneration += 1;
    this.releasePresentationLeases();
    this.webviewBridge.dispose();
  }
}
