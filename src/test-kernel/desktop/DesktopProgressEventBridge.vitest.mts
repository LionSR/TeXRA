/**
 * Unit tests for the extracted DesktopProgressEventBridge module (issue #6329).
 *
 * Covers ghost-stream hydration, snapshot persistence, restored-display
 * sending, progress-event handling, and stream-lifecycle callbacks.
 *
 * Event-bus wiring (goalStateChanged, requestEnsureProgressView,
 * requestShowError) is tested indirectly through the bridge's public
 * API and the callbacks it invokes.
 */

// Node imports
import { readFileSync } from 'node:fs';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import {
  AgentCategory,
  STREAM_STATUS,
  type RestoredStreamSnapshot,
  type StreamTabId,
} from '@shared/schemas';

// Local imports - desktop test paths
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

// ── Test doubles ──────────────────────────────────────────────────────────

function createSnapshot(
  overrides: Partial<RestoredStreamSnapshot> &
    Pick<RestoredStreamSnapshot, 'streamId'>,
): RestoredStreamSnapshot {
  return {
    label: overrides.streamId,
    agentCategory: AgentCategory.Workflow,
    lastKnownStatus: STREAM_STATUS.STOPPED,
    creationTimestamp: 1_000,
    persistedAt: 2_000,
    ...overrides,
  };
}

interface TestSnapshotStore {
  hydrated: readonly RestoredStreamSnapshot[];
  upsertCalls: RestoredStreamSnapshot[];
  removeCalls: StreamTabId[];
  replaceAllCalls: RestoredStreamSnapshot[][];
}

function createTestSnapshotStore(
  hydrated: RestoredStreamSnapshot[] = [],
): TestSnapshotStore {
  return {
    hydrated,
    upsertCalls: [],
    removeCalls: [],
    replaceAllCalls: [],
  };
}

/**
 * Build a minimal mock state object.  We use `as any` because the real
 * ProgressViewState is a large, deeply-typed class and we only need a
 * tiny slice of its surface for these tests.
 */
function makeMockState(overrides: Record<string, any> = {}): any {
  return {
    activeStream: '',
    streamLogs: {
      ensureStream: vi.fn(),
      keys: () => [].values(),
      has: () => false,
      getFirstTimestamp: () => undefined,
      getLastTimestamp: () => undefined,
      ensureLoaded: vi.fn(async () => {}),
    },
    updateStreamHints: vi.fn(),
    snapshots: {
      getTaskState: vi.fn(() => undefined),
      getExecutionId: vi.fn(() => undefined),
      getParentStreamId: vi.fn(() => undefined),
      getDescription: vi.fn(() => undefined),
      getOutputFiles: vi.fn(() => new Map()),
      setTaskState: vi.fn(),
      read: vi.fn(async () => ({})),
    },
    getStreamHints: vi.fn(() => ({})),
    ...overrides,
  };
}

/** A minimal logger that satisfies the consumed surface of AgentTrace. */
function makeLogger(): any {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeRuntimeStatus(): any {
  return {
    get: vi.fn(() => STREAM_STATUS.STOPPED),
    setSilently: vi.fn(),
  };
}

function makeGoalControls(): any {
  return {
    getControlState: vi.fn(() => ({ active: false })),
  };
}

function settleMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

// ── Module loading ────────────────────────────────────────────────────────

async function loadBridgeModule(): Promise<
  typeof import('@desktop/main/desktopProgressEventBridge')
> {
  vi.resetModules();
  vi.doMock('@logger', () => ({
    createChannelTrace: () => makeLogger(),
    setDefaultStreamLogStore: () => {},
  }));
  vi.doMock('@eventBus/ProgressEventBus', () => ({
    bus: {
      on: vi.fn(() => () => undefined),
      emit: vi.fn(),
    },
  }));

  return import(
    moduleFileUrl(desktopSourcePath('main', 'desktopProgressEventBridge.ts'))
  ) as Promise<typeof import('@desktop/main/desktopProgressEventBridge')>;
}

type BridgeModule = Awaited<ReturnType<typeof loadBridgeModule>>;
type BridgeOptions = Parameters<
  BridgeModule['createDesktopProgressEventBridge']
>[0];

function createBridge(
  module: BridgeModule,
  options: Omit<BridgeOptions, 'runtimeStatus' | 'goalControls'> &
    Partial<Pick<BridgeOptions, 'runtimeStatus' | 'goalControls'>>,
) {
  const { runtimeStatus, goalControls, ...rest } = options;
  return module.createDesktopProgressEventBridge({
    ...rest,
    runtimeStatus: runtimeStatus ?? makeRuntimeStatus(),
    goalControls: goalControls ?? makeGoalControls(),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('DesktopProgressEventBridge', () => {
  let module: BridgeModule;

  beforeEach(async () => {
    module = await loadBridgeModule();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('keeps stream snapshot projection out of the desktop bridge', () => {
    const source = readFileSync(
      desktopSourcePath('main', 'desktopProgressEventBridge.ts'),
      'utf8',
    );

    expect(source).toContain('buildRestoredStreamSnapshot');
    expect(source).not.toContain('buildStreamInfo(');
  });

  // ── Ghost hydration ────────────────────────────────────────────────────

  describe('ghost-stream hydration', () => {
    it('hydrates ghost streams from the snapshot store on construction', () => {
      const store = createTestSnapshotStore([
        createSnapshot({ streamId: 'ghost-1', description: 'First ghost' }),
        createSnapshot({ streamId: 'ghost-2', description: 'Second ghost' }),
      ]);

      const bridge = createBridge(module, {
        state: makeMockState(),
        streamSnapshotStore: {
          hydrated: store.hydrated,
          upsert: vi.fn(async (snapshot) => {
            store.upsertCalls.push(snapshot);
          }),
          remove: vi.fn(async (streamId) => {
            store.removeCalls.push(streamId);
          }),
          replaceAll: vi.fn(async (snapshots) => {
            store.replaceAllCalls.push(snapshots);
          }),
          getAll: vi.fn(() => []),
        },
        sendMessage: () => {},
        logger: makeLogger(),
        getActiveStream: () => '',
        routeToProgress: () => {},
        onGoalStateChanged: () => {},
        onShowError: () => {},
      });

      try {
        expect(bridge.hasRestoredStream('ghost-1')).toBe(true);
        expect(bridge.hasRestoredStream('ghost-2')).toBe(true);
        expect(bridge.hasRestoredStream('ghost-3')).toBe(false);
        expect(bridge.restoredStreams.size).toBe(2);
      } finally {
        bridge.dispose();
      }
    });

    it('handles missing snapshot store gracefully', () => {
      const bridge = createBridge(module, {
        state: makeMockState(),
        streamSnapshotStore: undefined,
        sendMessage: () => {},
        logger: makeLogger(),
        getActiveStream: () => '',
        routeToProgress: () => {},
        onGoalStateChanged: () => {},
        onShowError: () => {},
      });

      try {
        expect(bridge.hasRestoredStream('any')).toBe(false);
        expect(bridge.restoredStreams.size).toBe(0);
      } finally {
        bridge.dispose();
      }
    });

    it('handles empty hydrated array gracefully', () => {
      const store = createTestSnapshotStore([]);

      const bridge = createBridge(module, {
        state: makeMockState(),
        streamSnapshotStore: {
          hydrated: store.hydrated,
          upsert: vi.fn(async () => {}),
          remove: vi.fn(async () => {}),
          replaceAll: vi.fn(async () => {}),
          getAll: vi.fn(() => []),
        },
        sendMessage: () => {},
        logger: makeLogger(),
        getActiveStream: () => '',
        routeToProgress: () => {},
        onGoalStateChanged: () => {},
        onShowError: () => {},
      });

      try {
        expect(bridge.hasRestoredStream('empty')).toBe(false);
        expect(bridge.restoredStreams.size).toBe(0);
      } finally {
        bridge.dispose();
      }
    });

    it('seeds stream hints and log entries from the snapshot', () => {
      const ensureStream = vi.fn();
      const updateStreamHints = vi.fn();

      const bridge = createBridge(module, {
        state: makeMockState({
          streamLogs: {
            ensureStream,
            keys: () => [].values(),
            has: () => false,
            getLastTimestamp: () => undefined,
            ensureLoaded: vi.fn(async () => {}),
          },
          updateStreamHints,
        }),
        streamSnapshotStore: {
          hydrated: [
            createSnapshot({
              streamId: 'ghost-seeded',
              agent: 'proofreader',
              inputFile: 'paper.tex',
              creationTimestamp: 5_000,
              executionId: 'exec-123' as StreamTabId,
              parentStreamId: 'parent-456' as StreamTabId,
              description: 'A seeded ghost',
            }),
          ],
          upsert: vi.fn(async () => {}),
          remove: vi.fn(async () => {}),
          replaceAll: vi.fn(async () => {}),
          getAll: vi.fn(() => []),
        },
        sendMessage: () => {},
        logger: makeLogger(),
        getActiveStream: () => '',
        routeToProgress: () => {},
        onGoalStateChanged: () => {},
        onShowError: () => {},
      });

      try {
        expect(ensureStream).toHaveBeenCalledWith('ghost-seeded');
        expect(updateStreamHints).toHaveBeenCalledWith('ghost-seeded', {
          agent: 'proofreader',
          agentCategory: AgentCategory.Workflow,
          inputFile: 'paper.tex',
          creationTimestamp: 5_000,
          executionId: 'exec-123',
          parentStreamId: 'parent-456',
          description: 'A seeded ghost',
        });
      } finally {
        bridge.dispose();
      }
    });

    it('seeds runtime status from hydrated snapshots', () => {
      const runtimeStatus = makeRuntimeStatus();

      const bridge = createBridge(module, {
        state: makeMockState(),
        runtimeStatus,
        streamSnapshotStore: {
          hydrated: [
            createSnapshot({
              streamId: 'ghost-running',
              lastKnownStatus: STREAM_STATUS.RUNNING,
            }),
            createSnapshot({
              streamId: 'ghost-waiting',
              lastKnownStatus: STREAM_STATUS.WAITING,
            }),
          ],
          upsert: vi.fn(async () => {}),
          remove: vi.fn(async () => {}),
          replaceAll: vi.fn(async () => {}),
          getAll: vi.fn(() => []),
        },
        sendMessage: () => {},
        logger: makeLogger(),
        getActiveStream: () => '',
        routeToProgress: () => {},
        onGoalStateChanged: () => {},
        onShowError: () => {},
      });

      try {
        expect(runtimeStatus.setSilently).toHaveBeenCalledWith(
          'ghost-running',
          STREAM_STATUS.RUNNING,
        );
        expect(runtimeStatus.setSilently).toHaveBeenCalledWith(
          'ghost-waiting',
          STREAM_STATUS.WAITING,
        );
      } finally {
        bridge.dispose();
      }
    });
  });

  // ── Progress events ─────────────────────────────────────────────────────

  describe('onProgressEvent', () => {
    it('removes ghost and persists snapshot on setTaskState', async () => {
      const upsert = vi.fn(async () => {});
      const store = createTestSnapshotStore([
        createSnapshot({ streamId: 'task-stream' }),
      ]);

      const bridge = createBridge(module, {
        state: makeMockState({
          streamLogs: {
            ensureStream: vi.fn(),
            keys: () => [].values(),
            has: () => true,
            getFirstTimestamp: () => undefined,
            getLastTimestamp: () => 3_000,
            ensureLoaded: vi.fn(async () => {}),
          },
        }),
        streamSnapshotStore: {
          hydrated: store.hydrated,
          upsert,
          remove: vi.fn(async () => {}),
          replaceAll: vi.fn(async () => {}),
          getAll: vi.fn(() => []),
        },
        sendMessage: () => {},
        logger: makeLogger(),
        getActiveStream: () => '',
        routeToProgress: () => {},
        onGoalStateChanged: () => {},
        onShowError: () => {},
      });

      try {
        expect(bridge.hasRestoredStream('task-stream')).toBe(true);

        bridge.onProgressEvent('setTaskState', {
          streamId: 'task-stream',
          taskState: undefined as any,
        });

        expect(bridge.hasRestoredStream('task-stream')).toBe(false);
        await settleMicrotasks();
        expect(upsert).toHaveBeenCalled();
      } finally {
        bridge.dispose();
      }
    });

    it('removes ghost and persists snapshot on updateStreamStatus', async () => {
      const upsert = vi.fn(async () => {});
      const runtimeStatus = makeRuntimeStatus();
      runtimeStatus.get.mockReturnValue(STREAM_STATUS.RUNNING);
      const store = createTestSnapshotStore([
        createSnapshot({ streamId: 'status-stream' }),
      ]);

      const bridge = createBridge(module, {
        state: makeMockState({
          streamLogs: {
            ensureStream: vi.fn(),
            keys: () => [].values(),
            has: () => true,
            getFirstTimestamp: () => undefined,
            getLastTimestamp: () => 3_000,
            ensureLoaded: vi.fn(async () => {}),
          },
        }),
        runtimeStatus,
        streamSnapshotStore: {
          hydrated: store.hydrated,
          upsert,
          remove: vi.fn(async () => {}),
          replaceAll: vi.fn(async () => {}),
          getAll: vi.fn(() => []),
        },
        sendMessage: () => {},
        logger: makeLogger(),
        getActiveStream: () => '',
        routeToProgress: () => {},
        onGoalStateChanged: () => {},
        onShowError: () => {},
      });

      try {
        bridge.onProgressEvent('updateStreamStatus', {
          streamId: 'status-stream',
          status: STREAM_STATUS.RUNNING,
          previousStatus: STREAM_STATUS.STOPPED,
        });

        expect(bridge.hasRestoredStream('status-stream')).toBe(false);
        await settleMicrotasks();
        expect(upsert).toHaveBeenCalled();
        expect(upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            streamId: 'status-stream',
            lastKnownStatus: STREAM_STATUS.RUNNING,
          }),
        );
      } finally {
        bridge.dispose();
      }
    });

    it('does not throw for unknown event types', () => {
      const bridge = createBridge(module, {
        state: makeMockState(),
        streamSnapshotStore: undefined,
        sendMessage: () => {},
        logger: makeLogger(),
        getActiveStream: () => '',
        routeToProgress: () => {},
        onGoalStateChanged: () => {},
        onShowError: () => {},
      });

      try {
        expect(() =>
          bridge.onProgressEvent('unknownEvent' as any, {
            streamId: 'test',
          }),
        ).not.toThrow();
      } finally {
        bridge.dispose();
      }
    });

    it('clears active stream when setActiveStream has empty streamId', () => {
      const messages: unknown[] = [];
      const mockState = makeMockState();
      mockState.activeStream = 'previous-stream';

      const bridge = createBridge(module, {
        state: mockState,
        streamSnapshotStore: undefined,
        sendMessage: (msg) => messages.push(msg),
        logger: makeLogger(),
        getActiveStream: () => mockState.activeStream,
        routeToProgress: () => {},
        onGoalStateChanged: () => {},
        onShowError: () => {},
      });

      try {
        bridge.onProgressEvent('setActiveStream', {
          streamId: '',
          suppressViewSwitch: true,
        });

        expect(mockState.activeStream).toBe('');
        expect(messages).toContainEqual({
          command: 'setActiveStream',
          activeStream: '',
        });
      } finally {
        bridge.dispose();
      }
    });
  });

  // ── Stream lifecycle ─────────────────────────────────────────────────────

  describe('stream lifecycle', () => {
    it('onStreamDeleted removes ghost and calls store.remove', async () => {
      const remove = vi.fn(async () => {});
      const store = createTestSnapshotStore([
        createSnapshot({ streamId: 'delete-me' }),
      ]);

      const bridge = createBridge(module, {
        state: makeMockState(),
        streamSnapshotStore: {
          hydrated: store.hydrated,
          upsert: vi.fn(async () => {}),
          remove,
          replaceAll: vi.fn(async () => {}),
          getAll: vi.fn(() => []),
        },
        sendMessage: () => {},
        logger: makeLogger(),
        getActiveStream: () => '',
        routeToProgress: () => {},
        onGoalStateChanged: () => {},
        onShowError: () => {},
      });

      try {
        expect(bridge.hasRestoredStream('delete-me')).toBe(true);
        bridge.onStreamDeleted('delete-me');
        expect(bridge.hasRestoredStream('delete-me')).toBe(false);
        await settleMicrotasks();
        expect(remove).toHaveBeenCalledWith('delete-me');
      } finally {
        bridge.dispose();
      }
    });

    it('onAllStreamsDeleted clears all ghosts', async () => {
      const replaceAll = vi.fn(async () => {});
      const store = createTestSnapshotStore([
        createSnapshot({ streamId: 'ghost-a' }),
        createSnapshot({ streamId: 'ghost-b' }),
      ]);

      const bridge = createBridge(module, {
        state: makeMockState(),
        streamSnapshotStore: {
          hydrated: store.hydrated,
          upsert: vi.fn(async () => {}),
          remove: vi.fn(async () => {}),
          replaceAll,
          getAll: vi.fn(() => []),
        },
        sendMessage: () => {},
        logger: makeLogger(),
        getActiveStream: () => '',
        routeToProgress: () => {},
        onGoalStateChanged: () => {},
        onShowError: () => {},
      });

      try {
        await bridge.onAllStreamsDeleted();
        expect(bridge.hasRestoredStream('ghost-a')).toBe(false);
        expect(bridge.hasRestoredStream('ghost-b')).toBe(false);
        expect(replaceAll).toHaveBeenCalledWith([]);
      } finally {
        bridge.dispose();
      }
    });

    it('onAllStreamsDeleted is safe with no snapshot store', async () => {
      const bridge = createBridge(module, {
        state: makeMockState(),
        streamSnapshotStore: undefined,
        sendMessage: () => {},
        logger: makeLogger(),
        getActiveStream: () => '',
        routeToProgress: () => {},
        onGoalStateChanged: () => {},
        onShowError: () => {},
      });

      try {
        await expect(bridge.onAllStreamsDeleted()).resolves.toBeUndefined();
      } finally {
        bridge.dispose();
      }
    });
  });

  // ── Restored display ─────────────────────────────────────────────────────

  describe('sendRestoredDisplay', () => {
    it('restores display data for a ghost stream', async () => {
      const messages: unknown[] = [];
      const plan = 'Test plan';
      const mockState = makeMockState();
      mockState.activeStream = 'ghost-display';
      mockState.snapshots.read.mockResolvedValue({
        todos: [
          { content: 'Test todo', status: 'pending', activeForm: 'Testing' },
        ],
        plan,
        runUsage: { 'run-1': { inputTokens: 10, outputTokens: 5, cost: 0.01 } },
        outputFilesByRound: {
          '1': [{ source: 'test.tex', round: 1 }],
        },
        missingOutputsByRound: {},
        compileFailuresByRound: {},
      });

      const bridge = createBridge(module, {
        state: mockState,
        streamSnapshotStore: {
          hydrated: [createSnapshot({ streamId: 'ghost-display' })],
          upsert: vi.fn(async () => {}),
          remove: vi.fn(async () => {}),
          replaceAll: vi.fn(async () => {}),
          getAll: vi.fn(() => []),
        },
        sendMessage: (msg) => messages.push(msg),
        logger: makeLogger(),
        getActiveStream: () => 'ghost-display',
        routeToProgress: () => {},
        onGoalStateChanged: () => {},
        onShowError: () => {},
      });

      try {
        bridge.sendRestoredDisplay('ghost-display');
        await settleMicrotasks();

        expect(mockState.snapshots.read).toHaveBeenCalledWith('ghost-display');
        expect(messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              command: 'updateTodos',
              stream: 'ghost-display',
            }),
            expect.objectContaining({
              command: 'updatePlan',
              stream: 'ghost-display',
            }),
            expect.objectContaining({
              command: 'updateRunUsage',
              stream: 'ghost-display',
              runId: 'run-1',
            }),
            expect.objectContaining({
              command: 'updateFiles',
              stream: 'ghost-display',
            }),
          ]),
        );
      } finally {
        bridge.dispose();
      }
    });

    it('is a no-op for unknown stream ids', () => {
      const messages: unknown[] = [];

      const bridge = createBridge(module, {
        state: makeMockState(),
        streamSnapshotStore: undefined,
        sendMessage: (msg) => messages.push(msg),
        logger: makeLogger(),
        getActiveStream: () => '',
        routeToProgress: () => {},
        onGoalStateChanged: () => {},
        onShowError: () => {},
      });

      try {
        bridge.sendRestoredDisplay('unknown-stream');
        expect(messages).toHaveLength(0);
      } finally {
        bridge.dispose();
      }
    });

    it('deduplicates display restores', async () => {
      const messages: unknown[] = [];
      const mockState = makeMockState();
      mockState.activeStream = 'ghost-once';
      mockState.snapshots.read.mockResolvedValue({
        todos: [
          { content: 'Already sent', status: 'pending', activeForm: 'Testing' },
        ],
        plan: 'Already sent',
        runUsage: {},
        outputFilesByRound: {},
        missingOutputsByRound: {},
        compileFailuresByRound: {},
      });

      const bridge = createBridge(module, {
        state: mockState,
        streamSnapshotStore: {
          hydrated: [createSnapshot({ streamId: 'ghost-once' })],
          upsert: vi.fn(async () => {}),
          remove: vi.fn(async () => {}),
          replaceAll: vi.fn(async () => {}),
          getAll: vi.fn(() => []),
        },
        sendMessage: (msg) => messages.push(msg),
        logger: makeLogger(),
        getActiveStream: () => 'ghost-once',
        routeToProgress: () => {},
        onGoalStateChanged: () => {},
        onShowError: () => {},
      });

      try {
        bridge.sendRestoredDisplay('ghost-once');
        await settleMicrotasks();

        const firstReadCount = mockState.snapshots.read.mock.calls.length;
        messages.length = 0;

        // Second call should be a no-op
        bridge.sendRestoredDisplay('ghost-once');
        await settleMicrotasks();
        expect(mockState.snapshots.read).toHaveBeenCalledTimes(firstReadCount);
        expect(messages).toHaveLength(0);
      } finally {
        bridge.dispose();
      }
    });
  });

  // ── Dispose ──────────────────────────────────────────────────────────────

  describe('dispose', () => {
    it('does not throw on double dispose', () => {
      const bridge = createBridge(module, {
        state: makeMockState(),
        streamSnapshotStore: undefined,
        sendMessage: () => {},
        logger: makeLogger(),
        getActiveStream: () => '',
        routeToProgress: () => {},
        onGoalStateChanged: () => {},
        onShowError: () => {},
      });

      bridge.dispose();
      expect(() => bridge.dispose()).not.toThrow();
    });

    it('is safe to call methods after dispose', () => {
      const bridge = createBridge(module, {
        state: makeMockState(),
        streamSnapshotStore: undefined,
        sendMessage: () => {},
        logger: makeLogger(),
        getActiveStream: () => '',
        routeToProgress: () => {},
        onGoalStateChanged: () => {},
        onShowError: () => {},
      });

      bridge.dispose();

      // These should not throw
      bridge.onProgressEvent('setTaskState', {
        streamId: 'test',
        taskState: undefined as any,
      });
      bridge.onStreamDeleted('test');
      bridge.sendRestoredDisplay('test');
    });

    it('suppresses pending restored display sends after dispose', async () => {
      const messages: unknown[] = [];
      let resolveRead: (value: unknown) => void = () => {};
      const mockState = makeMockState();
      mockState.activeStream = 'ghost-pending';
      mockState.snapshots.read.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRead = resolve;
          }),
      );

      const bridge = createBridge(module, {
        state: mockState,
        streamSnapshotStore: {
          hydrated: [createSnapshot({ streamId: 'ghost-pending' })],
          upsert: vi.fn(async () => {}),
          remove: vi.fn(async () => {}),
          replaceAll: vi.fn(async () => {}),
          getAll: vi.fn(() => []),
        },
        sendMessage: (msg) => messages.push(msg),
        logger: makeLogger(),
        getActiveStream: () => 'ghost-pending',
        routeToProgress: () => {},
        onGoalStateChanged: () => {},
        onShowError: () => {},
      });

      bridge.sendRestoredDisplay('ghost-pending');
      bridge.dispose();
      resolveRead({
        todos: [],
        plan: null,
        runUsage: {},
        outputFilesByRound: {},
        missingOutputsByRound: {},
        compileFailuresByRound: {},
      });
      await settleMicrotasks();

      expect(bridge.hasRestoredStream('ghost-pending')).toBe(false);
      expect(messages).toHaveLength(0);
    });
  });
});
