import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { attachLegacyProgressEventProjection } from '@agent/runtime/LegacyProgressEventProjection';
import {
  defaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import type {
  ProgressEvent,
  ProgressEventBusLike,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';
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
}

class LocalProgressEventBus implements ProgressEventBusLike {
  private readonly listeners = new Map<
    ProgressEvent,
    Set<(payload: ProgressEventPayloads[ProgressEvent]) => void>
  >();

  on<K extends ProgressEvent>(
    event: K,
    listener: (payload: ProgressEventPayloads[K]) => void,
    options?: { signal?: AbortSignal },
  ): () => void {
    if (options?.signal?.aborted) return () => {};
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(
      listener as (payload: ProgressEventPayloads[ProgressEvent]) => void,
    );
    const cleanup = (): void => {
      listeners?.delete(
        listener as (payload: ProgressEventPayloads[ProgressEvent]) => void,
      );
    };
    options?.signal?.addEventListener('abort', cleanup, { once: true });
    return cleanup;
  }

  emit<K extends ProgressEvent>(
    event: K,
    payload: ProgressEventPayloads[K],
  ): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload);
    }
  }
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
  private readonly session: SessionHandle;
  private readonly localEvents = new LocalProgressEventBus();

  constructor(options: ProgressBackendOptions) {
    this.session = options.session ?? defaultSession();
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

  setupEventListeners(
    bus: ProgressEventBusLike,
    sessionProjectionTarget: AgentRuntimeHost = bus,
  ): ProgressEventSubscription {
    const busSubscription = this.eventHandler.setupEventListeners(bus);
    const localSubscription = this.eventHandler.setupEventListeners(
      this.localEvents,
    );
    const detachProjection = attachLegacyProgressEventProjection(
      this.session.events,
      sessionProjectionTarget,
    );
    return {
      dispose: () => {
        detachProjection();
        localSubscription.dispose();
        busSubscription.dispose();
      },
    };
  }

  handleProgressEvent<K extends ProgressEvent>(
    event: K,
    payload: ProgressEventPayloads[K],
  ): void {
    this.localEvents.emit(event, payload);
  }

  dispose(): void {
    this.webviewBridge.dispose();
  }
}
