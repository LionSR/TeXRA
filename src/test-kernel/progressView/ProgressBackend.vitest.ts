// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - agent
import type { TaskState } from '@agent/core/execution/TaskState';
import { bus } from '@eventBus/ProgressEventBus';

// Local imports - shared
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  AgentCategory,
  STREAM_STATUS,
  type ProgressViewOutboundMessage,
  type StreamTabId,
} from '@shared/schemas';
import {
  ProgressBackend,
  type ProgressBackendServices,
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

function toolUseTaskState(agent: string, model: string): TaskState {
  return {
    agentConfig: {
      agent,
      model,
      agentCategory: AgentCategory.ToolUse,
    },
  } as TaskState;
}

describe('ProgressBackend', () => {
  it('constructs the shared progress backend service graph', () => {
    let servicesFromConfig: ProgressBackendServices | undefined;

    const backend = new ProgressBackend({
      storage: new MemoryMementoStorage(),
      sendMessage: vi.fn(() => true),
      hasTarget: () => true,
      configureUi: (services) => {
        servicesFromConfig = services;
        return createUiConfig();
      },
    });

    expect(servicesFromConfig).toEqual({
      state: backend.state,
      webviewUpdater: backend.webviewUpdater,
      webviewBridge: backend.webviewBridge,
    });
    expect(backend.eventHandler).toBeDefined();

    backend.dispose();
  });

  it('uses the injected target predicate before sending messages', () => {
    const sent = vi.fn(() => true);
    let hasTarget = false;
    const backend = new ProgressBackend({
      storage: new MemoryMementoStorage(),
      sendMessage: sent,
      hasTarget: () => hasTarget,
      configureUi: () => createUiConfig(),
    });

    backend.webviewUpdater.updateStreams([], '', 'all');
    expect(sent).not.toHaveBeenCalled();

    hasTarget = true;
    backend.webviewUpdater.updateStreams([], '', 'all');
    expect(sent).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
      streams: [],
      activeStream: '',
      agentFilter: 'all',
      streamStates: undefined,
    });

    backend.dispose();
  });

  it('hydrates queued follow-ups through the injected provider', () => {
    const stream = 'stream:queued-provider' as StreamTabId;
    const messages: ProgressViewOutboundMessage[] = [];
    const backend = new ProgressBackend({
      storage: new MemoryMementoStorage(),
      sendMessage: (message) => {
        messages.push(message);
        return true;
      },
      hasTarget: () => true,
      configureUi: () => createUiConfig(),
      getQueuedFollowUps: (streamId) => {
        expect(streamId).toBe(stream);
        return ['queued via runtime'];
      },
    });

    backend.eventHandler.syncStreamContent(stream);

    expect(messages.at(-1)).toMatchObject({
      command: PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT,
      stream,
      queuedFollowUps: ['queued via runtime'],
    });

    backend.dispose();
  });

  it('routes stream-status state through the injected runtime-status capability', async () => {
    const stream = 'stream:runtime-status' as StreamTabId;
    const runtimeStatus = {
      getSnapshot: vi.fn(() => new Map([[stream, STREAM_STATUS.RUNNING]])),
      setSilently: vi.fn(),
      clear: vi.fn(),
      clearAll: vi.fn(),
      isInFlight: vi.fn(() => false),
      markRunningStopped: vi.fn(),
    };
    const backend = new ProgressBackend({
      storage: new MemoryMementoStorage(),
      sendMessage: vi.fn(() => true),
      hasTarget: () => false,
      configureUi: () => createUiConfig(),
      runtimeStatus,
    });
    const subscription = backend.setupEventListeners(bus);

    try {
      backend.eventHandler.setStreamStatus(stream, STREAM_STATUS.RUNNING);
      expect(runtimeStatus.setSilently).toHaveBeenCalledWith(
        stream,
        STREAM_STATUS.RUNNING,
      );

      expect(backend.eventHandler.getAllStreamStatuses()).toEqual(
        new Map([[stream, STREAM_STATUS.RUNNING]]),
      );
      expect(runtimeStatus.getSnapshot).toHaveBeenCalled();

      backend.state.releasePreviousActive(stream);
      expect(runtimeStatus.isInFlight).toHaveBeenCalledWith(stream);

      await backend.state.clearStream(stream);
      expect(runtimeStatus.clear).toHaveBeenCalledWith(stream);

      bus.emit('extensionDeactivating', undefined);
      expect(runtimeStatus.markRunningStopped).toHaveBeenCalled();

      await backend.state.clearAll();
      expect(runtimeStatus.clearAll).toHaveBeenCalled();
    } finally {
      subscription.dispose();
      backend.dispose();
    }
  });

  it('routes interrupt pruning and trace flushing through the injected runtime-session capability', async () => {
    const stream = 'stream:runtime-session' as StreamTabId;
    const runtimeSession = {
      retainInterruptStreams: vi.fn(),
      flushPendingTraces: vi.fn(),
    };
    const backend = new ProgressBackend({
      storage: new MemoryMementoStorage(),
      sendMessage: vi.fn(() => true),
      hasTarget: () => false,
      configureUi: () => createUiConfig(),
      runtimeSession,
    });

    backend.state.snapshots.setTaskState(stream, toolUseTaskState('edit', 'm'));
    backend.state.pruneInterruptHandles();
    expect(runtimeSession.retainInterruptStreams).toHaveBeenCalledWith(
      new Set([stream]),
    );

    await backend.state.flush();
    expect(runtimeSession.flushPendingTraces).toHaveBeenCalled();

    backend.dispose();
  });

  it('contains updater transport failures', async () => {
    const sent = vi
      .fn<() => boolean | Promise<boolean>>()
      .mockImplementationOnce(() => {
        throw new Error('closed transport');
      })
      .mockRejectedValueOnce(new Error('closed transport'));

    const backend = new ProgressBackend({
      storage: new MemoryMementoStorage(),
      sendMessage: sent,
      hasTarget: () => true,
      configureUi: () => createUiConfig(),
    });

    expect(() =>
      backend.webviewUpdater.updateStreams([], '', 'all'),
    ).not.toThrow();
    backend.webviewUpdater.updateStreams([], '', 'all');
    await Promise.resolve();

    expect(sent).toHaveBeenCalledTimes(2);

    backend.dispose();
  });

  it('refreshes stream metadata when inactive stream task state arrives', async () => {
    const messages: ProgressViewOutboundMessage[] = [];
    const backend = new ProgressBackend({
      storage: new MemoryMementoStorage(),
      sendMessage: (message) => {
        messages.push(message);
        return true;
      },
      hasTarget: () => true,
      configureUi: () => createUiConfig(),
    });
    const subscription = backend.setupEventListeners(bus);

    try {
      bus.emit('setActiveStream', {
        streamId: 'root',
        agentCategory: AgentCategory.Workflow,
      });
      await vi.waitFor(() =>
        expect(
          messages.some(
            (message) =>
              message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
          ),
        ).toBe(true),
      );

      bus.emit('setActiveStream', {
        streamId: 'child',
        agentCategory: AgentCategory.ToolUse,
        suppressViewSwitch: true,
      });
      await vi.waitFor(() =>
        expect(
          messages.some(
            (message) =>
              message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS &&
              message.streams.some((stream) => stream.name === 'child'),
          ),
        ).toBe(true),
      );
      messages.length = 0;

      bus.emit('setTaskState', {
        streamId: 'child',
        executionId: 'exec-child',
        taskState: toolUseTaskState('search', 'deepseekproT'),
      });

      await vi.waitFor(() =>
        expect(
          messages.find(
            (message) =>
              message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
          ),
        ).toMatchObject({
          activeStream: 'root',
          streams: expect.arrayContaining([
            expect.objectContaining({
              name: 'child',
              label: 'search',
              agent: 'search',
              model: 'deepseekproT',
              executionId: 'exec-child',
            }),
          ]),
        }),
      );
    } finally {
      subscription.dispose();
      backend.dispose();
    }
  });
});
