// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - agent
import type { TaskState } from '@agent/core/execution/TaskState';
import { bus } from '@eventBus/ProgressEventBus';

// Local imports - shared
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  AgentCategory,
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
