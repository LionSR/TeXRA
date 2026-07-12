// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Test support imports
import { createTestSession } from '@test/support/sessionTestUtils';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resumeToolUseFromSnapshotMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@agent/runtime/executeAgent', () => ({
  resumeToolUseFromSnapshot: resumeToolUseFromSnapshotMock,
}));

import {
  clearStreamStatusForTest,
  seedStreamStatusForTest,
} from '@test/helpers/streamStatusTestUtils';
import { resumeToolUseSnapshot } from '@agent/runtime/resumeToolUseSnapshot';
import { resumeQueuedToolUseSnapshot } from '@agent/runtime/resumeQueuedToolUse';
import { defaultSession, SessionHandle } from '@agent/runtime/SessionHandle';
import type { FollowUpQueueInput } from '@agent/followUp/FollowUpQueue';
import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import { STREAM_PHASE, STREAM_STATUS, type StreamTabId } from '@shared/schemas';
import { recordSessionEvents, sessionFactPayloads } from '../progressTestUtils';

const STREAM = 'stream:tooluse-resume' as StreamTabId;
const runtimeHost = { emit: vi.fn() };
let recordedSession: ReturnType<typeof recordSessionEvents> | undefined;

function snapshot(parentStreamId?: StreamTabId): ToolUseSessionSnapshot {
  return { streamId: STREAM, parentStreamId } as ToolUseSessionSnapshot;
}

function capturedResumeOptions(): {
  parentStreamId?: StreamTabId;
  isCancellationRequested?: () => boolean;
  setupSession: (session: {
    appendFollowUp(item: FollowUpQueueInput): void;
  }) => void;
} {
  const calls = resumeToolUseFromSnapshotMock.mock
    .calls as unknown as unknown[][];
  return calls.at(-1)?.[2] as {
    parentStreamId?: StreamTabId;
    isCancellationRequested?: () => boolean;
    setupSession: (session: {
      appendFollowUp(item: FollowUpQueueInput): void;
    }) => void;
  };
}

/** Capture the `setupSession` replay callback handed to the leaf resume. */
function capturedSetupSession(): (session: {
  appendFollowUp(item: FollowUpQueueInput): void;
}) => void {
  const options = capturedResumeOptions();
  return options.setupSession;
}

describe('resumeToolUseSnapshot', () => {
  beforeEach(() => {
    resumeToolUseFromSnapshotMock.mockReset();
    resumeToolUseFromSnapshotMock.mockResolvedValue(undefined);
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

  it('drains queued follow-ups, replays them, and notifies the UI', async () => {
    defaultSession().followUps.enqueue(
      STREAM,
      { text: 'queued one' },
      { force: true },
    );

    await expect(
      resumeToolUseSnapshot(snapshot(), { runtimeHost }),
    ).resolves.toBe(true);

    const appendFollowUp = vi.fn();
    capturedSetupSession()({ appendFollowUp });
    expect(appendFollowUp).toHaveBeenCalledWith({
      text: 'queued one',
      origin: 'user',
    });
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

    await resumeToolUseSnapshot(snapshot(), {
      runtimeHost,
      explicitFollowUp: 'typed alongside resume',
    });

    const appendFollowUp = vi.fn();
    capturedSetupSession()({ appendFollowUp });
    expect(appendFollowUp).toHaveBeenNthCalledWith(1, {
      text: 'typed alongside resume',
      origin: 'user',
    });
    expect(appendFollowUp).toHaveBeenNthCalledWith(2, {
      text: 'queued one',
      origin: 'user',
    });
  });

  it('opens late follow-up routing before draining the resume queue', async () => {
    const onFollowUpQueueReady = vi.fn(() => {
      defaultSession().followUps.enqueue(STREAM, {
        text: 'queued at the ready boundary',
      });
    });

    await resumeQueuedToolUseSnapshot(STREAM, snapshot(), runtimeHost, {
      onFollowUpQueueReady,
      onError: vi.fn(),
    });

    expect(onFollowUpQueueReady).toHaveBeenCalledOnce();
    const appendFollowUp = vi.fn();
    capturedSetupSession()({ appendFollowUp });
    expect(appendFollowUp).toHaveBeenCalledWith({
      text: 'queued at the ready boundary',
      origin: 'user',
    });
  });

  it('passes snapshot parent stream identity to the leaf resume', async () => {
    const parentStreamId = 'stream:parent' as StreamTabId;

    await resumeToolUseSnapshot(snapshot(parentStreamId), { runtimeHost });

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
    const appendFollowUp = vi.fn();
    resumeToolUseFromSnapshotMock.mockImplementationOnce(
      async (...args: unknown[]) => {
        const options = args[2] as ReturnType<typeof capturedResumeOptions>;
        expect(options.isCancellationRequested).toBe(isCancellationRequested);
        defaultSession().followUps.enqueue(
          STREAM,
          { text: 'queued during resume' },
          { force: true },
        );
        options.setupSession({ appendFollowUp });
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

    expect(appendFollowUp).not.toHaveBeenCalled();
    expect(defaultSession().followUps.getAll(STREAM)).toEqual([
      'queued one',
      'queued during resume',
    ]);
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
        options.setupSession({ appendFollowUp: vi.fn() });
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

  it('does not duplicate a live batch when post-setup cancellation result handling throws', async () => {
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
        const liveQueue = defaultSession().followUps.acquire(STREAM);
        options.setupSession({
          appendFollowUp: (item) => liveQueue.enqueue(item),
        });
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

    expect(defaultSession().followUps.getAll(STREAM)).toEqual(['queued one']);
    expect(reportFailure).toHaveBeenCalledWith(failure);
    expect(
      sessionFactPayloads(
        recordedSession?.events ?? [],
        'updateQueuedFollowUps',
      ),
    ).toHaveLength(1);
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
      resumeToolUseSnapshot(snapshot(), { runtimeHost, reportFailure }),
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
        resumeToolUseSnapshot(snapshot(), {
          runtimeHost,
          session,
          reportFailure: vi.fn(),
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
        resumeToolUseSnapshot(snapshot(), {
          runtimeHost,
          session,
          reportFailure: vi.fn(),
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
      resumeToolUseSnapshot(snapshot(), { runtimeHost }),
    ).resolves.toBe(true);
    expect(defaultSession().status.get(STREAM)).toBe(STREAM_STATUS.RUNNING);
  });
});
