// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - transcript
import { streamDataDir, StreamSnapshotStore } from '@transcript';

// Local imports - agent
import { getExecutionStore } from '@agent/storage';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import type { TaskState } from '@agent/core/state/TaskState';
import { bus } from '@eventBus/ProgressEventBus';

// Local imports - logger
import * as logger from '@logger/logUtils';

// Local imports - shared
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  AgentCategory,
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  type ExecutionId,
  type ProgressViewOutboundMessage,
  type StreamTabId,
} from '@shared/schemas';
import {
  ProgressBackend,
  type ProgressBackendServices,
  type ProgressBackendUiConfig,
} from '@shared/progressView/backend/ProgressBackend';
import type { MementoStorage } from '@shared/progressView/backend/persistence/PersistentMapManager';
import { StorageFS } from '@utils/files';

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

function createRecordingBackend(): {
  backend: ProgressBackend;
  messages: ProgressViewOutboundMessage[];
} {
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
  return { backend, messages };
}

function createIsolatedRecordingBackend(): {
  backend: ProgressBackend;
  messages: ProgressViewOutboundMessage[];
  session: SessionHandle;
} {
  const messages: ProgressViewOutboundMessage[] = [];
  const session = new SessionHandle();
  const backend = new ProgressBackend({
    storage: new MemoryMementoStorage(),
    snapshots: new StreamSnapshotStore(),
    session,
    sendMessage: (message) => {
      messages.push(message);
      return true;
    },
    hasTarget: () => true,
    configureUi: () => createUiConfig(),
  });
  return { backend, messages, session };
}

async function writeExecutionConfig(executionId: ExecutionId): Promise<void> {
  await getExecutionStore(executionId).writeConfig(
    toolUseTaskState('search', 'deepseekproT').agentConfig,
  );
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
    const { backend, messages } = createRecordingBackend();

    for (let i = 0; i < 20; i += 1) {
      backend.state.streamLogs.ensureStream(`history-${i}`);
    }

    backend.webviewUpdater.sendStreamMetadata(
      backend.state,
      backend.eventHandler.getAllStreamStates(),
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
    const { backend, messages } = createRecordingBackend();
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
        executionId: 'c41111',
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
            executionId: 'c41111',
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
        backend.eventHandler.getAllStreamStates(),
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
    const { backend, messages } = createRecordingBackend();

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

  it('clears stale per-run badges when an existing stream re-enters running', async () => {
    const { backend, messages } = createRecordingBackend();
    const stream = 'tool-stream' as StreamTabId;

    try {
      await backend.state.snapshots.load([]);
      backend.state.streamLogs.ensureStream(stream);
      backend.state.snapshots.setTaskState(
        stream,
        toolUseTaskState('search', 'deepseekproT'),
        'abc123' as ExecutionId,
      );
      backend.state.updateStreamHints(stream, {
        agentCategory: AgentCategory.ToolUse,
      });
      backend.state.getOrCreateStreamState(stream, AgentCategory.ToolUse);
      backend.state.updateStreamState(stream, (prev) => ({
        ...prev,
        conversationProgress: { toolCallCount: 7 },
        roundStage: { index: 2 },
        finishedSubagentCount: 3,
        finishedProcessCount: 2,
      }));

      await backend.eventHandler.setStreamStatus(
        stream,
        STREAM_PHASE.RUNNING,
        STREAM_PHASE.COMPLETED,
      );

      expect(
        messages.some(
          (message) =>
            message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS,
        ),
      ).toBe(false);

      const patch = messages.find(
        (message) =>
          message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA &&
          message.streamInfo.name === stream,
      );
      if (patch?.command !== PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA) {
        throw new Error('Expected existing stream metadata patch');
      }

      expect(patch.streamState).toMatchObject({
        kind: AgentCategory.ToolUse,
        status: STREAM_PHASE.RUNNING,
        conversationProgress: { toolCallCount: 0 },
        roundStage: null,
        finishedSubagentCount: 0,
        finishedProcessCount: 0,
      });
      expect(
        JSON.parse(JSON.stringify(patch)).streamState.roundStage,
      ).toBeNull();
    } finally {
      backend.dispose();
    }
  });

  it('drops buffered conversation progress when an existing stream re-enters running', async () => {
    vi.useFakeTimers();
    const { backend, messages } = createRecordingBackend();
    const subscription = backend.setupEventListeners(bus);
    const stream = 'tool-stream' as StreamTabId;

    try {
      await backend.state.snapshots.load([]);
      backend.state.streamLogs.ensureStream(stream);
      backend.state.activeStream = stream;
      backend.state.snapshots.setTaskState(
        stream,
        toolUseTaskState('search', 'deepseekproT'),
        'abc123' as ExecutionId,
      );
      backend.state.updateStreamHints(stream, {
        agentCategory: AgentCategory.ToolUse,
      });
      backend.state.getOrCreateStreamState(stream, AgentCategory.ToolUse);

      bus.emit('updateConversationProgress', {
        streamId: stream,
        progress: { toolCallCount: 7 },
      });

      await backend.eventHandler.setStreamStatus(
        stream,
        STREAM_PHASE.RUNNING,
        STREAM_PHASE.COMPLETED,
      );

      await vi.advanceTimersByTimeAsync(501);

      const patch = messages.find(
        (message) =>
          message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA &&
          message.streamInfo.name === stream,
      );
      expect(patch).toMatchObject({
        command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA,
        streamState: {
          conversationProgress: { toolCallCount: 0 },
        },
      });
      expect(
        messages.some(
          (message) =>
            message.command ===
              PROGRESS_VIEW_COMMANDS.UPDATE_CONVERSATION_PROGRESS &&
            message.stream === stream &&
            message.progress.toolCallCount === 7,
        ),
      ).toBe(false);
    } finally {
      subscription.dispose();
      backend.dispose();
      vi.useRealTimers();
    }
  });

  it('revalidates and syncs the active stream when status registration changes the filter', async () => {
    const { backend, messages } = createRecordingBackend();

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

  it('deletes the execution directory named by stream metadata when a stream is cleared', async () => {
    const { backend, session } = createIsolatedRecordingBackend();
    const stream = 'tool@deepseek#a6966a' as StreamTabId;
    const executionId = 'a6966a' as ExecutionId;

    try {
      await backend.state.snapshots.load([stream]);
      backend.state.streamLogs.ensureStream(stream);
      backend.state.snapshots.setTaskState(
        stream,
        toolUseTaskState('search', 'deepseekproT'),
        executionId,
      );
      await writeExecutionConfig(executionId);
      await backend.state.flush();

      expect(await StorageFS.exists(`executions/${executionId}`)).toBe(true);
      expect(await StorageFS.exists(streamDataDir(stream))).toBe(true);

      await backend.state.clearStream(stream);

      expect(await StorageFS.exists(`executions/${executionId}`)).toBe(false);
      expect(await StorageFS.exists(streamDataDir(stream))).toBe(false);
    } finally {
      await backend.state.clearAll();
      backend.dispose();
      session.dispose();
    }
  });

  it('sweeps streamData orphans without deleting standalone execution history', async () => {
    const orphanStream = 'tool@deepseek#b6966b' as StreamTabId;
    const orphanExecution = 'b6966b' as ExecutionId;
    const historyExecution = 'c6966c' as ExecutionId;
    const seed = new StreamSnapshotStore();
    await seed.load([orphanStream]);
    seed.setTaskState(
      orphanStream,
      toolUseTaskState('search', 'deepseekproT'),
      orphanExecution,
    );
    await writeExecutionConfig(orphanExecution);
    await writeExecutionConfig(historyExecution);
    await seed.flush();

    const { backend, session } = createIsolatedRecordingBackend();
    try {
      expect(await StorageFS.exists(streamDataDir(orphanStream))).toBe(true);
      expect(await StorageFS.exists(`executions/${orphanExecution}`)).toBe(
        true,
      );
      expect(await StorageFS.exists(`executions/${historyExecution}`)).toBe(
        true,
      );

      await backend.state.load();

      expect(await StorageFS.exists(streamDataDir(orphanStream))).toBe(false);
      expect(await StorageFS.exists(`executions/${orphanExecution}`)).toBe(
        false,
      );
      expect(await StorageFS.exists(`executions/${historyExecution}`)).toBe(
        true,
      );
    } finally {
      await getExecutionStore(historyExecution).clear();
      await backend.state.clearAll();
      backend.dispose();
      session.dispose();
    }
  });

  it('continues sweeping streamData orphans when one orphan cleanup fails', async () => {
    const failingStream = 'tool@deepseek#d6966d' as StreamTabId;
    const sweptStream = 'tool@deepseek#e6966e' as StreamTabId;
    const failingExecution = 'd6966d' as ExecutionId;
    const sweptExecution = 'e6966e' as ExecutionId;
    const seed = new StreamSnapshotStore();
    await seed.load([failingStream, sweptStream]);
    seed.setTaskState(
      failingStream,
      toolUseTaskState('search', 'deepseekproT'),
      failingExecution,
    );
    seed.setTaskState(
      sweptStream,
      toolUseTaskState('search', 'deepseekproT'),
      sweptExecution,
    );
    await writeExecutionConfig(failingExecution);
    await writeExecutionConfig(sweptExecution);
    await seed.flush();

    const { backend, session } = createIsolatedRecordingBackend();
    const originalDeleteStream = backend.state.snapshots.deleteStream.bind(
      backend.state.snapshots,
    );
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const deleteSpy = vi
      .spyOn(backend.state.snapshots, 'deleteStream')
      .mockImplementation(async (stream) => {
        if (stream === failingStream) {
          throw new Error('locked stream sidecar');
        }
        await originalDeleteStream(stream);
      });

    try {
      await expect(backend.state.load()).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(
        'SessionStores',
        `Skipping orphaned stream cleanup for ${failingStream}; startup will continue.`,
        { data: expect.any(Error) },
      );
      expect(await StorageFS.exists(streamDataDir(failingStream))).toBe(true);
      expect(await StorageFS.exists(`executions/${failingExecution}`)).toBe(
        true,
      );
      expect(await StorageFS.exists(streamDataDir(sweptStream))).toBe(false);
      expect(await StorageFS.exists(`executions/${sweptExecution}`)).toBe(
        false,
      );
    } finally {
      deleteSpy.mockRestore();
      warnSpy.mockRestore();
      await getExecutionStore(failingExecution).clear();
      await getExecutionStore(sweptExecution).clear();
      await backend.state.clearAll();
      backend.dispose();
      session.dispose();
    }
  });

  it('continues sweeping streamData orphans when one execution cleanup fails', async () => {
    const failingStream = 'tool@deepseek#f6966f' as StreamTabId;
    const sweptStream = 'tool@deepseek#a6966a' as StreamTabId;
    const failingExecution = 'f6966f' as ExecutionId;
    const sweptExecution = 'a6966a' as ExecutionId;
    const seed = new StreamSnapshotStore();
    await seed.load([failingStream, sweptStream]);
    seed.setTaskState(
      failingStream,
      toolUseTaskState('search', 'deepseekproT'),
      failingExecution,
    );
    seed.setTaskState(
      sweptStream,
      toolUseTaskState('search', 'deepseekproT'),
      sweptExecution,
    );
    await writeExecutionConfig(failingExecution);
    await writeExecutionConfig(sweptExecution);
    await seed.flush();

    const { backend, session } = createIsolatedRecordingBackend();
    const stores = backend.state.stores as unknown as {
      deleteExecution(executionId: ExecutionId): Promise<boolean>;
    };
    const originalDeleteExecution = stores.deleteExecution.bind(
      backend.state.stores,
    );
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const deleteExecutionSpy = vi
      .spyOn(stores, 'deleteExecution')
      .mockImplementation(async (executionId) => {
        if (executionId === failingExecution) {
          throw new Error('locked execution dir');
        }
        return originalDeleteExecution(executionId);
      });

    try {
      await expect(backend.state.load()).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(
        'SessionStores',
        `Skipping orphaned execution cleanup for ${failingExecution}; startup will continue.`,
        { data: expect.any(Error) },
      );
      expect(await StorageFS.exists(streamDataDir(failingStream))).toBe(false);
      expect(await StorageFS.exists(`executions/${failingExecution}`)).toBe(
        true,
      );
      expect(await StorageFS.exists(streamDataDir(sweptStream))).toBe(false);
      expect(await StorageFS.exists(`executions/${sweptExecution}`)).toBe(
        false,
      );
    } finally {
      deleteExecutionSpy.mockRestore();
      warnSpy.mockRestore();
      await getExecutionStore(failingExecution).clear();
      await getExecutionStore(sweptExecution).clear();
      await backend.state.clearAll();
      backend.dispose();
      session.dispose();
    }
  });

  // Workflow tabs created before the one-run-per-tab refactor (#3061,
  // 2026-04-19) may only have their initial user message recorded in the
  // archived `legacyInstructions.json` / `runInstructions.json` sidecar, not
  // in the stream log itself. There is no retention policy or GC for
  // `streamData/`, so those tabs are still supported today and must still
  // hydrate that message at load().
  describe('legacy per-run instruction backfill (pre-#3061 tabs)', () => {
    async function seedPersistedLogWithoutUserMessage(
      backend: ReturnType<typeof createIsolatedRecordingBackend>['backend'],
      stream: StreamTabId,
    ): Promise<void> {
      // `flush()` is a no-op until the store has `load()`ed once, so run an
      // initial (empty) load first — mirrors the prior session that actually
      // persisted this stream's log to disk before the extension restarted.
      await backend.state.load();

      // A prior session's log has entries, but (as with pre-#3061 tabs) never
      // recorded a user-message entry for the run's initial instruction.
      backend.state.streamLogs.append(stream, {
        id: `${stream}-compile-log`,
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: 1_700_000_000_000,
        messageType: MESSAGE_TYPES.DEFAULT,
        text: 'Compiling document...',
      });
      await backend.state.streamLogs.flush();
    }

    it('hydrates the initial user message from legacyInstructions.json', async () => {
      const stream = 'polish@gpt#legacy01' as StreamTabId;
      const legacyText = 'Polish the introduction section for clarity.';
      const { backend, session } = createIsolatedRecordingBackend();

      try {
        await seedPersistedLogWithoutUserMessage(backend, stream);

        const dir = streamDataDir(stream);
        await StorageFS.ensureDir(dir);
        await StorageFS.write(
          path.join(dir, 'legacyInstructions.json'),
          JSON.stringify({
            'run-1': { text: legacyText, timestamp: 1_699_999_999_000 },
          }),
        );

        await backend.state.load();

        const log = backend.state.streamLogs.get(stream);
        expect(log).toBeDefined();
        const entries = log!.getRange(0, log!.head);
        expect(
          entries.some(
            (entry) =>
              entry.messageType === MESSAGE_TYPES.USER_MESSAGE &&
              entry.text === legacyText,
          ),
        ).toBe(true);
      } finally {
        await backend.state.clearAll();
        backend.dispose();
        session.dispose();
      }
    });

    it('falls back to the older runInstructions.json key (never migrated on disk)', async () => {
      const stream = 'polish@gpt#legacy02' as StreamTabId;
      const legacyText = 'Rewrite the abstract to lead with the contribution.';
      const { backend, session } = createIsolatedRecordingBackend();

      try {
        await seedPersistedLogWithoutUserMessage(backend, stream);

        const dir = streamDataDir(stream);
        await StorageFS.ensureDir(dir);
        // Pre-#3061 on-disk key; some tabs never went through the
        // legacyInstructions.json rename. No on-disk migration is expected —
        // the read falls back to this key directly.
        await StorageFS.write(
          path.join(dir, 'runInstructions.json'),
          JSON.stringify({ 'run-1': { text: legacyText } }),
        );

        await backend.state.load();

        const log = backend.state.streamLogs.get(stream);
        expect(log).toBeDefined();
        const entries = log!.getRange(0, log!.head);
        expect(
          entries.some(
            (entry) =>
              entry.messageType === MESSAGE_TYPES.USER_MESSAGE &&
              entry.text === legacyText,
          ),
        ).toBe(true);
        // Read-only fallback: the older file is left in place, untouched.
        expect(
          await StorageFS.exists(path.join(dir, 'runInstructions.json')),
        ).toBe(true);
      } finally {
        await backend.state.clearAll();
        backend.dispose();
        session.dispose();
      }
    });

    it('does not duplicate the backfilled message on a second load()', async () => {
      const stream = 'polish@gpt#legacy03' as StreamTabId;
      const legacyText = 'Tighten the related-work section.';
      const { backend, session } = createIsolatedRecordingBackend();

      try {
        await seedPersistedLogWithoutUserMessage(backend, stream);

        const dir = streamDataDir(stream);
        await StorageFS.ensureDir(dir);
        await StorageFS.write(
          path.join(dir, 'legacyInstructions.json'),
          JSON.stringify({ 'run-1': { text: legacyText } }),
        );

        await backend.state.load();
        await backend.state.load();

        const log = backend.state.streamLogs.get(stream);
        const matches = log!
          .getRange(0, log!.head)
          .filter(
            (entry) =>
              entry.messageType === MESSAGE_TYPES.USER_MESSAGE &&
              entry.text === legacyText,
          );
        expect(matches).toHaveLength(1);
      } finally {
        await backend.state.clearAll();
        backend.dispose();
        session.dispose();
      }
    });
  });
});
