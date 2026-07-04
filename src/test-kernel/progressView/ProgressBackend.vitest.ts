// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - agent
import type { TaskState } from '@agent/core/state/TaskState';
import { bus } from '@eventBus/ProgressEventBus';

// Local imports - shared
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  AgentCategory,
  STREAM_PHASE,
  type ProgressViewOutboundMessage,
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

  it('sends the full metadata set once for full-view sync', () => {
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

    for (let i = 0; i < 20; i += 1) {
      backend.state.streamLogs.ensureStream(`history-${i}`);
    }

    backend.webviewUpdater.sendStreamMetadata(
      backend.state,
      backend.eventHandler.getAllStreamStatuses(),
      undefined,
      backend.eventHandler.getAllStreamSubstates(),
    );

    expect(
      messages.filter(
        (message) => message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
      ),
    ).toHaveLength(1);
    expect(
      messages.filter(
        (message) =>
          message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA,
      ),
    ).toHaveLength(0);

    const fullSync = messages.find(
      (message) => message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
    );
    if (fullSync?.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS) {
      expect(fullSync.streams).toHaveLength(20);
    } else {
      throw new Error('Expected full stream metadata sync');
    }

    backend.dispose();
  });

  it('patches one stream for subagent registration and run-start metadata', async () => {
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
      for (let i = 0; i < 20; i += 1) {
        backend.state.streamLogs.ensureStream(`history-${i}`);
      }

      bus.emit('setActiveStream', {
        streamId: 'root',
        agentCategory: AgentCategory.Workflow,
      });
      await vi.waitFor(() =>
        expect(
          messages.some(
            (message) =>
              message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA,
          ),
        ).toBe(true),
      );
      messages.length = 0;

      bus.emit('setActiveStream', {
        streamId: 'child',
        agentCategory: AgentCategory.ToolUse,
        suppressViewSwitch: true,
      });
      await vi.waitFor(() =>
        expect(
          messages.find(
            (message) =>
              message.command ===
                PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA &&
              message.streamInfo.name === 'child',
          ),
        ).toBeDefined(),
      );
      expect(
        messages.some(
          (message) =>
            message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
        ),
      ).toBe(false);
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
              message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA,
          ),
        ).toMatchObject({
          streamInfo: {
            name: 'child',
            label: 'search',
            agent: 'search',
            model: 'deepseekproT',
            executionId: 'exec-child',
          },
        }),
      );
      expect(
        messages.some(
          (message) =>
            message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
        ),
      ).toBe(false);

      const patch = messages.find(
        (message) =>
          message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA,
      );
      messages.length = 0;

      backend.webviewUpdater.sendStreamMetadata(
        backend.state,
        backend.eventHandler.getAllStreamStatuses(),
        undefined,
        backend.eventHandler.getAllStreamSubstates(),
      );
      const fullSync = messages.find(
        (message) => message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
      );

      if (
        patch?.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA &&
        fullSync?.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS
      ) {
        expect(
          fullSync.streams.find((stream) => stream.name === 'child'),
        ).toEqual(patch.streamInfo);
        expect(fullSync.streamStates?.child).toEqual(patch.streamState);
      } else {
        throw new Error('Expected patch and full sync messages');
      }
    } finally {
      subscription.dispose();
      backend.dispose();
    }
  });

  it('does not switch category filters for unknown-category status streams', async () => {
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

    try {
      backend.state.streamLogs.ensureStream('tool-stream');
      backend.state.updateStreamHints('tool-stream', {
        agentCategory: AgentCategory.ToolUse,
      });
      backend.state.getOrCreateStreamState(
        'tool-stream',
        AgentCategory.ToolUse,
      );
      backend.state.activeStream = 'tool-stream';
      backend.state.agentCategoryFilter = 'toolUse';

      await backend.eventHandler.setStreamStatus(
        'unknown-stream',
        STREAM_PHASE.RUNNING,
      );

      const patch = messages.find(
        (message) =>
          message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA &&
          message.streamInfo.name === 'unknown-stream',
      );
      expect(backend.state.agentCategoryFilter).toBe('toolUse');
      expect(backend.state.activeStream).toBe('tool-stream');
      expect(patch).toMatchObject({
        agentFilter: 'toolUse',
        activeStream: undefined,
        streamInfo: {
          name: 'unknown-stream',
          agentCategory: AgentCategory.Workflow,
        },
      });
    } finally {
      backend.dispose();
    }
  });

  it('revalidates and syncs the active stream when status registration changes the filter', async () => {
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

    try {
      backend.state.streamLogs.ensureStream('tool-stream');
      backend.state.updateStreamHints('tool-stream', {
        agentCategory: AgentCategory.ToolUse,
      });
      backend.state.getOrCreateStreamState(
        'tool-stream',
        AgentCategory.ToolUse,
      );
      backend.state.activeStream = 'tool-stream';
      backend.state.agentCategoryFilter = 'toolUse';
      backend.state.streamLogs.ensureStream('workflow-existing');
      backend.state.updateStreamHints('workflow-existing', {
        agentCategory: AgentCategory.Workflow,
      });
      backend.state.getOrCreateStreamState(
        'workflow-existing',
        AgentCategory.Workflow,
      );
      backend.state.updateStreamHints('workflow-stream', {
        agentCategory: AgentCategory.Workflow,
      });
      vi.spyOn(backend.state, 'pickValidActiveStream').mockReturnValue(
        'workflow-existing',
      );

      await backend.eventHandler.setStreamStatus(
        'workflow-stream',
        STREAM_PHASE.RUNNING,
      );

      const patch = messages.find(
        (message) =>
          message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA &&
          message.streamInfo.name === 'workflow-stream',
      );
      expect(backend.state.agentCategoryFilter).toBe('workflow');
      expect(backend.state.activeStream).toBe('workflow-existing');
      expect(patch).toMatchObject({
        agentFilter: 'workflow',
        activeStream: 'workflow-existing',
        streamInfo: {
          name: 'workflow-stream',
          agentCategory: AgentCategory.Workflow,
        },
      });
      expect(
        messages.find(
          (message) =>
            message.command === PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT,
        ),
      ).toMatchObject({
        stream: 'workflow-existing',
        action: 'render',
      });
    } finally {
      backend.dispose();
    }
  });
});
