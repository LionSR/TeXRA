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
import { defaultSession, SessionHandle } from '@agent/runtime/SessionHandle';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import { STREAM_STATUS, type StreamTabId } from '@shared/schemas';
import { attachSessionProgressEventProjectionForTest } from '../sessionProgressTestUtils';

const STREAM = 'stream:tooluse-resume' as StreamTabId;
const runtimeHost = { emit: vi.fn() };
let detachSessionProgressProjection: (() => void) | undefined;

function snapshot(): ToolUseSessionSnapshot {
  return { streamId: STREAM } as ToolUseSessionSnapshot;
}

/** Capture the `setupSession` replay callback handed to the leaf resume. */
function capturedSetupSession(): (session: {
  appendFollowUp(item: unknown): void;
}) => void {
  const calls = resumeToolUseFromSnapshotMock.mock
    .calls as unknown as unknown[][];
  const options = calls.at(-1)?.[2] as {
    setupSession: (session: { appendFollowUp(item: unknown): void }) => void;
  };
  return options.setupSession;
}

describe('resumeToolUseSnapshot', () => {
  beforeEach(() => {
    resumeToolUseFromSnapshotMock.mockReset();
    resumeToolUseFromSnapshotMock.mockResolvedValue(undefined);
    runtimeHost.emit.mockReset();
    detachSessionProgressProjection =
      attachSessionProgressEventProjectionForTest(
        defaultSession().events,
        runtimeHost,
      );
  });

  afterEach(() => {
    detachSessionProgressProjection?.();
    detachSessionProgressProjection = undefined;
    ToolUseFollowUpQueue.release(STREAM);
    clearStreamStatusForTest(StreamStatusService, STREAM);
  });

  it('drains queued follow-ups, replays them, and notifies the UI', async () => {
    ToolUseFollowUpQueue.enqueue(
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
    expect(runtimeHost.emit).toHaveBeenCalledWith('updateQueuedFollowUps', {
      streamId: STREAM,
    });
  });

  it('seeds an explicit follow-up ahead of the queued items', async () => {
    ToolUseFollowUpQueue.enqueue(
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

  it('re-enqueues follow-ups, settles to WAITING, and reports on failure', async () => {
    const failure = new Error('resume blew up');
    resumeToolUseFromSnapshotMock.mockRejectedValue(failure);
    const reportFailure = vi.fn();
    ToolUseFollowUpQueue.enqueue(
      STREAM,
      { text: 'queued one' },
      { force: true },
    );

    await expect(
      resumeToolUseSnapshot(snapshot(), { runtimeHost, reportFailure }),
    ).resolves.toBe(false);

    expect(ToolUseFollowUpQueue.getAll(STREAM)).toEqual(['queued one']);
    expect(StreamStatusService.get(STREAM)).toBe(STREAM_STATUS.WAITING);
    expect(reportFailure).toHaveBeenCalledWith(failure);
    // The re-enqueue replays a queue update beyond the initial drain notification.
    const queueUpdates = runtimeHost.emit.mock.calls.filter(
      ([event]) => event === 'updateQueuedFollowUps',
    );
    expect(queueUpdates).toHaveLength(2);
  });

  it('uses the supplied session status plane for resume markers', async () => {
    const failure = new Error('session-scoped resume failed');
    resumeToolUseFromSnapshotMock.mockRejectedValue(failure);
    const session = new SessionHandle();

    try {
      await expect(
        resumeToolUseSnapshot(snapshot(), {
          runtimeHost,
          session,
          reportFailure: vi.fn(),
        }),
      ).resolves.toBe(false);

      expect(session.status.get(STREAM)).toBe(STREAM_STATUS.WAITING);
      expect(StreamStatusService.get(STREAM)).toBeUndefined();
    } finally {
      session.status.clearStream(STREAM);
      session.dispose();
    }
  });

  it('preserves failed resume follow-ups in the supplied session queue only', async () => {
    const failure = new Error('session queue resume failed');
    resumeToolUseFromSnapshotMock.mockRejectedValue(failure);
    const session = new SessionHandle();

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
      expect(ToolUseFollowUpQueue.getAll(STREAM)).toEqual([]);
    } finally {
      session.followUps.release(STREAM);
      session.status.clearStream(STREAM);
      session.dispose();
    }
  });

  it('leaves the status alone when the started run has taken it over', async () => {
    resumeToolUseFromSnapshotMock.mockImplementation(async () => {
      seedStreamStatusForTest(
        StreamStatusService,
        STREAM,
        STREAM_STATUS.RUNNING,
      );
    });

    await expect(
      resumeToolUseSnapshot(snapshot(), { runtimeHost }),
    ).resolves.toBe(true);
    expect(StreamStatusService.get(STREAM)).toBe(STREAM_STATUS.RUNNING);
  });
});
