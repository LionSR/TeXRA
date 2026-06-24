// Local imports - shared progress backend
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { ProgressEventBusLike } from '@eventBus/ProgressEventBus';
import type { ProgressViewOutboundMessage } from '@shared/schemas';
import {
  WebviewBridge,
  type ProgressViewMessageSender,
} from '@shared/progressView/backend/WebviewBridge';
import { WebviewUpdater } from '@shared/progressView/backend/WebviewUpdater';
import {
  ProgressEventHandler,
  type GetProgressStreamControls,
  type ProgressEventSubscription,
  type UICallbacks,
} from '@shared/progressView/backend/events/ProgressEventHandler';
import type { MementoStorage } from '@shared/progressView/backend/persistence/PersistentMapManager';
import { ProgressViewState } from '@shared/progressView/backend/state/ProgressViewState';
import type { StreamSnapshotStore } from '@transcript';

export type ProgressBackendMessageSender = ProgressViewMessageSender;

export interface ProgressBackendServices {
  state: ProgressViewState;
  webviewUpdater: WebviewUpdater;
  webviewBridge: WebviewBridge;
}

export interface ProgressBackendUiConfig {
  callbacks: UICallbacks;
  hasPendingPermissions(streamId: string): boolean;
}

export interface ProgressBackendOptions {
  storage: MementoStorage;
  snapshots?: StreamSnapshotStore;
  sendMessage: ProgressBackendMessageSender;
  hasTarget(): boolean;
  configureUi(services: ProgressBackendServices): ProgressBackendUiConfig;
  getStreamControls?: GetProgressStreamControls;
  /** Session that owns this backend's coordination state (defaults to the process session). */
  session?: SessionHandle;
}

function sendUpdaterMessage(
  sendMessage: ProgressBackendMessageSender,
  message: ProgressViewOutboundMessage,
): void {
  // View refreshes are best-effort; a closed transport must not take down the
  // backend. The async wrapper funnels sync throws and rejections into one
  // swallowed path.
  void (async () => sendMessage(message))().catch(() => undefined);
}

/**
 * Host-neutral progress-view backend composition.
 *
 * Hosts provide only storage, transport, and UI callbacks. The state manager,
 * message builders, log bridge, and event bus subscriber are constructed as one
 * graph so extension and desktop can converge on the same backend boundary.
 */
export class ProgressBackend {
  readonly state: ProgressViewState;
  readonly webviewUpdater: WebviewUpdater;
  readonly webviewBridge: WebviewBridge;
  readonly eventHandler: ProgressEventHandler;

  constructor(options: ProgressBackendOptions) {
    this.state = new ProgressViewState(
      options.storage,
      options.snapshots,
      options.session,
    );
    this.webviewUpdater = new WebviewUpdater((message) => {
      sendUpdaterMessage(options.sendMessage, message);
    }, options.hasTarget);
    this.webviewBridge = new WebviewBridge(
      this.state.streamLogs,
      options.sendMessage,
      () => this.state.activeStream || null,
    );

    const services = {
      state: this.state,
      webviewUpdater: this.webviewUpdater,
      webviewBridge: this.webviewBridge,
    };
    const ui = options.configureUi(services);
    this.eventHandler = new ProgressEventHandler(
      this.state,
      this.webviewUpdater,
      this.webviewBridge,
      ui.callbacks,
      ui.hasPendingPermissions,
      options.getStreamControls,
    );
  }

  async load(): Promise<void> {
    await this.state.load();
  }

  setupEventListeners(bus: ProgressEventBusLike): ProgressEventSubscription {
    return this.eventHandler.setupEventListeners(bus);
  }

  dispose(): void {
    this.webviewBridge.dispose();
  }
}
