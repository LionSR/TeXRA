// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Test support imports
import * as path from 'node:path';
import { createTestSession } from '@test/support/sessionTestUtils';

// Standard library imports

// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - transcript
import {
  streamDataDir,
  StreamLogStore,
  StreamSnapshotStore,
} from '@transcript';
import { STREAM_DATA_DIR } from '@transcript/streamDataPaths';

// Local imports - agent
import {
  ProgressBackend,
  type ProgressBackendServices,
  type ProgressBackendUiConfig,
} from '@controllers/progressView/backend/ProgressBackend';
import { buildStreamInfos } from '@controllers/progressView/backend/streamInfoUtils';
import type { AgentEvent } from '@agent/trace';
import { getExecutionStore } from '@agent/storage';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  type RunFactEventName,
  type RunFactPayloads,
} from '@agent/runtime/runFactEvents';
import type { TaskState } from '@agent/core/state/TaskState';
import { STREAM_TRANSITION_CAUSE } from '@shared/streams/streamStatus';

// Local imports - logger
import * as logger from '@logger/logUtils';

// Local imports - shared
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  AgentCategory,
  type ActiveChildInfo,
  type CompileFailure,
  type InquiryThreadUpdatedEvent,
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  type ExecutionId,
  type FileLocation,
  type OutputFileInfo,
  type Plan,
  type ProgressViewOutboundMessage,
  type SetActiveStreamPayload,
  type StorageKey,
  type StreamTabId,
  type TodoItem,
  type UpdateStreamDescriptionPayload,
} from '@shared/schemas';
import { GoalStore } from '@tools/goal';
import { StorageFS } from '@utils/files';
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

function createIsolatedRecordingBackend(
  session: SessionHandle = createTestSession(),
): {
  backend: ProgressBackend;
  messages: ProgressViewOutboundMessage[];
  session: SessionHandle;
} {
  const messages: ProgressViewOutboundMessage[] = [];
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

async function createPersistentRecordingBackend(): Promise<
  ReturnType<typeof createIsolatedRecordingBackend>
> {
  return createIsolatedRecordingBackend(
    createTestSession({ transcripts: await StreamLogStore.open() }),
  );
}

async function writeExecutionConfig(executionId: ExecutionId): Promise<void> {
  await getExecutionStore(executionId).writeConfig(
    toolUseTaskState('search', 'deepseekproT').agentConfig,
  );
}

function emitActiveStream(
  target: { session: SessionHandle },
  payload: SetActiveStreamPayload,
): void {
  target.session.events.emit({
    scope: 'session',
    event: {
      type: 'setActiveStream',
      payload,
    },
  });
}

function emitRunConfig(
  target: { session: SessionHandle },
  streamId: StreamTabId,
  executionId: ExecutionId,
  taskState: TaskState,
): void {
  target.session.events.emit({
    scope: 'run',
    streamId,
    event: {
      type: 'run.config',
      streamId,
      executionId,
      config: taskState.agentConfig,
    },
  });
}

function emitStreamDescription(
  target: { session: SessionHandle },
  payload: UpdateStreamDescriptionPayload,
): void {
  target.session.events.emit({
    scope: 'session',
    event: {
      type: 'updateStreamDescription',
      payload,
    },
  });
}

function emitRunFact<K extends RunFactEventName>(
  target: { session: SessionHandle },
  streamId: StreamTabId,
  factName: K,
  payload: RunFactPayloads[K],
): void {
  target.session.events.emit({
    scope: 'run',
    streamId,
    event: { type: factName, ...payload } as Extract<AgentEvent, { type: K }>,
  });
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
    expect(backend.interactionHandler).toBeDefined();

    backend.dispose();
  });

  it('handles session facts through its local subscription', () => {
    const target = createIsolatedRecordingBackend();
    const { backend, session } = target;
    const subscription = backend.setupEventListeners();
    const streamId = 'desktop-local-stream' as StreamTabId;

    try {
      emitActiveStream(target, {
        streamId,
        agentCategory: AgentCategory.Workflow,
      });

      expect(backend.state.activeStream).toBe(streamId);
      expect(backend.state.streamLogs.has(streamId)).toBe(true);
    } finally {
      subscription.dispose();
      backend.dispose();
      session.dispose();
    }
  });

  it('routes removeStream session facts through the shared lifecycle delete path', async () => {
    const session = createTestSession();
    const deletedStreams: StreamTabId[] = [];
    const backendRef: { current?: ProgressBackend } = {};
    const backend = new ProgressBackend({
      storage: new MemoryMementoStorage(),
      session,
      sendMessage: vi.fn(() => true),
      hasTarget: () => true,
      configureUi: () => createUiConfig(),
      deleteStream: async (stream) => {
        const currentBackend = backendRef.current;
        if (!currentBackend) {
          throw new Error('Progress backend was not initialized');
        }
        await currentBackend.state.clearStream(stream);
        deletedStreams.push(stream);
      },
    });
    backendRef.current = backend;
    const subscription = backend.setupEventListeners();
    const streamId = 'desktop-child-stream' as StreamTabId;

    try {
      backend.state.streamLogs.ensureStream(streamId);
      backend.state.getOrCreateStreamState(streamId, AgentCategory.ToolUse);

      session.events.emit({
        scope: 'session',
        event: { type: 'removeStream', payload: { streamId } },
      });

      await vi.waitFor(() => expect(deletedStreams).toEqual([streamId]));
      expect(backend.state.streamLogs.has(streamId)).toBe(false);
      expect(backend.state.getStreamState(streamId)).toBeUndefined();
    } finally {
      subscription.dispose();
      await backend.state.clearAll();
      backend.dispose();
      session.dispose();
    }
  });

  it('handles removeStream session facts before backend load', async () => {
    const session = createTestSession();
    const deletedStreams: StreamTabId[] = [];
    const backend = new ProgressBackend({
      storage: new MemoryMementoStorage(),
      session,
      sendMessage: vi.fn(() => true),
      hasTarget: () => true,
      configureUi: () => createUiConfig(),
      deleteStream: async (stream) => {
        deletedStreams.push(stream);
      },
    });
    const subscription = backend.setupEventListeners();
    const streamId = 'preload-child-stream' as StreamTabId;

    try {
      session.events.emit({
        scope: 'session',
        event: { type: 'removeStream', payload: { streamId } },
      });

      await vi.waitFor(() => expect(deletedStreams).toEqual([streamId]));
    } finally {
      subscription.dispose();
      backend.dispose();
      session.dispose();
    }
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
      backend.factApplier.getAllStreamStates(),
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

  it('keeps a filtered interaction stream reachable without switching', async () => {
    const target = createIsolatedRecordingBackend();
    const { backend, messages } = target;
    const subscription = backend.setupEventListeners();

    try {
      emitActiveStream(target, {
        streamId: 'root',
        agentCategory: AgentCategory.Workflow,
      });
      await vi.waitFor(() => expect(backend.state.activeStream).toBe('root'));
      backend.state.agentCategoryFilter = AgentCategory.Workflow;
      messages.length = 0;

      emitActiveStream(target, {
        streamId: 'hidden-approval',
        agentCategory: AgentCategory.ToolUse,
        suppressViewSwitch: true,
        ensureVisible: true,
      });

      await vi.waitFor(() =>
        expect(backend.state.agentCategoryFilter).toBe('all'),
      );
      expect(backend.state.activeStream).toBe('root');
      expect(messages).toContainEqual(
        expect.objectContaining({
          command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
          activeStream: 'root',
          agentFilter: 'all',
          streams: expect.arrayContaining([
            expect.objectContaining({ name: 'hidden-approval' }),
          ]),
        }),
      );
    } finally {
      subscription.dispose();
      backend.dispose();
    }
  });

  it('patches one stream for subagent registration and run-start metadata', async () => {
    const target = createIsolatedRecordingBackend();
    const { backend, messages, session } = target;
    const subscription = backend.setupEventListeners();

    try {
      for (let i = 0; i < 20; i += 1) {
        backend.state.streamLogs.ensureStream(`history-${i}`);
      }

      emitActiveStream(target, {
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

      emitActiveStream(target, {
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

      emitRunConfig(
        target,
        'child' as StreamTabId,
        'c41111' as ExecutionId,
        toolUseTaskState('search', 'deepseekproT'),
      );

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
        backend.factApplier.getAllStreamStates(),
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
      session.dispose();
    }
  });

  it('scopes direct session events to each backend session', async () => {
    const first = createIsolatedRecordingBackend();
    const second = createIsolatedRecordingBackend();
    const firstSubscription = first.backend.setupEventListeners();
    const secondSubscription = second.backend.setupEventListeners();
    const firstStream = 'session:first' as StreamTabId;
    const secondStream = 'session:second' as StreamTabId;

    try {
      first.session.events.emit({
        scope: 'session',
        event: {
          type: 'setActiveStream',
          payload: {
            streamId: firstStream,
            agentCategory: AgentCategory.Workflow,
          },
        },
      });

      await vi.waitFor(() =>
        expect(first.backend.state.activeStream).toBe(firstStream),
      );
      expect(second.backend.state.activeStream).not.toBe(firstStream);
      expect(JSON.stringify(second.messages)).not.toContain(firstStream);

      second.session.events.emit({
        scope: 'session',
        event: {
          type: 'setActiveStream',
          payload: {
            streamId: secondStream,
            agentCategory: AgentCategory.ToolUse,
          },
        },
      });

      await vi.waitFor(() =>
        expect(second.backend.state.activeStream).toBe(secondStream),
      );
      expect(first.backend.state.activeStream).toBe(firstStream);
      expect(JSON.stringify(first.messages)).not.toContain(secondStream);
    } finally {
      firstSubscription.dispose();
      secondSubscription.dispose();
      first.backend.dispose();
      second.backend.dispose();
      first.session.dispose();
      second.session.dispose();
    }
  });

  it('isolates same-stream run facts across simultaneous backend sessions', async () => {
    const first = createIsolatedRecordingBackend();
    const second = createIsolatedRecordingBackend();
    const firstSubscription = first.backend.setupEventListeners();
    const secondSubscription = second.backend.setupEventListeners();
    const streamId = 'window:shared-stream-id' as StreamTabId;
    const firstTodo: TodoItem = {
      content: 'from first window',
      status: 'pending',
      activeForm: 'Writing from first window',
    };
    const secondTodo: TodoItem = {
      content: 'from second window',
      status: 'completed',
      activeForm: 'Writing from second window',
    };
    const firstOutput: OutputFileInfo = {
      source: 'first.tex',
      location: {
        kind: 'workspace',
        absolutePath: '/workspace/first.pdf',
        relativePath: 'first.pdf',
      },
      round: 1,
      lineage: null,
      diff: null,
    };

    try {
      await first.backend.state.snapshots.load([]);
      await second.backend.state.snapshots.load([]);

      first.session.events.emit({
        scope: 'run',
        streamId,
        event: {
          type: 'updateTodos',
          streamId,
          todos: [firstTodo],
        },
      });
      first.session.events.emit({
        scope: 'run',
        streamId,
        event: {
          type: 'addOutputFiles',
          streamId,
          filesByRound: { 1: [firstOutput] },
        },
      });

      expect(first.backend.state.snapshots.getWorkPlan(streamId).todos).toEqual(
        [firstTodo],
      );
      expect(first.backend.state.snapshots.getOutputFiles(streamId)).toEqual({
        1: [firstOutput],
      });
      expect(
        second.backend.state.snapshots.getWorkPlan(streamId).todos,
      ).toEqual([]);
      expect(second.backend.state.snapshots.getOutputFiles(streamId)).toEqual(
        {},
      );
      expect(JSON.stringify(second.messages)).not.toContain(
        'from first window',
      );
      expect(JSON.stringify(second.messages)).not.toContain('first.pdf');

      second.session.events.emit({
        scope: 'run',
        streamId,
        event: {
          type: 'updateTodos',
          streamId,
          todos: [secondTodo],
        },
      });

      expect(first.backend.state.snapshots.getWorkPlan(streamId).todos).toEqual(
        [firstTodo],
      );
      expect(
        second.backend.state.snapshots.getWorkPlan(streamId).todos,
      ).toEqual([secondTodo]);
      expect(JSON.stringify(first.messages)).not.toContain(
        'from second window',
      );
    } finally {
      firstSubscription.dispose();
      secondSubscription.dispose();
      first.backend.dispose();
      second.backend.dispose();
      first.session.dispose();
      second.session.dispose();
    }
  });

  it('isolates simultaneous window sessions across view state, status, snapshots, and transcripts', async () => {
    const first = createIsolatedRecordingBackend();
    const second = createIsolatedRecordingBackend();
    const firstSubscription = first.backend.setupEventListeners();
    const secondSubscription = second.backend.setupEventListeners();
    const firstStream = 'window:first' as StreamTabId;
    const secondStream = 'window:second' as StreamTabId;
    const firstExecution = 'f41111' as ExecutionId;
    const secondExecution = 'f42222' as ExecutionId;

    try {
      await first.backend.state.snapshots.load([]);
      await second.backend.state.snapshots.load([]);

      first.session.events.emit({
        scope: 'session',
        event: {
          type: 'setActiveStream',
          payload: {
            streamId: firstStream,
            agentCategory: AgentCategory.ToolUse,
          },
        },
      });
      second.session.events.emit({
        scope: 'session',
        event: {
          type: 'setActiveStream',
          payload: {
            streamId: secondStream,
            agentCategory: AgentCategory.Workflow,
          },
        },
      });

      emitRunConfig(
        first,
        firstStream,
        firstExecution,
        toolUseTaskState('search', 'deepseekproT'),
      );
      emitRunConfig(
        second,
        secondStream,
        secondExecution,
        toolUseTaskState('revise', 'gpt-4o'),
      );
      first.session.status.transition(
        firstStream,
        STREAM_PHASE.RUNNING,
        'lifecycle',
      );
      second.session.status.transition(
        secondStream,
        STREAM_PHASE.RUNNING,
        'lifecycle',
      );
      second.session.status.transitionToWaiting(secondStream, 'wait');
      emitStreamDescription(first, {
        streamId: firstStream,
        description: 'first window run',
      });
      emitStreamDescription(second, {
        streamId: secondStream,
        description: 'second window run',
      });
      first.backend.state.streamLogs.append(firstStream, {
        id: 'first-window-log',
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: 1_700_000_000_001,
        messageType: MESSAGE_TYPES.DEFAULT,
        text: 'first transcript entry',
      });
      second.backend.state.streamLogs.append(secondStream, {
        id: 'second-window-log',
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: 1_700_000_000_002,
        messageType: MESSAGE_TYPES.DEFAULT,
        text: 'second transcript entry',
      });

      await vi.waitFor(() =>
        expect(first.backend.state.activeStream).toBe(firstStream),
      );
      await vi.waitFor(() =>
        expect(second.backend.state.activeStream).toBe(secondStream),
      );

      expect(first.backend.state.streamStatus.get(firstStream)).toBe(
        STREAM_PHASE.RUNNING,
      );
      expect(
        first.backend.state.streamStatus.get(secondStream),
      ).toBeUndefined();
      expect(second.backend.state.streamStatus.get(secondStream)).toBe(
        STREAM_PHASE.WAITING,
      );
      expect(
        second.backend.state.streamStatus.get(firstStream),
      ).toBeUndefined();

      expect(first.backend.state.snapshots.getExecutionId(firstStream)).toBe(
        firstExecution,
      );
      expect(
        first.backend.state.snapshots.getExecutionId(secondStream),
      ).toBeUndefined();
      expect(second.backend.state.snapshots.getExecutionId(secondStream)).toBe(
        secondExecution,
      );
      expect(
        second.backend.state.snapshots.getExecutionId(firstStream),
      ).toBeUndefined();
      expect(first.backend.state.snapshots.getDescription(firstStream)).toBe(
        'first window run',
      );
      expect(
        first.backend.state.snapshots.getDescription(secondStream),
      ).toBeUndefined();
      expect(second.backend.state.snapshots.getDescription(secondStream)).toBe(
        'second window run',
      );
      expect(
        second.backend.state.snapshots.getDescription(firstStream),
      ).toBeUndefined();

      expect(first.backend.state.streamLogs.get(firstStream)?.size).toBe(1);
      expect(first.backend.state.streamLogs.get(secondStream)).toBeUndefined();
      expect(second.backend.state.streamLogs.get(secondStream)?.size).toBe(1);
      expect(second.backend.state.streamLogs.get(firstStream)).toBeUndefined();
      expect(JSON.stringify(first.messages)).not.toContain(secondStream);
      expect(JSON.stringify(second.messages)).not.toContain(firstStream);
    } finally {
      firstSubscription.dispose();
      secondSubscription.dispose();
      first.backend.dispose();
      second.backend.dispose();
      first.session.dispose();
      second.session.dispose();
    }
  });

  it('applies session facts without re-entering the host progress-event applier', async () => {
    const { backend, session } = createIsolatedRecordingBackend();
    const subscription = backend.setupEventListeners();
    const applier = vi.spyOn(
      backend.interactionHandler,
      'handleInteractionEvent',
    );
    const streamId = 'session:single-applier' as StreamTabId;
    const payload: SetActiveStreamPayload = {
      streamId,
      agentCategory: AgentCategory.Workflow,
    };

    try {
      session.events.emit({
        scope: 'session',
        event: {
          type: 'setActiveStream',
          payload,
        },
      });

      await vi.waitFor(() => expect(backend.state.activeStream).toBe(streamId));
      expect(applier).not.toHaveBeenCalled();
    } finally {
      subscription.dispose();
      backend.dispose();
      session.dispose();
    }
  });

  it('no-ops direct interaction events after dispose', () => {
    const { backend } = createIsolatedRecordingBackend();
    const applier = vi.spyOn(
      backend.interactionHandler,
      'handleInteractionEvent',
    );
    const streamId = 'desktop-post-close-stream' as StreamTabId;

    backend.dispose();

    // A run that kept executing headless after a desktop window closed still
    // holds the host-channel emit closure that routes to handleInteractionEvent.
    expect(() =>
      backend.handleInteractionEvent('updateToolEditApprovalBypassState', {
        streamId,
        bypassActive: true,
      }),
    ).not.toThrow();

    expect(applier).not.toHaveBeenCalled();
    expect(backend.state.activeStream).not.toBe(streamId);
  });

  it('applies session run facts through the fact-native handler', async () => {
    const { backend, session } = createIsolatedRecordingBackend();
    const subscription = backend.setupEventListeners();
    const handleRunFact = vi.spyOn(backend.factApplier, 'handleRunFact');
    const handleInteractionEvent = vi.spyOn(
      backend.interactionHandler,
      'handleInteractionEvent',
    );
    const updateFiles = vi.spyOn(backend.webviewUpdater, 'updateFiles');
    const updateMissingOutputs = vi.spyOn(
      backend.webviewUpdater,
      'updateMissingOutputs',
    );
    const updateCompileFailures = vi.spyOn(
      backend.webviewUpdater,
      'updateCompileFailures',
    );
    const updateRunUsage = vi.spyOn(backend.webviewUpdater, 'updateRunUsage');
    const updateTodos = vi.spyOn(backend.webviewUpdater, 'updateTodos');
    const updatePlan = vi.spyOn(backend.webviewUpdater, 'updatePlan');
    const streamId = 'session:output-files' as StreamTabId;
    const storageKey = 'run:session-usage' as StorageKey;
    const location: FileLocation = {
      kind: 'workspace',
      absolutePath: '/workspace/paper.tex',
      relativePath: 'paper.tex',
    };
    const outputFile: OutputFileInfo = {
      source: 'paper.tex',
      location,
      round: 1,
      lineage: null,
      diff: null,
    };
    const compileFailure: CompileFailure = {
      round: 1,
      displayName: 'paper.tex',
      output: {
        kind: 'workspace',
        absolutePath: '/workspace/paper.pdf',
        relativePath: 'paper.pdf',
      },
      log: {
        kind: 'workspace',
        absolutePath: '/workspace/paper.log',
        relativePath: 'paper.log',
      },
      logRelativePath: 'paper.log',
    };
    const todos: TodoItem[] = [
      {
        content: 'Preserve session fact handling',
        status: 'pending',
        activeForm: 'Preserving session fact handling',
      },
    ];
    const plan: Plan = {
      objective: 'Route session facts directly through ProgressBackend.',
    };

    try {
      await backend.state.snapshots.load([]);
      emitActiveStream(
        { session },
        {
          streamId,
          agentCategory: AgentCategory.Workflow,
        },
      );
      handleRunFact.mockClear();
      handleInteractionEvent.mockClear();
      updateFiles.mockClear();
      updateMissingOutputs.mockClear();
      updateCompileFailures.mockClear();
      updateRunUsage.mockClear();
      updateTodos.mockClear();
      updatePlan.mockClear();

      session.events.emit({
        scope: 'run',
        streamId,
        event: {
          type: 'addOutputFiles',
          streamId,
          filesByRound: { 1: [outputFile] },
        },
      });
      session.events.emit({
        scope: 'run',
        streamId,
        event: {
          type: 'updateMissingOutputs',
          streamId,
          filesByRound: { 1: ['paper.pdf'] },
        },
      });
      session.events.emit({
        scope: 'run',
        streamId,
        event: {
          type: 'updateCompileFailures',
          streamId,
          filesByRound: { 1: [compileFailure] },
        },
      });
      session.events.emit({
        scope: 'run',
        streamId,
        event: {
          type: 'updateTodos',
          streamId,
          todos,
        },
      });
      session.events.emit({
        scope: 'run',
        streamId,
        event: {
          type: 'updatePlan',
          streamId,
          plan,
        },
      });
      session.events.emit({
        scope: 'run',
        streamId,
        event: {
          type: 'usage',
          stats: { inputTokens: 10, outputTokens: 5, cost: 0.01 },
          data: {
            streamId,
            storageKey,
            usage: { inputTokens: 10, outputTokens: 5, cost: 0.01 },
          },
          recordTranscript: false,
        },
      });
      session.events.emit({
        scope: 'run',
        streamId,
        event: {
          type: 'goalPaused',
          streamId,
        },
      });

      expect(handleRunFact).toHaveBeenCalledTimes(7);
      expect(handleInteractionEvent).not.toHaveBeenCalled();
      expect(updateFiles).toHaveBeenCalledTimes(1);
      expect(updateFiles).toHaveBeenCalledWith(streamId, {
        rounds: { 1: [outputFile] },
      });
      expect(updateMissingOutputs).toHaveBeenCalledWith(streamId, {
        rounds: { 1: ['paper.pdf'] },
      });
      expect(updateCompileFailures).toHaveBeenCalledWith(streamId, {
        rounds: { 1: [compileFailure] },
        reset: true,
      });
      expect(updateTodos).toHaveBeenCalledWith(streamId, todos);
      expect(updatePlan).toHaveBeenCalledWith(streamId, plan);
      await vi.waitFor(() =>
        expect(updateRunUsage).toHaveBeenCalledWith(streamId, storageKey, {
          inputTokens: 10,
          outputTokens: 5,
          cost: 0.01,
          cacheReadInputTokens: 0,
          cacheMissInputTokens: 0,
          cacheCreationInputTokens: 0,
        }),
      );
      expect(backend.state.snapshots.getOutputFiles(streamId)).toEqual({
        1: [outputFile],
      });
      expect(backend.state.snapshots.getMissingOutputs(streamId)).toEqual({
        1: ['paper.pdf'],
      });
      expect(backend.state.snapshots.getCompileFailures(streamId)).toEqual({
        1: [compileFailure],
      });
      expect(backend.state.snapshots.getWorkPlan(streamId)).toMatchObject({
        todos,
        plan,
      });
      expect(backend.state.snapshots.getRunUsage(streamId)).toEqual(
        new Map([
          [
            storageKey,
            {
              inputTokens: 10,
              outputTokens: 5,
              cost: 0.01,
              cacheReadInputTokens: 0,
              cacheMissInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
          ],
        ]),
      );
    } finally {
      subscription.dispose();
      await backend.state.clearAll();
      backend.dispose();
      session.dispose();
    }
  });

  it('drops malformed updateTodos/updatePlan run facts instead of forwarding them unchecked (#7562)', async () => {
    const { backend, session } = createIsolatedRecordingBackend();
    const subscription = backend.setupEventListeners();
    const handleInteractionEvent = vi.spyOn(
      backend.interactionHandler,
      'handleInteractionEvent',
    );
    const updateTodos = vi.spyOn(backend.webviewUpdater, 'updateTodos');
    const updatePlan = vi.spyOn(backend.webviewUpdater, 'updatePlan');
    const streamId = 'session:malformed-todos-plan' as StreamTabId;

    try {
      await backend.state.snapshots.load([]);
      emitActiveStream(
        { session },
        {
          streamId,
          agentCategory: AgentCategory.Workflow,
        },
      );
      handleInteractionEvent.mockClear();
      updateTodos.mockClear();
      updatePlan.mockClear();

      session.events.emit({
        scope: 'run',
        streamId,
        event: {
          type: 'domain',
          key: 'runFact.updateTodos',
          data: { streamId, todos: 'not-an-array' },
        },
      });
      session.events.emit({
        scope: 'run',
        streamId,
        event: {
          type: 'domain',
          key: 'runFact.updatePlan',
          data: { streamId, plan: { steps: ['legacy shape'] } },
        },
      });

      expect(handleInteractionEvent).not.toHaveBeenCalled();
      expect(updateTodos).not.toHaveBeenCalled();
      expect(updatePlan).not.toHaveBeenCalled();
    } finally {
      subscription.dispose();
      await backend.state.clearAll();
      backend.dispose();
      session.dispose();
    }
  });

  it('no-ops session output-file run facts after dispose', async () => {
    const { backend, session } = createIsolatedRecordingBackend();
    const subscription = backend.setupEventListeners();
    const handleRunFact = vi.spyOn(backend.factApplier, 'handleRunFact');
    const handleInteractionEvent = vi.spyOn(
      backend.interactionHandler,
      'handleInteractionEvent',
    );
    const updateFiles = vi.spyOn(backend.webviewUpdater, 'updateFiles');
    const streamId = 'session:output-files-after-dispose' as StreamTabId;
    const location: FileLocation = {
      kind: 'workspace',
      absolutePath: '/workspace/paper.tex',
      relativePath: 'paper.tex',
    };
    const outputFile: OutputFileInfo = {
      source: 'paper.tex',
      location,
      round: 1,
      lineage: null,
      diff: null,
    };

    try {
      await backend.state.snapshots.load([]);
      emitActiveStream(
        { session },
        {
          streamId,
          agentCategory: AgentCategory.Workflow,
        },
      );
      handleRunFact.mockClear();
      handleInteractionEvent.mockClear();
      updateFiles.mockClear();
      backend.dispose();

      session.events.emit({
        scope: 'run',
        streamId,
        event: {
          type: 'addOutputFiles',
          streamId,
          filesByRound: { 1: [outputFile] },
        },
      });

      expect(handleRunFact).not.toHaveBeenCalled();
      expect(handleInteractionEvent).not.toHaveBeenCalled();
      expect(updateFiles).not.toHaveBeenCalled();
      expect(backend.state.snapshots.getOutputFiles(streamId)).toEqual({});
    } finally {
      subscription.dispose();
      await backend.state.clearAll();
      backend.dispose();
      session.dispose();
    }
  });

  it('handles session facts without the host progress-event adapter', async () => {
    const target = createIsolatedRecordingBackend();
    const subscription = target.backend.setupEventListeners();
    const handleInteractionEvent = vi.spyOn(
      target.backend.interactionHandler,
      'handleInteractionEvent',
    );
    const parentStreamId = 'session:parent' as StreamTabId;
    const childStreamId = 'session:child' as StreamTabId;
    const executionId = 'exec:direct-session' as ExecutionId;
    const child: ActiveChildInfo = {
      kind: 'subagent',
      executionId: 'exec:child' as ExecutionId,
      childStreamId,
      agentName: 'orchestrator',
      status: 'running',
      startedAt: 1,
      elapsed: null,
    };
    const process: ActiveChildInfo = {
      kind: 'process',
      executionId,
      agentName: 'bash',
      status: 'running',
      startedAt: 2,
      elapsed: '1s',
      toolName: 'bash',
    };
    const inquiryThread = {
      threadId: 'ei_123456789abc',
      parentStreamId,
      status: 'open',
      lastQuestionPreview: 'Can you check this estimate?',
      lastActivityIso: '2026-07-06T12:00:00.000Z',
      turnCount: 1,
      resumeOutcome: null,
    } satisfies InquiryThreadUpdatedEvent;

    try {
      await target.backend.state.snapshots.load([]);
      emitActiveStream(target, {
        streamId: parentStreamId,
        agentCategory: AgentCategory.ToolUse,
      });
      target.session.events.emit({
        scope: 'run',
        streamId: parentStreamId,
        event: {
          type: 'status',
          streamId: parentStreamId,
          phase: STREAM_PHASE.RUNNING,
          cause: STREAM_TRANSITION_CAUSE.LIFECYCLE,
        },
      });
      target.session.followUps.enqueue(
        parentStreamId,
        { text: 'continue with the local calculation' },
        { force: true },
      );
      emitRunFact(target, parentStreamId, 'updateMissingOutputs', {
        streamId: parentStreamId,
        filesByRound: { 0: ['missing-output.tex'] },
      });

      await vi.waitFor(() =>
        expect(target.backend.state.activeStream).toBe(parentStreamId),
      );
      target.messages.length = 0;
      handleInteractionEvent.mockClear();

      target.session.events.emit({
        scope: 'run',
        streamId: parentStreamId,
        event: {
          type: 'stage.start',
          id: 'round-2',
          label: 'round 2',
          kind: 'round',
          index: 2,
          total: 4,
        },
      });

      target.session.events.emit({
        scope: 'run',
        streamId: parentStreamId,
        event: {
          type: 'child.activity',
          kind: 'subagents',
          parentStreamId,
          children: [child],
        },
      });

      target.session.events.emit({
        scope: 'run',
        streamId: parentStreamId,
        event: {
          type: 'child.activity',
          kind: 'processes',
          parentStreamId,
          processes: [process],
        },
      });

      target.session.events.emit({
        scope: 'session',
        event: {
          type: 'setParentStream',
          payload: {
            childStreamId,
            parentStreamId,
          },
        },
      });

      target.session.events.emit({
        scope: 'run',
        streamId: parentStreamId,
        event: {
          type: 'process.output',
          parentStreamId,
          executionId,
          stdout: 'hello',
          stderr: '',
        },
      });

      target.session.events.emit({
        scope: 'session',
        event: {
          type: 'updateQueuedFollowUps',
          payload: { streamId: parentStreamId },
        },
      });

      target.session.events.emit({
        scope: 'session',
        event: {
          type: 'clearMissingOutputs',
          payload: { streamId: parentStreamId },
        },
      });

      target.session.events.emit({
        scope: 'session',
        event: {
          type: 'inquiryThreadUpdated',
          payload: inquiryThread,
        },
      });

      expect(handleInteractionEvent).not.toHaveBeenCalled();
      expect(target.backend.state.getStreamState(parentStreamId)).toMatchObject(
        {
          roundStage: { index: 2, total: 4 },
          activeSubagents: [child],
          activeProcesses: [process],
        },
      );
      expect(
        target.backend.state.snapshots.getMissingOutputs(parentStreamId),
      ).toEqual({});
      expect(
        target.messages.some(
          (message) =>
            message.command === PROGRESS_VIEW_COMMANDS.UPDATE_INQUIRY_THREAD,
        ),
      ).toBe(true);
    } finally {
      subscription.dispose();
      await target.backend.state.clearAll();
      target.backend.dispose();
      target.session.dispose();
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

      await backend.factApplier.setStreamStatus(
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

      await backend.factApplier.setStreamStatus(
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

  it('keeps resident background entries during an in-flight status update', async () => {
    const { backend } = createRecordingBackend();
    const stream = 'background-stream' as StreamTabId;
    const releaseSpy = vi.spyOn(backend.state.streamLogs, 'releaseEntries');

    try {
      backend.state.streamLogs.ensureStream(stream);
      backend.state.updateStreamHints(stream, {
        agentCategory: AgentCategory.ToolUse,
      });
      backend.state.getOrCreateStreamState(stream, AgentCategory.ToolUse);

      await backend.factApplier.setStreamStatus(
        stream,
        STREAM_PHASE.RUNNING,
        STREAM_PHASE.RUNNING,
      );

      expect(releaseSpy).not.toHaveBeenCalled();
      expect(backend.state.streamLogs.get(stream)).toBeDefined();
    } finally {
      backend.dispose();
    }
  });

  it('drops buffered conversation progress when an existing stream re-enters running', async () => {
    vi.useFakeTimers();
    const { backend, messages } = createRecordingBackend();
    const subscription = backend.setupEventListeners();
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

      backend.factApplier.handleRunFact(stream, {
        type: 'conversation.progress',
        progress: { toolCallCount: 7 },
      });

      await backend.factApplier.setStreamStatus(
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

      await backend.factApplier.setStreamStatus(
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

  it('agrees on the resolved agentCategory across the filter, tab-render, and sync-content paths (#7583)', async () => {
    // Regression test for the config/hints agentCategory single-owner fix:
    // buildStreamInfos (matchesFilter + buildStreamTabInfo, streamInfoUtils.ts
    // / streamTabInfo.ts) and syncStreamContent (getStreamCategory,
    // ProgressFactApplier.ts) must resolve the same category from the same
    // config/hints inputs, even when hints deliberately disagree with the
    // live config.
    const { backend, messages } = createRecordingBackend();
    const stream = 'search@deepseek#de5711c' as StreamTabId;

    try {
      backend.state.streamLogs.ensureStream(stream);
      backend.state.snapshots.setTaskState(
        stream,
        toolUseTaskState('search', 'deepseekproT'),
        'de5711c' as ExecutionId,
      );
      // Stale hint disagrees with the live config on purpose — config must
      // win consistently everywhere the category is resolved.
      backend.state.updateStreamHints(stream, {
        agentCategory: AgentCategory.Workflow,
      });

      const toolUseInfos = buildStreamInfos(backend.state, 'toolUse');
      expect(toolUseInfos.map((info) => info.name)).toContain(stream);
      expect(
        toolUseInfos.find((info) => info.name === stream)?.agentCategory,
      ).toBe(AgentCategory.ToolUse);

      const workflowInfos = buildStreamInfos(backend.state, 'workflow');
      expect(workflowInfos.map((info) => info.name)).not.toContain(stream);

      backend.factApplier.syncStreamContent(stream);
      const sync = messages.find(
        (message) =>
          message.command === PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT,
      );
      expect(sync).toMatchObject({
        stream,
        action: 'render',
        agentCategory: AgentCategory.ToolUse,
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
      await GoalStore.start(stream, 'finish the cleanup');

      expect(await StorageFS.exists(`executions/${executionId}`)).toBe(true);
      expect(await StorageFS.exists(streamDataDir(stream))).toBe(true);

      await backend.state.clearStream(stream);

      expect(await StorageFS.exists(`executions/${executionId}`)).toBe(false);
      expect(await StorageFS.exists(streamDataDir(stream))).toBe(false);
      expect(GoalStore.getForStream(stream)).toBeNull();
    } finally {
      await GoalStore.forget(stream);
      await backend.state.clearAll();
      backend.dispose();
      session.dispose();
    }
  });

  it('forgets goal entries when clearing never-registered streams', async () => {
    const stream = 'tool@deepseek#missing' as StreamTabId;
    const { backend, session } = createIsolatedRecordingBackend();

    try {
      await GoalStore.start(stream, 'forget this unregistered goal');

      await backend.state.clearStream(stream);

      expect(GoalStore.getForStream(stream)).toBeNull();
    } finally {
      await GoalStore.forget(stream);
      await backend.state.clearAll();
      backend.dispose();
      session.dispose();
    }
  });

  it('clearStream refuses reserved stream ids before durable store cleanup', async () => {
    const sentinel = path.join(STREAM_DATA_DIR, 'sentinel.json');
    await StorageFS.ensureDir(STREAM_DATA_DIR);
    await StorageFS.write(sentinel, '{}');

    const { backend, session } = createIsolatedRecordingBackend();
    try {
      await backend.state.clearStream('' as StreamTabId);
      await backend.state.clearStream('.' as StreamTabId);
      await backend.state.clearStream('..' as StreamTabId);

      expect(await StorageFS.exists(sentinel)).toBe(true);
    } finally {
      await backend.state.clearAll();
      backend.dispose();
      session.dispose();
    }
  });

  it('forgets goal entries when clearing all streams', async () => {
    const stream = 'tool@deepseek#b6966b' as StreamTabId;
    const { backend, session } = createIsolatedRecordingBackend();

    try {
      backend.state.streamLogs.ensureStream(stream);
      await GoalStore.start(stream, 'clear this goal');

      await backend.state.clearAll();

      expect(GoalStore.getForStream(stream)).toBeNull();
    } finally {
      await GoalStore.forget(stream);
      await backend.state.clearAll();
      backend.dispose();
      session.dispose();
    }
  });

  it('sweeps streamData orphans without deleting standalone execution history', async () => {
    const orphanStream = 'tool@deepseek#b6966b' as StreamTabId;
    const orphanExecution = 'b6966b' as ExecutionId;
    const historyExecution = 'c6966c' as ExecutionId;

    const { backend, session } = await createPersistentRecordingBackend();
    try {
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
      await GoalStore.start(orphanStream, 'sweep this orphan');

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
      expect(GoalStore.getForStream(orphanStream)).toBeNull();
    } finally {
      await GoalStore.forget(orphanStream);
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

    const { backend, session } = await createPersistentRecordingBackend();
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

    const { backend, session } = await createPersistentRecordingBackend();
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
      const { backend, session } = await createPersistentRecordingBackend();

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
      const { backend, session } = await createPersistentRecordingBackend();

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
      const { backend, session } = await createPersistentRecordingBackend();

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
