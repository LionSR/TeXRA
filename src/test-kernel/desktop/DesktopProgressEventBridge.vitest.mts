// Suites for packages/desktop DesktopProgressEventBridge (stream routing,
// snapshot hydration, dispose guard).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentCategory,
  type RestoredStreamSnapshot,
  STREAM_PHASE,
  STREAM_STATUS,
  type StreamTabId,
} from '@shared/schemas';
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';
import { strict as assert } from 'node:assert';
import type { AgentTrace } from '@agent/trace';
import type { ProgressViewState } from '@shared/progressView/backend/state/ProgressViewState';
import {
  createDesktopProgressEventBridge,
  type DesktopProgressEventBridgeOptions,
} from '@desktop/main/desktopProgressEventBridge';

// ---------------------------------------------------------------------------
// DesktopProgressEventBridge
// ---------------------------------------------------------------------------

/**
 * Unit tests for the extracted DesktopProgressEventBridge module (issue #6329).
 *
 * Covers ghost-stream hydration, snapshot persistence, restored-display
 * sending, progress-event handling, and stream-lifecycle callbacks.
 *
 * Desktop presentation routing (requestEnsureProgressView, requestShowError)
 * and session-progress handling are tested through the bridge's public API and
 * the callbacks it invokes.
 */

// ── Test doubles ──────────────────────────────────────────────────────────

function createSnapshot(
  overrides: Partial<RestoredStreamSnapshot> &
    Pick<RestoredStreamSnapshot, 'streamId'>,
): RestoredStreamSnapshot {
  return {
    label: overrides.streamId,
    agentCategory: AgentCategory.Workflow,
    lastKnownStatus: STREAM_PHASE.COMPLETED,
    creationTimestamp: 1_000,
    persistedAt: 2_000,
    ...overrides,
  };
}

type BridgeOptions = Parameters<
  typeof import('@desktop/main/desktopProgressEventBridge').createDesktopProgressEventBridge
>[0];
type SnapshotStore = NonNullable<BridgeOptions['streamSnapshotStore']>;

function createSnapshotStore(
  overrides: Partial<SnapshotStore> = {},
): SnapshotStore {
  return {
    hydrated: [],
    upsert: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    replaceAll: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    getAll: vi.fn(() => []),
    ...overrides,
  };
}

/** Build a minimal mock `streamLogs` slice, overridable per test. */
function createStreamLogs(overrides: Record<string, any> = {}): any {
  return {
    ensureStream: vi.fn(),
    keys: () => [].values(),
    has: () => false,
    getFirstTimestamp: () => undefined,
    getLastTimestamp: () => undefined,
    ensureLoaded: vi.fn(async () => {}),
    ...overrides,
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
    streamLogs: createStreamLogs(),
    updateStreamHints: vi.fn(),
    snapshots: {
      getTaskState: vi.fn(() => undefined),
      getRunConfig: vi.fn(() => undefined),
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
  vi.doMock('@agent/runtime/StreamStatusService', () => ({
    StreamStatusService: {
      transition: vi.fn(),
      get: vi.fn(() => STREAM_PHASE.CANCELLED),
      isActiveOrResuming: vi.fn(() => false),
    },
  }));
  vi.doMock('@tools/goal', () => ({
    GoalStore: {
      getForStream: vi.fn(() => undefined),
      forget: vi.fn(async () => {}),
      forgetMany: vi.fn(async () => {}),
    },
  }));

  return import(
    moduleFileUrl(desktopSourcePath('main', 'desktopProgressEventBridge.ts'))
  ) as Promise<typeof import('@desktop/main/desktopProgressEventBridge')>;
}

// Use hoisted vi.mock for modules that need importOriginal to preserve
// schema exports (GoalStatusSchema, etc.) that other modules import.
vi.mock(import('@shared/schemas/goal'), async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/schemas/goal')>();
  return {
    ...actual,
    isGoalInFlight: vi.fn(() => false),
  };
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('DesktopProgressEventBridge', () => {
  let module: Awaited<ReturnType<typeof loadBridgeModule>>;

  beforeEach(async () => {
    module = await loadBridgeModule();
  });

  afterEach(() => {
    vi.resetModules();
  });

  function createBridge(overrides: Partial<BridgeOptions> = {}) {
    return module.createDesktopProgressEventBridge({
      state: makeMockState(),
      streamStatus: {
        get: vi.fn(() => STREAM_PHASE.CANCELLED),
        transition: vi.fn(() => true),
      },
      streamSnapshotStore: undefined,
      sendMessage: () => {},
      logger: makeLogger(),
      getActiveStream: () => '',
      routeToProgress: () => {},
      onGoalStateChanged: () => {},
      onShowError: () => {},
      ...overrides,
    });
  }

  // ── Ghost hydration ────────────────────────────────────────────────────

  describe('ghost-stream hydration', () => {
    it('hydrates ghost streams from the snapshot store on construction', () => {
      const bridge = createBridge({
        streamSnapshotStore: createSnapshotStore({
          hydrated: [
            createSnapshot({ streamId: 'ghost-1', description: 'First ghost' }),
            createSnapshot({
              streamId: 'ghost-2',
              description: 'Second ghost',
            }),
          ],
        }),
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
      const bridge = createBridge({ streamSnapshotStore: undefined });

      try {
        expect(bridge.hasRestoredStream('any')).toBe(false);
        expect(bridge.restoredStreams.size).toBe(0);
      } finally {
        bridge.dispose();
      }
    });

    it('handles empty hydrated array gracefully', () => {
      const bridge = createBridge({
        streamSnapshotStore: createSnapshotStore({ hydrated: [] }),
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

      const bridge = createBridge({
        state: makeMockState({
          streamLogs: createStreamLogs({ ensureStream }),
          updateStreamHints,
        }),
        streamSnapshotStore: createSnapshotStore({
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
        }),
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

    it('hydrates stream status through the injected session status plane', () => {
      const streamStatus = {
        get: vi.fn(() => STREAM_PHASE.CANCELLED),
        transition: vi.fn(() => true),
      };

      const bridge = createBridge({
        streamStatus,
        streamSnapshotStore: createSnapshotStore({
          hydrated: [
            createSnapshot({
              streamId: 'status-ghost',
              lastKnownStatus: STREAM_PHASE.WAITING,
            }),
          ],
        }),
      });

      try {
        expect(streamStatus.transition).toHaveBeenCalledWith(
          'status-ghost',
          STREAM_PHASE.WAITING,
          'restart-repair',
        );
      } finally {
        bridge.dispose();
      }
    });

    it('does not resurrect streams that became live in this bridge', () => {
      const ensureStream = vi.fn();
      const bridge = createBridge({
        state: makeMockState({
          streamLogs: createStreamLogs({ ensureStream }),
        }),
        streamSnapshotStore: createSnapshotStore({
          hydrated: [
            createSnapshot({ streamId: 'live-stream' }),
            createSnapshot({ streamId: 'ghost-stream' }),
          ],
        }),
      });

      try {
        expect(bridge.hasRestoredStream('live-stream')).toBe(true);
        bridge.onProgressEvent('updateStreamStatus', {
          streamId: 'live-stream',
          status: STREAM_STATUS.RUNNING,
          previousStatus: STREAM_PHASE.CANCELLED,
        });
        bridge.hydrateRestoredStreams();

        expect(bridge.hasRestoredStream('live-stream')).toBe(false);
        expect(bridge.hasRestoredStream('ghost-stream')).toBe(true);
        expect(ensureStream).toHaveBeenCalledWith('ghost-stream');
      } finally {
        bridge.dispose();
      }
    });

    it('forgets restored streams owned by active execution ids', () => {
      const bridge = createBridge({
        streamSnapshotStore: createSnapshotStore({
          hydrated: [
            createSnapshot({
              streamId: 'active-ghost',
              executionId: 'exec-active',
            }),
            createSnapshot({
              streamId: 'inactive-ghost',
              executionId: 'exec-inactive',
            }),
            createSnapshot({ streamId: 'mapped-active-ghost' }),
            createSnapshot({ streamId: 'no-exec-ghost' }),
          ],
        }),
      });

      try {
        bridge.forgetActiveRestoredStreams(
          new Set(['exec-active', 'exec-mapped-active']),
          new Map([['mapped-active-ghost', 'exec-mapped-active']]),
        );

        expect(bridge.hasRestoredStream('active-ghost')).toBe(false);
        expect(bridge.hasRestoredStream('inactive-ghost')).toBe(true);
        expect(bridge.hasRestoredStream('mapped-active-ghost')).toBe(false);
        expect(bridge.hasRestoredStream('no-exec-ghost')).toBe(true);
      } finally {
        bridge.dispose();
      }
    });
  });

  // ── Progress events ─────────────────────────────────────────────────────

  describe('onProgressEvent', () => {
    it('removes ghost and persists snapshot on setTaskState', async () => {
      const upsert = vi.fn(async () => {});

      const bridge = createBridge({
        state: makeMockState({
          streamLogs: createStreamLogs({
            has: () => true,
            getLastTimestamp: () => 3_000,
          }),
        }),
        streamSnapshotStore: createSnapshotStore({
          hydrated: [createSnapshot({ streamId: 'task-stream' })],
          upsert,
        }),
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
      const streamStatus = {
        get: vi.fn(() => STREAM_PHASE.WAITING),
        transition: vi.fn(() => true),
      };

      const bridge = createBridge({
        state: makeMockState({
          streamLogs: createStreamLogs({
            has: () => true,
            getLastTimestamp: () => 3_000,
          }),
        }),
        streamStatus,
        streamSnapshotStore: createSnapshotStore({
          hydrated: [createSnapshot({ streamId: 'status-stream' })],
          upsert,
        }),
      });

      try {
        bridge.onProgressEvent('updateStreamStatus', {
          streamId: 'status-stream',
          status: STREAM_STATUS.RUNNING,
          previousStatus: STREAM_PHASE.CANCELLED,
        });

        expect(bridge.hasRestoredStream('status-stream')).toBe(false);
        await settleMicrotasks();
        expect(upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            streamId: 'status-stream',
            lastKnownStatus: STREAM_PHASE.RUNNING,
          }),
        );
      } finally {
        bridge.dispose();
      }
    });

    it('does not throw for unknown event types', () => {
      const bridge = createBridge();

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

      const bridge = createBridge({
        state: mockState,
        sendMessage: (msg) => messages.push(msg),
        getActiveStream: () => mockState.activeStream,
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

    it('updates goal badge state from the session progress path', () => {
      const onGoalStateChanged = vi.fn();
      const bridge = createBridge({ onGoalStateChanged });

      try {
        bridge.onProgressEvent('goalStateChanged', {
          streamId: 'goal-stream',
        });

        expect(onGoalStateChanged).toHaveBeenCalledWith('goal-stream', false, {
          status: undefined,
          objective: undefined,
        });
      } finally {
        bridge.dispose();
      }
    });

    it('routes window-local ensure-progress requests from runtime-host events', () => {
      const routeToProgress = vi.fn();
      const bridge = createBridge({ routeToProgress });

      try {
        bridge.onProgressEvent('requestEnsureProgressView', {});

        expect(routeToProgress).toHaveBeenCalledTimes(1);
      } finally {
        bridge.dispose();
      }
    });

    it('routes window-local error requests from runtime-host events', () => {
      const onShowError = vi.fn();
      const bridge = createBridge({ onShowError });

      try {
        bridge.onProgressEvent('requestShowError', {
          message: 'Root run failed',
        });

        expect(onShowError).toHaveBeenCalledWith('Root run failed');
      } finally {
        bridge.dispose();
      }
    });
  });

  describe('onSessionEvent', () => {
    it('handles session stream facts without progress-event projection', async () => {
      const upsert = vi.fn(async () => {});
      const streamStatus = {
        get: vi.fn(() => STREAM_PHASE.WAITING),
        transition: vi.fn(() => true),
      };
      const bridge = createBridge({
        streamStatus,
        streamSnapshotStore: createSnapshotStore({
          hydrated: [createSnapshot({ streamId: 'fact-stream' })],
          upsert,
        }),
      });

      try {
        bridge.onSessionEvent({
          scope: 'session',
          event: {
            type: 'updateStreamStatus',
            payload: {
              streamId: 'fact-stream',
              status: STREAM_STATUS.RUNNING,
              previousStatus: STREAM_PHASE.WAITING,
            },
          },
        });

        expect(bridge.hasRestoredStream('fact-stream')).toBe(false);
        await settleMicrotasks();
        expect(upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            streamId: 'fact-stream',
            lastKnownStatus: STREAM_PHASE.RUNNING,
          }),
        );
      } finally {
        bridge.dispose();
      }
    });

    it('handles run config and status facts as live stream updates', async () => {
      const ensureStream = vi.fn();
      const upsert = vi.fn(async () => {});
      const bridge = createBridge({
        state: makeMockState({
          streamLogs: createStreamLogs({ ensureStream }),
        }),
        streamSnapshotStore: createSnapshotStore({
          hydrated: [createSnapshot({ streamId: 'run-fact-stream' })],
          upsert,
        }),
      });

      try {
        bridge.onSessionEvent({
          scope: 'run',
          streamId: 'run-fact-stream',
          event: {
            type: 'run.config',
            streamId: 'run-fact-stream',
            executionId: 'exec-run-fact',
            config: {
              agent: 'proofreader',
              model: 'deepseekproT',
              agentCategory: AgentCategory.Workflow,
            },
          } as any,
        });
        bridge.onSessionEvent({
          scope: 'run',
          streamId: 'run-fact-stream',
          event: {
            type: 'status',
            streamId: 'run-fact-stream',
            phase: STREAM_PHASE.RUNNING,
            previousPhase: STREAM_PHASE.WAITING,
            cause: 'run-start',
          } as any,
        });

        expect(ensureStream).toHaveBeenCalledWith('run-fact-stream');
        expect(bridge.hasRestoredStream('run-fact-stream')).toBe(false);
        await settleMicrotasks();
        expect(upsert).toHaveBeenCalled();
      } finally {
        bridge.dispose();
      }
    });

    it('keeps goal badge updates on direct session facts', () => {
      const onGoalStateChanged = vi.fn();
      const bridge = createBridge({ onGoalStateChanged });

      try {
        bridge.onSessionEvent({
          scope: 'session',
          event: {
            type: 'goalStateChanged',
            payload: { streamId: 'goal-fact-stream' },
          },
        });

        expect(onGoalStateChanged).toHaveBeenCalledWith(
          'goal-fact-stream',
          false,
          {
            status: undefined,
            objective: undefined,
          },
        );
      } finally {
        bridge.dispose();
      }
    });
  });

  // ── Desktop presentation events ─────────────────────────────────────────

  describe('desktop presentation events', () => {
    it('keeps routing and root-error events on the explicit runtime-host path', () => {
      const routeToProgress = vi.fn();
      const onShowError = vi.fn();
      const bridge = createBridge({
        routeToProgress,
        onShowError,
      });

      try {
        bridge.onProgressEvent('requestEnsureProgressView', {});
        bridge.onProgressEvent('requestShowError', {
          message: 'Root run failed',
        });

        expect(routeToProgress).toHaveBeenCalledTimes(1);
        expect(onShowError).toHaveBeenCalledWith('Root run failed');

        bridge.dispose();
      } finally {
        bridge.dispose();
      }
    });
  });

  // ── Stream lifecycle ─────────────────────────────────────────────────────

  describe('stream lifecycle', () => {
    it('onStreamDeleted removes ghost and calls store.remove', async () => {
      const remove = vi.fn(async () => {});

      const bridge = createBridge({
        streamSnapshotStore: createSnapshotStore({
          hydrated: [createSnapshot({ streamId: 'delete-me' })],
          remove,
        }),
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

      const bridge = createBridge({
        streamSnapshotStore: createSnapshotStore({
          hydrated: [
            createSnapshot({ streamId: 'ghost-a' }),
            createSnapshot({ streamId: 'ghost-b' }),
          ],
          replaceAll,
        }),
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
      const bridge = createBridge();

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

      const bridge = createBridge({
        state: mockState,
        streamSnapshotStore: createSnapshotStore({
          hydrated: [createSnapshot({ streamId: 'ghost-display' })],
        }),
        sendMessage: (msg) => messages.push(msg),
        getActiveStream: () => 'ghost-display',
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

      const bridge = createBridge({
        sendMessage: (msg) => messages.push(msg),
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

      const bridge = createBridge({
        state: mockState,
        streamSnapshotStore: createSnapshotStore({
          hydrated: [createSnapshot({ streamId: 'ghost-once' })],
        }),
        sendMessage: (msg) => messages.push(msg),
        getActiveStream: () => 'ghost-once',
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
      const bridge = createBridge();

      bridge.dispose();
      expect(() => bridge.dispose()).not.toThrow();
    });

    it('is safe to call methods after dispose', () => {
      const bridge = createBridge();

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

      const bridge = createBridge({
        state: mockState,
        streamSnapshotStore: createSnapshotStore({
          hydrated: [createSnapshot({ streamId: 'ghost-pending' })],
        }),
        sendMessage: (msg) => messages.push(msg),
        getActiveStream: () => 'ghost-pending',
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

// ---------------------------------------------------------------------------
// desktopProgressEventBridge
// ---------------------------------------------------------------------------

/**
 * Regression test for #7377: a headless run can keep the owning bridge's
 * `hostChannel.emit` closure after the desktop window closed and the bridge was
 * disposed. Events delivered through that second route (the one #7372 left
 * unguarded) must no-op — they must not re-route the renderer, re-show root
 * errors, or otherwise touch torn-down state.
 */
function makeBridge() {
  const calls = { showError: [] as string[], routeToProgress: 0 };
  const options: DesktopProgressEventBridgeOptions = {
    // Only the requestShowError / requestEnsureProgressView paths are exercised;
    // neither dereferences `state`, and with no snapshot store constructor-time
    // hydration is a no-op, so a cast placeholder is sufficient here.
    state: {} as ProgressViewState,
    streamStatus: { get: () => undefined, transition: () => false },
    streamSnapshotStore: undefined,
    sendMessage: () => undefined,
    logger: { warn: () => undefined } as unknown as AgentTrace,
    getActiveStream: () => '',
    routeToProgress: () => {
      calls.routeToProgress += 1;
    },
    onGoalStateChanged: () => undefined,
    onShowError: (message) => {
      calls.showError.push(message);
    },
  };
  return { bridge: createDesktopProgressEventBridge(options), calls };
}

describe('DesktopProgressEventBridge dispose guard (#7377)', () => {
  it('routes events before dispose', () => {
    const { bridge, calls } = makeBridge();

    bridge.onProgressEvent('requestShowError', { message: 'boom' });
    bridge.onProgressEvent('requestEnsureProgressView', {});

    assert.deepEqual(calls.showError, ['boom']);
    assert.equal(calls.routeToProgress, 1);
  });

  it('no-ops progress events delivered after dispose', () => {
    const { bridge, calls } = makeBridge();

    bridge.dispose();

    assert.doesNotThrow(() => {
      bridge.onProgressEvent('requestShowError', { message: 'after-dispose' });
      bridge.onProgressEvent('requestEnsureProgressView', {});
    });

    assert.deepEqual(calls.showError, []);
    assert.equal(calls.routeToProgress, 0);
  });
});
