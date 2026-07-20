import { RUN_FACT_EVENT_TYPES } from '@agent/trace';
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
import {
  ProgressInteractionHandler,
  type ProgressBackendInteractionEvent,
  type ProgressBackendInteractionPayloads,
} from '@controllers/progressView/backend/events/ProgressInteractionHandler';
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
import type { StreamSnapshotStore } from '@transcript';
import { canUseStreamDataDir } from '@transcript/streamDataPaths';
import type { SessionStores } from './state/SessionStores';

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
  rebuildRenderedStreams(options: {
    forceRebuild: boolean;
    syncActiveStream?: boolean;
  }): void;
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
  snapshots?: StreamSnapshotStore;
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
   * `session` when the supplied snapshot store already has its own
   * process-lifetime session-event subscription. The backend then projects
   * facts without applying the same durable mutations a second time.
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
  readonly interactionHandler: ProgressInteractionHandler;
  readonly approvalHandlers: ApprovalRequestHandlerSet;
  private readonly session: SessionHandle;
  private readonly lifecycle: ProgressBackendLifecycleOptions;
  private readonly postMessage: (message: ProgressViewOutboundMessage) => void;
  private readonly onSetActiveStream?: (
    payload: SetActiveStreamPayload,
  ) => void;
  private readonly detachArtifactFlusher: () => void;
  private readonly stateOwnership: 'backend' | 'session';
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
      options.snapshots,
      this.session,
      options.stores,
    );
    this.detachArtifactFlusher =
      this.stateOwnership === 'session'
        ? () => undefined
        : this.session.useArtifactFlusher(() => this.state.snapshots.flush());
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
      this.stateOwnership,
    );
    this.interactionHandler = new ProgressInteractionHandler(ui.callbacks);
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
    if (!canUseStreamDataDir(stream)) return;

    const hasStream =
      this.state.streamLogs.has(stream) ||
      Boolean(this.state.snapshots.getTaskState(stream));
    if (!hasStream) {
      const deletion = await this.state.clearStream(stream);
      if (deletion !== 'deleted') await this.notifyDeletionRetained(deletion);
      return;
    }

    const wasActive = this.state.activeStream === stream;
    const ownedLocally =
      this.session.executions.getAgentHandleByStream(stream) !== undefined;
    if (ownedLocally && isInFlightPhase(this.session.status.get(stream))) {
      await this.lifecycle.stopStream(stream);
    }
    if (ownedLocally) await this.state.waitForOwnedExecutionRelease(stream);

    const deletion = await this.state.clearStream(stream);
    if (deletion !== 'deleted') {
      this.lifecycle.rebuildRenderedStreams({ forceRebuild: true });
      await this.notifyDeletionRetained(deletion);
      return;
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
  }

  async deleteAllStreams(): Promise<void> {
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
    this.lifecycle.rebuildRenderedStreams({
      forceRebuild: true,
      syncActiveStream: !allDeleted,
    });
    if (!allDeleted) {
      await this.lifecycle.notifyDeletionRetained(
        retained.active.size,
        retained.failed.size,
      );
    }
  }

  async load(): Promise<void> {
    await this.state.load(this.stateOwnership);
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

  handleInteractionEvent<K extends ProgressBackendInteractionEvent>(
    event: K,
    payload: ProgressBackendInteractionPayloads[K],
  ): void {
    // A run may still hold the host-channel emit closure that routes here after
    // this backend is disposed (e.g. a desktop window closed while the run keeps
    // executing headless). Applying events to a disposed backend would mutate
    // torn-down state and post messages to a closed window, so the direct
    // applier no-ops once disposed. Before #7363 the bus-listener teardown made
    // this path implicitly safe; the direct call needs an explicit guard.
    if (this.disposed) return;
    this.interactionHandler.handleInteractionEvent(event, payload);
  }

  dispose(): void {
    this.disposed = true;
    this.detachArtifactFlusher();
    this.webviewBridge.dispose();
  }
}
