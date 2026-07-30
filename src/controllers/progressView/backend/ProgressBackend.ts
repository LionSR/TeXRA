import PQueue from 'p-queue';

import { RUN_FACT_EVENT_TYPES } from '@agent/trace';
import type { SessionStores } from '@agent/storage';
import type { HostApprovalBypassStateUpdate } from '@agent/runtime/HostInteractions';
import {
  defaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import {
  WebviewBridge,
  type ProgressViewMessageSender,
} from '@controllers/progressView/backend/WebviewBridge';
import { WebviewUpdater } from '@controllers/progressView/backend/WebviewUpdater';
import {
  ProgressFactApplier,
  type GetProgressStreamControls,
  type ProgressEventSubscription,
} from '@controllers/progressView/backend/events/ProgressFactApplier';
import { ProgressViewState } from '@controllers/progressView/backend/state/ProgressViewState';
import { buildStreamInfos } from '@controllers/progressView/backend/streamInfoUtils';
import {
  buildApprovalRequestHandlerSet,
  createProgressBackendUiConfig,
  type ApprovalRequestHandlerSet,
  type BuildApprovalRequestHandlerSetParams,
} from '@controllers/progressView/backend/progressBackendUiConfig';
import type { StateStore } from '@platform/interfaces';
import type {
  ProgressViewOutboundMessage,
  SetActiveStreamPayload,
  StreamTabId,
} from '@shared/schemas';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { isInFlightPhase } from '@shared/streams/streamStatus';
import { canUseStreamDataDir } from '@transcript/streamDataPaths';
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
  /** Desktop refreshes metadata after deleting an inactive stream. */
  refreshRenderedStreamsAfterDeletion?(): void;
  activateStream(stream: StreamTabId): Promise<void> | void;
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
  onSetActiveStream?: (payload: SetActiveStreamPayload) => void;
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
  readonly state: ProgressViewState;
  readonly webviewUpdater: WebviewUpdater;
  readonly webviewBridge: WebviewBridge;
  readonly factApplier: ProgressFactApplier;
  readonly approvalHandlers: ApprovalRequestHandlerSet;
  readonly setApprovalBypassState: (
    update: HostApprovalBypassStateUpdate,
  ) => void;
  private readonly session: SessionHandle;
  private readonly lifecycle: ProgressBackendLifecycleOptions;
  private readonly postMessage: (message: ProgressViewOutboundMessage) => void;
  private readonly onSetActiveStream?: (
    payload: SetActiveStreamPayload,
  ) => void;
  private readonly stateOwnership: 'backend' | 'session';
  private readonly storageOperationQueue = new PQueue({ concurrency: 1 });
  private storageGeneration = 0;
  private presentationReloadPending = false;
  private disposed = false;

  constructor(options: ProgressBackendOptions) {
    this.session = options.session ?? defaultSession();
    this.stateOwnership = options.stateOwnership ?? 'backend';
    this.lifecycle = options.lifecycle;
    this.postMessage = (message) => {
      if (!options.hasTarget()) return;
      // View refreshes are best-effort; a closed transport must not take
      // down the backend. The async wrapper funnels sync throws and
      // rejections into one swallowed path.
      void (async () => options.sendMessage(message))().catch(() => undefined);
    };
    this.state = new ProgressViewState(
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
    this.factApplier = new ProgressFactApplier(
      this.state,
      this.webviewUpdater,
      this.webviewBridge,
      ui.hasPendingPermissions,
      (stream) => this.deleteStream(stream),
      options.getStreamControls,
    );
    this.setApprovalBypassState = ui.setApprovalBypassState;
    this.onSetActiveStream = options.onSetActiveStream;
  }

  async stopStream(stream: StreamTabId): Promise<void> {
    await this.lifecycle.stopStream(stream, {
      clearRetryRequest: true,
    });
  }

  private async notifyDeletionRetained(
    deletion: 'active' | 'failed',
  ): Promise<void> {
    await this.lifecycle.notifyDeletionRetained(
      deletion === 'active' ? 1 : 0,
      deletion === 'failed' ? 1 : 0,
    );
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
    if (retained) await this.notifyDeletionRetained(retained);
  }

  /** Whether local durable state exists for `stream` (log or task snapshot). */
  private hasDeletableStreamData(stream: StreamTabId): boolean {
    return (
      this.state.streamLogs.has(stream) ||
      Boolean(this.state.snapshots.getTaskState(stream))
    );
  }

  private async prepareStreamDeletion(stream: StreamTabId): Promise<void> {
    if (!canUseStreamDataDir(stream)) return;
    if (!this.hasDeletableStreamData(stream)) return;

    const ownedLocally =
      this.session.executions.getAgentHandleByStream(stream) !== undefined;
    if (ownedLocally && isInFlightPhase(this.session.status.get(stream))) {
      await this.lifecycle.stopStream(stream);
    }

    // A terminal child is untracked before its artifact flush releases the
    // execution lease. Auto-close can land in that interval, so the handle is
    // not a reliable indication that local durable writes have finished.
    await this.state.waitForOwnedExecutionRelease(stream);
  }

  private async deleteStreamNow(
    stream: StreamTabId,
    wasActive: boolean,
  ): Promise<'active' | 'failed' | undefined> {
    if (!canUseStreamDataDir(stream)) return undefined;

    if (!this.hasDeletableStreamData(stream)) {
      const deletion = await this.state.clearStream(stream);
      return deletion === 'deleted' ? undefined : deletion;
    }

    const deletion = await this.state.clearStream(stream);
    if (deletion !== 'deleted') {
      this.lifecycle.rebuildRenderedStreams({ syncActiveStream: true });
      return deletion;
    }

    this.lifecycle.cleanupDeletedStream(stream);
    this.webviewBridge.clearStream(stream);

    let shouldActivateStream = false;
    const activeAfterClear = this.state.activeStream;
    const visibleStreams = buildStreamInfos(
      this.state,
      this.state.agentCategoryFilter,
    ).map((info) => info.name);
    const hasVisibleActive =
      activeAfterClear !== '' && visibleStreams.includes(activeAfterClear);
    if (activeAfterClear === stream || (wasActive && !hasVisibleActive)) {
      const nextActive =
        visibleStreams.length === 0
          ? ''
          : this.state.pickValidActiveStream(visibleStreams);
      if (activeAfterClear && activeAfterClear !== nextActive) {
        this.state.releasePreviousActive(activeAfterClear);
      }
      this.state.activeStream = nextActive;
      shouldActivateStream = nextActive !== '';
    } else if (wasActive && hasVisibleActive) {
      shouldActivateStream = true;
    }

    this.postMessage({
      command: PROGRESS_VIEW_COMMANDS.DELETE_STREAM,
      stream,
    });

    const nextActive = this.state.activeStream;
    if (shouldActivateStream && nextActive) {
      await this.lifecycle.activateStream(nextActive);
    } else {
      this.lifecycle.refreshRenderedStreamsAfterDeletion?.();
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
    const streamIds = this.state.streamLogs.keys();
    const locallyOwnedStreams = streamIds.filter(
      (stream) =>
        this.session.executions.getAgentHandleByStream(stream) !== undefined,
    );
    await Promise.all(
      locallyOwnedStreams.map(async (stream) => {
        if (isInFlightPhase(this.session.status.get(stream))) {
          await this.lifecycle.stopStream(stream);
        }
      }),
    );
    await Promise.all(
      locallyOwnedStreams.map((stream) =>
        this.state.waitForOwnedExecutionRelease(stream),
      ),
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
  reloadAfterStorageRootChange(): Promise<void> {
    const reload = async () => {
      let sessionReloadError: unknown;
      let storageRootReplaced = false;
      try {
        storageRootReplaced = await this.session.reloadAfterStorageRootChange();
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

  private async loadPresentationState(): Promise<void> {
    await this.state.load(this.stateOwnership);
    // The category control no longer exists, so legacy preferences must not
    // constrain active-stream selection or hide sessions.
    this.state.agentCategoryFilter = 'all';
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

  setupEventListeners(): ProgressEventSubscription {
    const factApplierSubscription = this.factApplier.createLocalSubscription();
    const detachSessionFacts = this.session.events.subscribe(
      (sessionEvent) => {
        if (this.disposed) return;
        if (sessionEvent.scope !== 'session') return;
        this.factApplier.handleSessionFact(sessionEvent.event);
        if (sessionEvent.event.type === 'setActiveStream') {
          this.onSetActiveStream?.(sessionEvent.event.payload);
        }
      },
      { scope: 'session' },
    );
    const detachRunFacts = this.session.events.subscribe(
      (sessionEvent) => {
        if (this.disposed) return;
        if (sessionEvent.scope !== 'run') return;
        this.factApplier.handleRunFact(
          sessionEvent.streamId,
          sessionEvent.event,
        );
      },
      { scope: 'run', types: RUN_FACT_EVENT_TYPES },
    );
    return {
      dispose: () => {
        detachRunFacts();
        detachSessionFacts();
        factApplierSubscription.dispose();
      },
    };
  }

  dispose(): void {
    this.disposed = true;
    this.webviewBridge.dispose();
  }
}
