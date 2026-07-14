// Suites for packages/desktop DesktopSessionProgressBridge (stream routing,
// snapshot hydration, dispose guard).

import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTrace } from '@agent/trace';
import {
  createDesktopSessionProgressBridge,
  type DesktopSessionProgressBridgeOptions,
} from '@desktop/main/desktopSessionProgressBridge';
import {
  AgentCategory,
  type RestoredStreamSnapshot,
  STREAM_PHASE,
  STREAM_STATUS,
  type StreamTabId,
} from '@shared/schemas';
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';
import type { ProgressViewState } from '@controllers/progressView/backend/state/ProgressViewState';

// ---------------------------------------------------------------------------
// DesktopSessionProgressBridge
// ---------------------------------------------------------------------------

/**
 * Unit tests for the extracted DesktopSessionProgressBridge module (issue #6329).
 *
 * Covers ghost-stream hydration, snapshot persistence, restored-display
 * sending, presentation-event handling, and stream-lifecycle callbacks.
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
  typeof import('@desktop/main/desktopSessionProgressBridge').createDesktopSessionProgressBridge
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
  typeof import('@desktop/main/desktopSessionProgressBridge')
> {
  vi.resetModules();
  vi.doMock('@tools/goal', () => ({
    GoalStore: {
      getForStream: vi.fn(() => undefined),
      forget: vi.fn(async () => {}),
      forgetMany: vi.fn(async () => {}),
    },
  }));

  return import(
    moduleFileUrl(desktopSourcePath('main', 'desktopSessionProgressBridge.ts'))
  ) as Promise<typeof import('@desktop/main/desktopSessionProgressBridge')>;
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

describe('DesktopSessionProgressBridge', () => {
  let module: Awaited<ReturnType<typeof loadBridgeModule>>;

  beforeEach(async () => {
    module = await loadBridgeModule();
  });

  afterEach(() => {
    vi.resetModules();
  });

  function createBridge(overrides: Partial<BridgeOptions> = {}) {
    return module.createDesktopSessionProgressBridge({
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
        bridge.handleSessionEvent({
          scope: 'run',
          streamId: 'live-stream',
          event: {
            type: 'status',
            streamId: 'live-stream',
            phase: STREAM_PHASE.RUNNING,
            previousPhase: STREAM_PHASE.CANCELLED,
            cause: 'run-start',
          } as any,
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

  // ── Presentation events ─────────────────────────────────────────────────

  describe('handlePresentationEvent', () => {
    it('routes window-local ensure-progress requests from runtime-host events', () => {
      const routeToProgress = vi.fn();
      const bridge = createBridge({ routeToProgress });

      try {
        bridge.handlePresentationEvent('requestEnsureProgressView', {});

        expect(routeToProgress).toHaveBeenCalledTimes(1);
      } finally {
        bridge.dispose();
      }
    });

    it('routes window-local error requests from runtime-host events', () => {
      const onShowError = vi.fn();
      const bridge = createBridge({ onShowError });

      try {
        bridge.handlePresentationEvent('requestShowError', {
          message: 'Root run failed',
        });

        expect(onShowError).toHaveBeenCalledWith('Root run failed');
      } finally {
        bridge.dispose();
      }
    });

    it('folds requestShowInstruction into the same dialog surface as requestShowError', () => {
      const onShowError = vi.fn();
      const bridge = createBridge({ onShowError });

      try {
        bridge.handlePresentationEvent('requestShowInstruction', {
          key: 'missingApiKey',
          message:
            'API key not found. Set your API key in Settings and run again.',
          actions: ['set-api-key', 'open-configuration-guide'],
          showSuppress: false,
        });

        expect(onShowError).toHaveBeenCalledTimes(1);
        expect(onShowError).toHaveBeenCalledWith(
          'API key not found. Set your API key in Settings and run again.',
        );
      } finally {
        bridge.dispose();
      }
    });
  });

  describe('handleSessionEvent', () => {
    it('handles session stream facts without presentation-event projection', async () => {
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
        bridge.handleSessionEvent({
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
        bridge.handleSessionEvent({
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
        bridge.handleSessionEvent({
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
        bridge.handleSessionEvent({
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
        bridge.handlePresentationEvent('requestEnsureProgressView', {});
        bridge.handlePresentationEvent('requestShowError', {
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
      bridge.handlePresentationEvent('requestShowError', {
        message: 'test',
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
// desktopSessionProgressBridge
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
  const options: DesktopSessionProgressBridgeOptions = {
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
  return { bridge: createDesktopSessionProgressBridge(options), calls };
}

describe('DesktopSessionProgressBridge dispose guard (#7377)', () => {
  it('routes events before dispose', () => {
    const { bridge, calls } = makeBridge();

    bridge.handlePresentationEvent('requestShowError', { message: 'boom' });
    bridge.handlePresentationEvent('requestEnsureProgressView', {});

    assert.deepEqual(calls.showError, ['boom']);
    assert.equal(calls.routeToProgress, 1);
  });

  it('no-ops presentation events delivered after dispose', () => {
    const { bridge, calls } = makeBridge();

    bridge.dispose();

    assert.doesNotThrow(() => {
      bridge.handlePresentationEvent('requestShowError', {
        message: 'after-dispose',
      });
      bridge.handlePresentationEvent('requestEnsureProgressView', {});
    });

    assert.deepEqual(calls.showError, []);
    assert.equal(calls.routeToProgress, 0);
  });
});
