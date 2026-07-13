// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { describe, expect, it, vi } from 'vitest';

import {
  ProgressBackend,
  type ProgressBackendUiConfig,
} from '@controllers/progressView/backend/ProgressBackend';
import { STREAM_TRANSITION_CAUSE } from '@shared/streams/streamStatus';
import type {
  AppSignal,
  AppSignalPayloads,
  AppSignalsLike,
} from '@eventBus/AppSignals';
import { attachProgressBackendAppSignals } from '@progressView/progressBackendAppSignals';
import {
  STREAM_PHASE,
  type StreamPhase,
  type StreamTabId,
} from '@shared/schemas';
import type { MementoStorage } from '@controllers/progressView/backend/persistence/PersistentMapManager';

class MemoryMementoStorage implements MementoStorage {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.values.has(key) ? (this.values.get(key) as T) : defaultValue;
  }

  async update<T>(key: string, value: T | undefined): Promise<void> {
    if (value === undefined) {
      this.values.delete(key);
      return;
    }
    this.values.set(key, value);
  }
}

class MemoryAppSignals implements AppSignalsLike {
  private readonly listeners = new Map<
    AppSignal,
    Set<(payload: AppSignalPayloads[AppSignal]) => void>
  >();

  on<K extends AppSignal>(
    event: K,
    listener: (payload: AppSignalPayloads[K]) => void,
    options?: { signal?: AbortSignal },
  ): () => void {
    if (options?.signal?.aborted) return () => {};
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(listener as (payload: AppSignalPayloads[AppSignal]) => void);
    const cleanup = (): void => {
      listeners?.delete(
        listener as (payload: AppSignalPayloads[AppSignal]) => void,
      );
    };
    options?.signal?.addEventListener('abort', cleanup, { once: true });
    return cleanup;
  }

  emit<K extends AppSignal>(event: K, payload: AppSignalPayloads[K]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload);
    }
  }
}

function createUiConfig(): ProgressBackendUiConfig {
  return {
    callbacks: {
      showToolEditPermission: vi.fn(),
      resolveToolEditPermission: vi.fn(),
      updateToolEditApprovalBypassState: vi.fn(),
      updateSuperYoloBypassState: vi.fn(),
    },
    hasPendingPermissions: vi.fn(() => false),
  };
}

function createBackend(): ProgressBackend {
  return new ProgressBackend({
    storage: new MemoryMementoStorage(),
    sendMessage: () => true,
    hasTarget: () => true,
    configureUi: () => createUiConfig(),
  });
}

function setStatus(
  backend: ProgressBackend,
  streamId: StreamTabId,
  status: StreamPhase,
): void {
  const becameRunning = backend.state.streamStatus.transition(
    streamId,
    STREAM_PHASE.RUNNING,
    STREAM_TRANSITION_CAUSE.LIFECYCLE,
  );
  if (!becameRunning || status === STREAM_PHASE.RUNNING) return;

  backend.state.streamStatus.transition(
    streamId,
    status,
    STREAM_TRANSITION_CAUSE.LIFECYCLE,
  );
}

describe('attachProgressBackendAppSignals', () => {
  it('marks running progress tasks cancelled on extension deactivation', () => {
    const backend = createBackend();
    const signals = new MemoryAppSignals();
    const backendSubscription = backend.setupEventListeners();
    const appSignalSubscription = attachProgressBackendAppSignals(
      backend,
      signals,
    );
    const running = 'appsignals:running' as StreamTabId;
    const complete = 'appsignals:complete' as StreamTabId;

    try {
      setStatus(backend, running, STREAM_PHASE.RUNNING);
      setStatus(backend, complete, STREAM_PHASE.COMPLETED);

      signals.emit('extensionDeactivating', undefined);

      expect(backend.state.streamStatus.get(running)).toBe(
        STREAM_PHASE.CANCELLED,
      );
      expect(backend.state.streamStatus.get(complete)).toBe(
        STREAM_PHASE.COMPLETED,
      );
    } finally {
      appSignalSubscription.dispose();
      backendSubscription.dispose();
      backend.dispose();
    }
  });

  it('detaches the app-signal listener cleanly', () => {
    const backend = createBackend();
    const signals = new MemoryAppSignals();
    const backendSubscription = backend.setupEventListeners();
    const appSignalSubscription = attachProgressBackendAppSignals(
      backend,
      signals,
    );
    const running = 'appsignals:disposed' as StreamTabId;

    try {
      setStatus(backend, running, STREAM_PHASE.RUNNING);
      appSignalSubscription.dispose();

      signals.emit('extensionDeactivating', undefined);

      expect(backend.state.streamStatus.get(running)).toBe(
        STREAM_PHASE.RUNNING,
      );
    } finally {
      appSignalSubscription.dispose();
      backendSubscription.dispose();
      backend.dispose();
    }
  });
});
