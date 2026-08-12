import PQueue from 'p-queue';

import { RUN_FACT_EVENT_TYPES } from '@agent/trace';
import type { SessionStores } from '@agent/storage';
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
import { WebviewUpdater } from '@controllers/progressView/backend/WebviewUpdater';
import { LitSessionRenderer } from '@controllers/progressView/backend/LitSessionRenderer';
import type { GetProgressStreamControls } from '@controllers/progressView/progressStreamControls';
import {
  SessionFactApplier,
  type SessionRunFactEvent,
} from '@controllers/session/SessionFactApplier';
import { SessionState } from '@controllers/session/SessionState';
import {
  buildApprovalRequestHandlerSet,
  createProgressBackendUiConfig,
  type ApprovalRequestHandlerSet,
  type BuildApprovalRequestHandlerSetParams,
} from '@controllers/progressView/backend/progressBackendUiConfig';
import * as logger from '@logger/logUtils';
import type { StateStore } from '@platform/interfaces';
import type { ProgressViewOutboundMessage, StreamTabId } from '@shared/schemas';
import { STREAM_PHASE } from '@shared/schemas';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { isInFlightPhase } from '@shared/streams/streamStatus';
import { canUseStreamDataDir } from '@transcript/streamDataPaths';

const CHANNEL = 'ProgressBackend';

type ProgressBackendApprovalOptions = Omit<
  BuildApprovalRequestHandlerSetParams,
  'webviewUpdater'
>;

interface ProgressBackendLifecycleOptions {
  stopStream(
    stream: StreamTabId,
    options?: { clearRetryRequest?: boolean },
  ): Promise<void> | void;
  cleanupDeletedStream(stream: StreamTabId): void;
  cleanupDeletedStreams(options: { allDeleted: boolean }): void;
  rebuildRenderedStreams(options: { syncActiveStream: boolean }): void;
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
   * to {@link WebviewUpdater} so the frontend's capability gating stays a
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
  readonly webviewUpdater: WebviewUpdater;
  readonly webviewBridge: WebviewBridge;
  readonly approvalHandlers: ApprovalRequestHandlerSet;
  readonly setApprovalBypassState: (
    update: HostApprovalBypassStateUpdate,
  ) => void;
  private readonly factApplier: SessionFactApplier;
  private readonly litRenderer: LitSessionRenderer;
  private readonly session: SessionHandle;
  private readonly lifecycle: ProgressBackendLifecycleOptions;
  private readonly postMessage: (message: ProgressViewOutboundMessage) => void;
  private readonly stateOwnership: 'backend' | 'session';
  private readonly storageOperationQueue = new PQueue({ concurrency: 1 });
  private readonly detachEventListeners: Array<() => void> = [];
  private storageGeneration = 0;
  private presentationReloadPending = false;
  private disposed = false;

  constructor(options: ProgressBackendOptions) {
    this.session = options.session ?? defaultSession();
    this.stateOwnership = options.stateOwnership ?? 'backend';
    this.lifecycle = options.lifecycle;
    this.postMessage = (message) => {
      if (!options.hasTarget()) return;
      // View refreshes are best-effort; a closed transport must not take down
      // the backend. The async wrapper funnels sync throws and rejections into
      // one reporting path, logged at debug like `WebviewBridge.deliver` — the
      // next full refresh re-sends whatever this frame carried.
      void (async () => options.sendMessage(message))().catch(
        (error: unknown) => {
          logger.debug(CHANNEL, 'Failed to deliver message to webview', {
            data: { command: message.command, error },
          });
        },
      );
    };
    this.state = new SessionState(
      options.storage,
      this.session,
      options.stores,
    );
    this.webviewUpdater = new WebviewUpdater(
      this.postMessage,
      options.hasTarget,
      options.getUnsupportedCommands,
    );
    this.webviewBridge = new WebviewBridge(
      this.state.streamLogs,
      options.sendMessage,
      () => this.state.activeStream || null,
    );

    this.approvalHandlers = buildApprovalRequestHandlerSet({
      ...options.approvals,
      webviewUpdater: this.webviewUpdater,
    });
    const ui = createProgressBackendUiConfig({
      handlers: this.approvalHandlers,
      webviewUpdater: this.webviewUpdater,
      canSend: options.approvals.canSend,
    });
    this.litRenderer = new LitSessionRenderer(
      this.state,
      this.webviewUpdater,
      this.webviewBridge,
      options.getStreamControls,
    );
    this.factApplier = new SessionFactApplier(this.state, this.litRenderer, {
      hasPendingPermissions: ui.hasPendingPermissions,
      deleteStream: (stream) => this.deleteStream(stream),
    });
    this.setApprovalBypassState = ui.setApprovalBypassState;
  }

  /** Full active-viewport rebuild for the Lit progress surface. */
  syncStreamContent(
    stream: Parameters<LitSessionRenderer['syncStreamContent']>[0],
    options?: Parameters<LitSessionRenderer['syncStreamContent']>[1],
  ): void {
    this.litRenderer.syncStreamContent(stream, options);
  }

  /** Rebuild stream tabs and, when requested, rehydrate the active viewport. */
  async syncRenderedStreams(options: {
    syncActiveStream: boolean;
    theme?: 'dark' | 'light';
  }): Promise<void> {
    const activeStream = this.webviewUpdater.sendStreamMetadata(
      this.state,
      this.state.streamStatus.getAllStreamStates(),
      options.theme,
    );
    if (!options.syncActiveStream) return;

    const hasStreams = this.state.streamLogs.keys().length > 0;
    if (!activeStream && hasStreams) return;
    await this.syncActiveStream(activeStream, false, false);
  }

  /** Select and render one existing stream without rebuilding the tab list. */
  async activateStream(stream: StreamTabId): Promise<boolean> {
    if (!this.state.streamLogs.has(stream)) return false;
    this.state.switchActiveStream(stream);
    await this.syncActiveStream(stream, true, true);
    return true;
  }

  private async syncActiveStream(
    stream: StreamTabId | '',
    includeActiveState: boolean,
    notifyActivation: boolean,
  ): Promise<void> {
    if (!this.litRenderer.isAvailable()) return;
    if (stream) await this.state.streamLogs.ensureLoaded(stream);
    if (this.state.activeStream !== stream) return;
    if (notifyActivation) this.litRenderer.onActiveStreamChanged(stream);
    this.litRenderer.syncStreamContent(stream, { includeActiveState });
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
  ): void {
    this.factApplier.handleSessionFact(...args);
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

  async deleteStream(stream: StreamTabId): Promise<void> {
    const wasActive = this.state.activeStream === stream;
    const storageGeneration = this.storageGeneration;
    const retained = await this.enqueuePreparedStorageOperation(
      () => this.prepareStreamDeletion(stream),
      () =>
        storageGeneration === this.storageGeneration
          ? this.deleteStreamNow(stream, wasActive)
          : Promise.resolve(undefined),
    );
    if (retained) {
      await this.lifecycle.notifyDeletionRetained(
        retained === 'active' ? 1 : 0,
        retained === 'failed' ? 1 : 0,
      );
    }
  }

  /** Whether local durable state exists for `stream` (log or task snapshot). */
  private hasDeletableStreamData(stream: StreamTabId): boolean {
    return (
      this.state.streamLogs.has(stream) ||
      Boolean(this.state.snapshots.getRunMetadata(stream).config)
    );
  }

  /**
   * Per-stream prepare shared by single- and all-delete: stop an in-flight
   * stream we own locally, then wait for the execution-lease release. The
   * `waitForOwnedExecutionRelease` no-ops for streams with no owned execution,
   * so the all-delete path can run it over every stream without changing
   * behavior.
   */
  private async prepareStreamDeletionCore(stream: StreamTabId): Promise<void> {
    const ownedLocally =
      this.session.executions.getAgentHandleByStream(stream) !== undefined;
    if (ownedLocally && isInFlightPhase(this.session.status.get(stream))) {
      await this.lifecycle.stopStream(stream);
    }

    // A terminal child is untracked before its artifact flush releases the
    // execution lease. Auto-close can land in that interval, so the handle is
    // not a reliable indication that local durable writes have finished.
    await this.state.stores.waitForOwnedExecutionRelease(stream);
  }

  private async prepareStreamDeletion(stream: StreamTabId): Promise<void> {
    if (!canUseStreamDataDir(stream)) return;
    if (!this.hasDeletableStreamData(stream)) return;
    await this.prepareStreamDeletionCore(stream);
  }

  private async deleteStreamNow(
    stream: StreamTabId,
    wasActive: boolean,
  ): Promise<'active' | 'failed' | undefined> {
    if (!canUseStreamDataDir(stream)) return undefined;

    const hadDeletableData = this.hasDeletableStreamData(stream);
    const deletion = await this.state.clearStream(stream);
    if (deletion !== 'deleted') {
      if (hadDeletableData) {
        this.lifecycle.rebuildRenderedStreams({ syncActiveStream: true });
      }
      return deletion;
    }
    if (!hadDeletableData) return undefined;

    this.lifecycle.cleanupDeletedStream(stream);
    this.webviewBridge.clearStream(stream);

    let shouldActivateStream = false;
    let notifyActivation = true;
    const activeAfterClear = this.state.activeStream;
    const remainingStreams = this.state.selectableStreamNames();
    const hasVisibleActive =
      activeAfterClear !== '' && remainingStreams.includes(activeAfterClear);
    if (activeAfterClear === stream || (wasActive && !hasVisibleActive)) {
      shouldActivateStream =
        this.state.rotateActiveStream(remainingStreams) !== '';
    } else if (wasActive && hasVisibleActive) {
      shouldActivateStream = true;
      // A newer activation won while deletion awaited storage. Its fact
      // already focused the renderer; only refresh its content here.
      notifyActivation = false;
    }

    this.postMessage({
      command: PROGRESS_VIEW_COMMANDS.DELETE_STREAM,
      stream,
    });

    const nextActive = this.state.activeStream;
    if (shouldActivateStream && nextActive) {
      if (notifyActivation) {
        await this.activateStream(nextActive);
      } else {
        await this.syncActiveStream(nextActive, true, false);
      }
    } else {
      // The deleted stream was not the active one, so only the stream list
      // changed; the active stream's content is still on screen and correct.
      this.lifecycle.rebuildRenderedStreams({ syncActiveStream: false });
    }
    return undefined;
  }

  async deleteAllStreams(): Promise<void> {
    const storageGeneration = this.storageGeneration;
    const retained = await this.enqueuePreparedStorageOperation(
      () => this.prepareAllStreamDeletions(),
      () =>
        storageGeneration === this.storageGeneration
          ? this.deleteAllStreamsNow()
          : Promise.resolve(undefined),
    );
    if (retained) {
      await this.lifecycle.notifyDeletionRetained(
        retained.activeCount,
        retained.failedCount,
      );
    }
  }

  private async prepareAllStreamDeletions(): Promise<void> {
    // Runs the per-stream prepare over every known stream — deliberately
    // without the single-delete guards, so in-flight reserved-segment streams
    // are still stopped before clearAll() exactly as before the shared core.
    await Promise.all(
      this.state.streamLogs
        .keys()
        .map((stream) => this.prepareStreamDeletionCore(stream)),
    );
  }

  private async deleteAllStreamsNow(): Promise<
    { activeCount: number; failedCount: number } | undefined
  > {
    const streamIds = this.state.streamLogs.keys();
    const retained = await this.state.clearAll();
    const retainedStreams = new Set([...retained.active, ...retained.failed]);
    const deleted = streamIds.filter((stream) => !retainedStreams.has(stream));
    for (const stream of deleted) {
      this.lifecycle.cleanupDeletedStream(stream);
      this.webviewBridge.clearStream(stream);
    }
    const allDeleted = retainedStreams.size === 0;
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
    this.lifecycle.rebuildRenderedStreams({ syncActiveStream: !allDeleted });
    return allDeleted
      ? undefined
      : {
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
  private enqueuePreparedStorageOperation<T>(
    prepare: () => Promise<void>,
    work: () => Promise<T>,
  ): Promise<T> {
    let publishPreparation!: (value: PromiseLike<void>) => void;
    const preparation = new Promise<void>((resolve) => {
      publishPreparation = resolve;
    });
    const operation = this.enqueueStorageOperation(async () => {
      await preparation;
      return work();
    });
    const pendingPreparation = Promise.resolve().then(prepare);
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
          this.factApplier.handleSessionFact(sessionEvent.event);
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
    this.webviewBridge.dispose();
  }
}
