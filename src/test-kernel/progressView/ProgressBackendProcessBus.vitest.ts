import { describe, expect, it, vi } from 'vitest';

import type {
  ProgressEvent,
  ProgressEventBusLike,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';
import { attachProgressBackendProcessBus } from '@progressView/progressBackendProcessBus';
import { AgentCategory, type StreamTabId } from '@shared/schemas';
import {
  ProgressBackend,
  type ProgressBackendUiConfig,
} from '@shared/progressView/backend/ProgressBackend';
import type { MementoStorage } from '@shared/progressView/backend/persistence/PersistentMapManager';

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

class MemoryProgressBus implements ProgressEventBusLike {
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

function createUiConfig(): ProgressBackendUiConfig {
  return {
    callbacks: {
      showRetryRequest: vi.fn(),
      resolveRetryRequest: vi.fn(),
      showToolEditPermission: vi.fn(),
      resolveToolEditPermission: vi.fn(),
      updateToolEditApprovalBypassState: vi.fn(),
      updateSuperYoloBypassState: vi.fn(),
      showBashPermission: vi.fn(),
      resolveBashPermission: vi.fn(),
      showAgentProposal: vi.fn(),
      resolveAgentProposal: vi.fn(),
      showPlanApproval: vi.fn(),
      resolvePlanApproval: vi.fn(),
      showExternalInquiry: vi.fn(),
      resolveExternalInquiry: vi.fn(),
      showUserQuestion: vi.fn(),
      resolveUserQuestion: vi.fn(),
    },
    hasPendingPermissions: vi.fn(() => false),
  };
}

describe('attachProgressBackendProcessBus', () => {
  it('adapts extension process-bus events into the backend and detaches cleanly', () => {
    const backend = new ProgressBackend({
      storage: new MemoryMementoStorage(),
      sendMessage: () => true,
      hasTarget: () => true,
      configureUi: () => createUiConfig(),
    });
    const processBus = new MemoryProgressBus();
    const backendSubscription = backend.setupEventListeners();
    const busSubscription = attachProgressBackendProcessBus(
      backend,
      processBus,
    );
    const first = 'extension:first' as StreamTabId;
    const second = 'extension:second' as StreamTabId;

    try {
      processBus.emit('setActiveStream', {
        streamId: first,
        agentCategory: AgentCategory.Workflow,
      });
      expect(backend.state.activeStream).toBe(first);

      busSubscription.dispose();
      processBus.emit('setActiveStream', {
        streamId: second,
        agentCategory: AgentCategory.Workflow,
      });
      expect(backend.state.activeStream).toBe(first);
    } finally {
      busSubscription.dispose();
      backendSubscription.dispose();
      backend.dispose();
    }
  });
});
