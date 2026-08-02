// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { describe, expect, it } from 'vitest';

import type { ProgressBackend } from '@controllers/progressView/backend/ProgressBackend';
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
import { STREAM_TRANSITION_CAUSE } from '@shared/streams/streamStatus';

import { createRecordingBackend, track } from './progressBackendHarness';

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
    const { backend } = createRecordingBackend();
    const signals = new MemoryAppSignals();
    backend.setupEventListeners();
    track(attachProgressBackendAppSignals(backend, signals));
    const running = 'appsignals:running' as StreamTabId;
    const complete = 'appsignals:complete' as StreamTabId;

    setStatus(backend, running, STREAM_PHASE.RUNNING);
    setStatus(backend, complete, STREAM_PHASE.COMPLETED);

    signals.emit('extensionDeactivating', undefined);

    expect(backend.state.streamStatus.get(running)).toBe(
      STREAM_PHASE.CANCELLED,
    );
    expect(backend.state.streamStatus.get(complete)).toBe(
      STREAM_PHASE.COMPLETED,
    );
  });

  it('detaches the app-signal listener cleanly', () => {
    const { backend } = createRecordingBackend();
    const signals = new MemoryAppSignals();
    backend.setupEventListeners();
    const appSignalSubscription = track(
      attachProgressBackendAppSignals(backend, signals),
    );
    const running = 'appsignals:disposed' as StreamTabId;

    setStatus(backend, running, STREAM_PHASE.RUNNING);
    appSignalSubscription.dispose();

    signals.emit('extensionDeactivating', undefined);

    expect(backend.state.streamStatus.get(running)).toBe(STREAM_PHASE.RUNNING);
  });
});
