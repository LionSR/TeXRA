// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Test support imports
import { createTestSession } from '@test/support/sessionTestUtils';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resumeToolUseFromSnapshotMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
);

vi.mock('@agent/runtime/executeAgent', () => ({
  resumeToolUseFromSnapshot: resumeToolUseFromSnapshotMock,
}));

import {
  clearStreamStatusForTest,
  seedStreamStatusForTest,
} from '@test/helpers/streamStatusTestUtils';
import { resumeQueuedToolUseSnapshot } from '@agent/runtime/resumeQueuedToolUse';
import { defaultSession } from '@agent/runtime/SessionHandle';
import type { FollowUpQueueInput } from '@agent/followUp/FollowUpQueue';
import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import {
  RUN_OUTCOME,
  STREAM_PHASE,
  STREAM_STATUS,
  type StreamTabId,
} from '@shared/schemas';
import { recordSessionEvents, sessionFactPayloads } from '../progressTestUtils';

const STREAM = 'stream:tooluse-resume' as StreamTabId;
const runtimeHost = { emit: vi.fn() };
let recordedSession: ReturnType<typeof recordSessionEvents> | undefined;

function snapshot(parentStreamId?: StreamTabId): ToolUseSessionSnapshot {
  return { streamId: STREAM, parentStreamId } as ToolUseSessionSnapshot;
}

interface CapturedResumeOptions {
  parentStreamId?: StreamTabId;
  isCancellationRequested?: () => boolean;
  drainedFollowUps?: readonly FollowUpQueueInput[];
  takePendingFollowUps: () => readonly FollowUpQueueInput[];
  onFollowUpConsumed?: () => void;
  onCancellationAtFlowAttachment?: () => void;
}

function capturedResumeOptions(): CapturedResumeOptions {
  const calls = resumeToolUseFromSnapshotMock.mock
    .calls as unknown as unknown[][];
  return calls.at(-1)?.[2] as CapturedResumeOptions;
}

/** Capture the callback that closes the queue gap at flow attachment. */
function capturedTakePendingFollowUps(): () => readonly FollowUpQueueInput[] {
  const options = capturedResumeOptions();
  return options.takePendingFollowUps;
}

describe('resumeQueuedToolUseSnapshot', () => {
  beforeEach(() => {
    resumeToolUseFromSnapshotMock.mockReset();
    resumeToolUseFromSnapshotMock.mockImplementation(
      async (...args: unknown[]) => {
        const options = args[2] as CapturedResumeOptions;
        options.onFollowUpConsumed?.();
        return undefined;
      },
    );
    runtimeHost.emit.mockReset();
    recordedSession = recordSessionEvents(defaultSession().events, {
      scope: 'session',
    });
  });

  afterEach(() => {
    recordedSession?.detach();
    recordedSession = undefined;
    defaultSession().followUps.release(STREAM);
    clearStreamStatusForTest(defaultSession().status, STREAM);
  });

  it('drains queued follow-ups, hands them to the flow, and notifies the UI', async () => {
    defaultSession().followUps.enqueue(
      STREAM,
      { text: 'queued one' },
      { force: true },
    );

    await expect(
      resumeQueuedToolUseSnapshot(STREAM, snapshot(), runtimeHost, {
        onError: vi.fn(),
      }),
    ).resolves.toBe(true);

    // The initial batch travels via the direct drainedFollowUps handoff (a
    // subagent's WAITING cursor never reads the stream queue). The attachment
    // drain supplies any item that arrived before the live context existed.
    expect(capturedResumeOptions().drainedFollowUps).toEqual([
      {
        text: 'queued one',
        displayText: undefined,
        mediaFiles: undefined,
        origin: 'user',
      },
    ]);
    expect(capturedTakePendingFollowUps()()).toEqual([]);
    expect(
      sessionFactPayloads(
        recordedSession?.events ?? [],
        'updateQueuedFollowUps',
      ),
    ).toContainEqual({ streamId: STREAM });
  });

  it('seeds an explicit follow-up ahead of the queued items', async () => {
    defaultSession().followUps.enqueue(
      STREAM,
      { text: 'queued one' },
      { force: true },
    );

    await resumeQueuedToolUseSnapshot(STREAM, snapshot(), runtimeHost, {
      extraFollowUps: [{ text: 'typed alongside resume', origin: 'user' }],
      onError: vi.fn(),
    });

    expect(
      capturedResumeOptions().drainedFollowUps?.map((item) => item.text),
    ).toEqual(['typed alongside resume', 'queued one']);
  });

  it('keeps ready-boundary and setup-race follow-ups in order', async () => {
    const onFollowUpQueueReady = vi.fn(() => {
      defaultSession().followUps.enqueue(STREAM, {
        text: 'queued at the ready boundary',
      });
    });
    let attachmentFollowUps: readonly FollowUpQueueInput[] = [];
    resumeToolUseFromSnapshotMock.mockImplementationOnce(
      async (...args: unknown[]) => {
        const options = args[2] as ReturnType<typeof capturedResumeOptions>;
        defaultSession().followUps.enqueue(STREAM, {
          text: 'queued after the initial drain',
        });
        attachmentFollowUps = options.takePendingFollowUps();
        options.onFollowUpConsumed?.();
      },
    );

    await resumeQueuedToolUseSnapshot(STREAM, snapshot(), runtimeHost, {
      onFollowUpQueueReady,
      onError: vi.fn(),
    });

    expect(onFollowUpQueueReady).toHaveBeenCalledOnce();
    expect(
      [
        ...(capturedResumeOptions().drainedFollowUps ?? []),
        ...attachmentFollowUps,
      ].map((item) => item.text),
    ).toEqual([
      'queued at the ready boundary',
      'queued after the initial drain',
    ]);
  });

  it('claims a follow-up queued during an orphaned host-resumed subagent turn after it parks', async () => {
    let postParkFollowUps: readonly FollowUpQueueInput[] = [];
    resumeToolUseFromSnapshotMock.mockImplementationOnce(
      async (...args: unknown[]) => {
        const options = args[2] as ReturnType<typeof capturedResumeOptions>;
        expect(options.takePendingFollowUps()).toEqual([]);

        defaultSession().followUps.enqueue(STREAM, {
          text: 'queued during the active turn',
        });
        postParkFollowUps = options.takePendingFollowUps();
        options.onFollowUpConsumed?.();
        return {
          category: 'toolUse',
          outcome: STREAM_PHASE.WAITING,
          executionId: 'exec-orphan-waiting',
          streamId: STREAM,
        };
      },
    );

    await expect(
      resumeQueuedToolUseSnapshot(STREAM, snapshot(), runtimeHost, {
        onError: vi.fn(),
      }),
    ).resolves.toBe(true);

    expect(postParkFollowUps.map((item) => item.text)).toEqual([
      'queued during the active turn',
    ]);
    expect(defaultSession().followUps.getAll(STREAM)).toEqual([]);
  });

  it('restores a post-park batch exactly once when cancellation wins before consumption', async () => {
    resumeToolUseFromSnapshotMock.mockImplementationOnce(
      async (...args: unknown[]) => {
        const options = args[2] as ReturnType<typeof capturedResumeOptions>;
        expect(options.takePendingFollowUps()).toEqual([]);

        defaultSession().followUps.enqueue(STREAM, {
          text: 'late input before cancellation',
        });
        expect(options.takePendingFollowUps().map((item) => item.text)).toEqual(
          ['late input before cancellation'],
        );
        seedStreamStatusForTest(
          defaultSession().status,
          STREAM,
          STREAM_PHASE.CANCELLED,
        );
        return {
          category: 'toolUse',
          outcome: RUN_OUTCOME.CANCELLED,
          executionId: 'exec-orphan-cancelled',
          streamId: STREAM,
        };
      },
    );

    await expect(
      resumeQueuedToolUseSnapshot(STREAM, snapshot(), runtimeHost, {
        onError: vi.fn(),
      }),
    ).resolves.toBe(false);

    expect(defaultSession().followUps.getAll(STREAM)).toEqual([
      'late input before cancellation',
    ]);
  });

  it('leaves post-park input to a registered child loop', async () => {
    const unregisterChildRunLoop =
      defaultSession().executions.registerChildRunLoop(STREAM);
    try {
      resumeToolUseFromSnapshotMock.mockImplementationOnce(
        async (...args: unknown[]) => {
          const options = args[2] as ReturnType<typeof capturedResumeOptions>;
          expect(options.takePendingFollowUps()).toEqual([]);

          defaultSession().followUps.enqueue(STREAM, {
            text: 'next loop-backed turn',
          });
          expect(options.takePendingFollowUps()).toEqual([]);
          return {
            category: 'toolUse',
            outcome: STREAM_PHASE.WAITING,
            executionId: 'exec-loop-waiting',
            streamId: STREAM,
          };
        },
      );

      await expect(
        resumeQueuedToolUseSnapshot(STREAM, snapshot(), runtimeHost, {
          onError: vi.fn(),
        }),
      ).resolves.toBe(true);

      expect(defaultSession().followUps.getAll(STREAM)).toEqual([
        'next loop-backed turn',
      ]);
    } finally {
      unregisterChildRunLoop();
    }
  });

  it('passes snapshot parent stream identity to the leaf resume', async () => {
    const parentStreamId = 'stream:parent' as StreamTabId;

    await resumeQueuedToolUseSnapshot(
      STREAM,
      snapshot(parentStreamId),
      runtimeHost,
      { onError: vi.fn() },
    );

    expect(capturedResumeOptions().parentStreamId).toBe(parentStreamId);
  });

  it('keeps an explicit queue parent stream ahead of the snapshot parent', async () => {
    const explicitParent = 'stream:explicit-parent' as StreamTabId;
    const snapshotParent = 'stream:snapshot-parent' as StreamTabId;

    await resumeQueuedToolUseSnapshot(
      STREAM,
      snapshot(snapshotParent),
      runtimeHost,
      {
        parentStreamId: explicitParent,
        onError: vi.fn(),
      },
    );

    expect(capturedResumeOptions().parentStreamId).toBe(explicitParent);
  });

  it('restores drained follow-ups when cancellation reaches flow setup', async () => {
    defaultSession().followUps.enqueue(
      STREAM,
      { text: 'queued one' },
      { force: true },
    );
    const isCancellationRequested = vi.fn(() => true);
    resumeToolUseFromSnapshotMock.mockImplementationOnce(
      async (...args: unknown[]) => {
        const options = args[2] as ReturnType<typeof capturedResumeOptions>;
        expect(options.isCancellationRequested).toBe(isCancellationRequested);
        defaultSession().followUps.enqueue(
          STREAM,
          { text: 'queued during resume' },
          { force: true },
        );
        if (options.isCancellationRequested?.()) {
          options.onCancellationAtFlowAttachment?.();
        }
        options.takePendingFollowUps();
        seedStreamStatusForTest(
          defaultSession().status,
          STREAM,
          STREAM_PHASE.CANCELLED,
        );
      },
    );

    await expect(
      resumeQueuedToolUseSnapshot(STREAM, snapshot(), runtimeHost, {
        isCancellationRequested,
        onError: vi.fn(),
      }),
    ).resolves.toBe(false);

    expect(defaultSession().followUps.getAll(STREAM)).toEqual([
      'queued one',
      'queued during resume',
    ]);
    expect(defaultSession().status.get(STREAM)).toBe(STREAM_STATUS.WAITING);
  });

  it('restores an unconsumed batch when cancellation lands after attachment', async () => {
    defaultSession().followUps.enqueue(
      STREAM,
      { text: 'queued one' },
      { force: true },
    );
    resumeToolUseFromSnapshotMock.mockImplementationOnce(
      async (...args: unknown[]) => {
        const options = args[2] as ReturnType<typeof capturedResumeOptions>;
        options.takePendingFollowUps();
        seedStreamStatusForTest(
          defaultSession().status,
          STREAM,
          STREAM_PHASE.CANCELLED,
        );
        return {
          category: 'toolUse',
          outcome: RUN_OUTCOME.CANCELLED,
          executionId: 'exec-cancelled',
          streamId: STREAM,
        };
      },
    );

    await expect(
      resumeQueuedToolUseSnapshot(STREAM, snapshot(), runtimeHost, {
        isCancellationRequested: () => false,
        onError: vi.fn(),
      }),
    ).resolves.toBe(false);

    expect(defaultSession().followUps.getAll(STREAM)).toEqual(['queued one']);
    expect(defaultSession().status.get(STREAM)).toBe(STREAM_STATUS.WAITING);
  });

  it('restores drained follow-ups once when cancellation result handling throws', async () => {
    const failure = new Error('result callback failed');
    const reportFailure = vi.fn();
    defaultSession().followUps.enqueue(
      STREAM,
      { text: 'queued one' },
      { force: true },
    );
    resumeToolUseFromSnapshotMock.mockImplementationOnce(
      async (...args: unknown[]) => {
        const options = args[2] as ReturnType<typeof capturedResumeOptions>;
        options.takePendingFollowUps();
      },
    );

    await expect(
      resumeQueuedToolUseSnapshot(STREAM, snapshot(), runtimeHost, {
        isCancellationRequested: () => true,
        onResult: () => {
          throw failure;
        },
        onError: reportFailure,
      }),
    ).resolves.toBe(false);

    expect(defaultSession().followUps.getAll(STREAM)).toEqual(['queued one']);
    expect(reportFailure).toHaveBeenCalledWith(failure);
    expect(
      sessionFactPayloads(
        recordedSession?.events ?? [],
        'updateQueuedFollowUps',
      ),
    ).toHaveLength(2);
  });

  it('does not restore a consumed batch when cancellation result handling throws', async () => {
    const failure = new Error('result callback failed');
    const reportFailure = vi.fn();
    let cancellationRequested = false;
    const isCancellationRequested = vi.fn(() => cancellationRequested);
    defaultSession().followUps.enqueue(
      STREAM,
      { text: 'queued one' },
      { force: true },
    );
    resumeToolUseFromSnapshotMock.mockImplementationOnce(
      async (...args: unknown[]) => {
        const options = args[2] as ReturnType<typeof capturedResumeOptions>;
        options.takePendingFollowUps();
        options.onFollowUpConsumed?.();
        cancellationRequested = true;
        seedStreamStatusForTest(
          defaultSession().status,
          STREAM,
          STREAM_PHASE.CANCELLED,
        );
      },
    );

    await expect(
      resumeQueuedToolUseSnapshot(STREAM, snapshot(), runtimeHost, {
        isCancellationRequested,
        onResult: () => {
          throw failure;
        },
        onError: reportFailure,
      }),
    ).resolves.toBe(false);

    expect(defaultSession().followUps.getAll(STREAM)).toEqual([]);
    expect(reportFailure).toHaveBeenCalledWith(failure);
    expect(
      sessionFactPayloads(
        recordedSession?.events ?? [],
        'updateQueuedFollowUps',
      ),
    ).toHaveLength(1);
  });

  it('treats a subagent parking back to WAITING as success without replaying follow-ups', async () => {
    // Host-path resume of a WAITING subagent (e.g. a follow-up sent to a
    // child stream from the progress view): the turn completes and the wait
    // node parks the stream WAITING again. That is success — no failure
    // surface, and the consumed follow-up must not be re-enqueued.
    const reportFailure = vi.fn();
    defaultSession().followUps.enqueue(
      STREAM,
      { text: 'queued one' },
      { force: true },
    );
    resumeToolUseFromSnapshotMock.mockImplementationOnce(
      async (...args: unknown[]) => {
        const options = args[2] as ReturnType<typeof capturedResumeOptions>;
        options.takePendingFollowUps();
        options.onFollowUpConsumed?.();
        seedStreamStatusForTest(
          defaultSession().status,
          STREAM,
          STREAM_PHASE.WAITING,
        );
        return {
          category: 'toolUse',
          outcome: STREAM_PHASE.WAITING,
          executionId: 'exec-waiting',
          streamId: STREAM,
        };
      },
    );

    await expect(
      resumeQueuedToolUseSnapshot(
        STREAM,
        snapshot('stream:parent' as StreamTabId),
        runtimeHost,
        {
          extraFollowUps: [{ text: 'talk to the subagent', origin: 'user' }],
          onError: reportFailure,
        },
      ),
    ).resolves.toBe(true);

    expect(
      capturedResumeOptions().drainedFollowUps?.map((item) => item.text),
    ).toEqual(['talk to the subagent', 'queued one']);
    expect(reportFailure).not.toHaveBeenCalled();
    expect(defaultSession().followUps.getAll(STREAM)).toEqual([]);
    expect(defaultSession().status.get(STREAM)).toBe(STREAM_STATUS.WAITING);
  });

  it('re-enqueues follow-ups, settles to WAITING, and reports on failure', async () => {
    const failure = new Error('resume blew up');
    resumeToolUseFromSnapshotMock.mockRejectedValue(failure);
    const reportFailure = vi.fn();
    defaultSession().followUps.enqueue(
      STREAM,
      { text: 'queued one' },
      { force: true },
    );

    await expect(
      resumeQueuedToolUseSnapshot(STREAM, snapshot(), runtimeHost, {
        onError: reportFailure,
      }),
    ).resolves.toBe(false);

    expect(defaultSession().followUps.getAll(STREAM)).toEqual(['queued one']);
    expect(defaultSession().status.get(STREAM)).toBe(STREAM_STATUS.WAITING);
    expect(reportFailure).toHaveBeenCalledWith(failure);
    // The re-enqueue replays a queue update beyond the initial drain notification.
    expect(
      sessionFactPayloads(
        recordedSession?.events ?? [],
        'updateQueuedFollowUps',
      ),
    ).toHaveLength(2);
  });

  it('uses the supplied session status plane for resume markers', async () => {
    const failure = new Error('session-scoped resume failed');
    resumeToolUseFromSnapshotMock.mockRejectedValue(failure);
    const session = createTestSession();

    try {
      await expect(
        resumeQueuedToolUseSnapshot(STREAM, snapshot(), runtimeHost, {
          session,
          onError: vi.fn(),
        }),
      ).resolves.toBe(false);

      expect(session.status.get(STREAM)).toBe(STREAM_STATUS.WAITING);
      expect(defaultSession().status.get(STREAM)).toBeUndefined();
    } finally {
      session.status.clearStream(STREAM);
      session.dispose();
    }
  });

  it('preserves failed resume follow-ups in the supplied session queue only', async () => {
    const failure = new Error('session queue resume failed');
    resumeToolUseFromSnapshotMock.mockRejectedValue(failure);
    const session = createTestSession();

    try {
      session.followUps.enqueue(
        STREAM,
        { text: 'session queued' },
        { force: true },
      );

      await expect(
        resumeQueuedToolUseSnapshot(STREAM, snapshot(), runtimeHost, {
          session,
          onError: vi.fn(),
        }),
      ).resolves.toBe(false);

      expect(session.followUps.getAll(STREAM)).toEqual(['session queued']);
      expect(defaultSession().followUps.getAll(STREAM)).toEqual([]);
    } finally {
      session.followUps.release(STREAM);
      session.status.clearStream(STREAM);
      session.dispose();
    }
  });

  it('leaves the status alone when the started run has taken it over', async () => {
    resumeToolUseFromSnapshotMock.mockImplementation(async () => {
      seedStreamStatusForTest(
        defaultSession().status,
        STREAM,
        STREAM_STATUS.RUNNING,
      );
    });

    await expect(
      resumeQueuedToolUseSnapshot(STREAM, snapshot(), runtimeHost, {
        onError: vi.fn(),
      }),
    ).resolves.toBe(true);
    expect(defaultSession().status.get(STREAM)).toBe(STREAM_STATUS.RUNNING);
  });
});
