import {
  defaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import {
  type ProjectedProgressEvent,
  projectSessionFactToProgressEvent,
  subscribeRunFactsAsProgressEvents,
} from '@agent/runtime/sessionProgressEventProjection';
import type {
  ProgressEvent,
  ProgressEventPayloads,
} from '@agent/runtime/hostProgressEvents';
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
  sendMessage: ProgressViewMessageSender;
  hasTarget(): boolean;
  configureUi(services: ProgressBackendServices): ProgressBackendUiConfig;
  getStreamControls?: GetProgressStreamControls;
  /** Session that owns this backend's coordination state (defaults to the process session). */
  session?: SessionHandle;
  /**
   * Commands this host's progressView inbound registry declares
   * `unsupported(...)` — pass `() => unsupportedCommands(registry)`. Threaded
   * to {@link WebviewUpdater} so the frontend's capability gating stays a
   * projection of the registry.
   */
  getUnsupportedCommands?: () => readonly string[];
  /** Host-local side effects for session-originated progress events. */
  onSessionProgressEvent?<K extends ProgressEvent>(
    event: K,
    payload: ProgressEventPayloads[K],
  ): void;
}

type SessionProgressEventObserver = <K extends ProgressEvent>(
  event: K,
  payload: ProgressEventPayloads[K],
) => void;

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
  readonly eventHandler: ProgressEventHandler;
  private readonly session: SessionHandle;
  private readonly onSessionProgressEvent?: SessionProgressEventObserver;
  private disposed = false;

  constructor(options: ProgressBackendOptions) {
    this.session = options.session ?? defaultSession();
    this.onSessionProgressEvent = options.onSessionProgressEvent;
    this.state = new ProgressViewState(
      options.storage,
      options.snapshots,
      this.session,
    );
    this.webviewUpdater = new WebviewUpdater(
      (message) => {
        // View refreshes are best-effort; a closed transport must not take
        // down the backend. The async wrapper funnels sync throws and
        // rejections into one swallowed path.
        void (async () => options.sendMessage(message))().catch(
          () => undefined,
        );
      },
      options.hasTarget,
      options.getUnsupportedCommands,
    );
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

  setupEventListeners(): ProgressEventSubscription {
    const eventHandlerSubscription =
      this.eventHandler.createLocalSubscription();
    const detachSessionFacts = this.session.events.subscribe(
      (sessionEvent) => {
        if (sessionEvent.scope !== 'session') return;
        const projected = projectSessionFactToProgressEvent(sessionEvent.event);
        if (projected) this.handleProjectedProgressEvent(projected);
      },
      { scope: 'session' },
    );
    const detachRunFacts = subscribeRunFactsAsProgressEvents(
      this.session.events,
      (projected) => this.handleProjectedProgressEvent(projected),
    );
    return {
      dispose: () => {
        detachRunFacts();
        detachSessionFacts();
        eventHandlerSubscription.dispose();
      },
    };
  }

  private handleProjectedProgressEvent(
    projected: ProjectedProgressEvent,
  ): void {
    this.handleProgressEvent(projected.event, projected.payload);
    this.onSessionProgressEvent?.(projected.event, projected.payload);
  }

  handleProgressEvent<K extends ProgressEvent>(
    event: K,
    payload: ProgressEventPayloads[K],
  ): void {
    // A run may still hold the host-channel emit closure that routes here after
    // this backend is disposed (e.g. a desktop window closed while the run keeps
    // executing headless). Applying events to a disposed backend would mutate
    // torn-down state and post messages to a closed window, so the direct
    // applier no-ops once disposed. Before #7363 the bus-listener teardown made
    // this path implicitly safe; the direct call needs an explicit guard.
    if (this.disposed) return;
    this.eventHandler.handleProgressEvent(event, payload);
  }

  dispose(): void {
    this.disposed = true;
    this.webviewBridge.dispose();
  }
}
