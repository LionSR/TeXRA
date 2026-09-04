import '@test/support/defaultSessionTestSetup';

import { afterEach, describe, expect, it } from 'vitest';

import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { defaultSession, SessionHandle } from '@agent/runtime/SessionHandle';
import {
  notifyFollowUpSent,
  submitFollowUp,
} from '@agent/followUp/ToolUseFollowUp';
import {
  STREAM_PHASE,
  STREAM_SUBSTATE,
  type StreamTabId,
} from '@shared/schemas';
import {
  clearAllStreamStatusesForTest,
  seedStreamStatusForTest,
} from '@test/support/streamStatusTestUtils';
import { testExecutionHandle } from '@test/support/executionHandleFixtures';
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';
import { createTestSession } from '@test/support/sessionTestUtils';
import { listenForFollowUp } from '@tools/executions/waitCoordination';

import {
  createRecordingHost,
  recordFollowUpsSent,
  recordSessionEvents,
} from '../progressTestUtils';

const streamId = 'stream:follow-up' as StreamTabId;

let paperCount = 0;

/** The roots of one paper: a session's plane is keyed by its storage root,
 *  so sessions that must not hear each other get their own. */
function paperRoots() {
  paperCount += 1;
  return createFakeWorkspaceRoots({
    storagePath: `/workspace/paper-${paperCount}/.texra/storage`,
  });
}

describe('tool-use follow-up progress events', () => {
  const unsubscribeFollowUpObservers: Array<() => void> = [];
  const trackedExecutions: Array<{
    readonly session: SessionHandle;
    readonly executionId: string;
  }> = [];
  const sessions = new Set<SessionHandle>();

  afterEach(() => {
    for (const unsubscribe of unsubscribeFollowUpObservers.splice(0)) {
      unsubscribe();
    }
    for (const { session, executionId } of trackedExecutions.splice(0)) {
      session.executions.untrack(executionId);
    }
    for (const session of sessions) {
      session.dispose();
    }
    sessions.clear();
    clearAllStreamStatusesForTest(defaultSession().status);
  });

  function trackSession(): SessionHandle {
    const session = createTestSession({ roots: paperRoots() });
    sessions.add(session);
    return session;
  }

  function trackToolUseFlow({
    stream = streamId,
    executionId = `exec-${stream}`,
    session,
  }: {
    readonly stream?: StreamTabId;
    readonly executionId?: string;
    readonly session?: SessionHandle;
  } = {}): void {
    const handle = testExecutionHandle({
      executionId,
      parentStreamId: stream,
      agent: 'search',
    });
    const owner = session ?? defaultSession();
    handle.attachToolUseFlow({
      ownerSession: owner,
      modelHandler: { supportsManualCompaction: true },
      requestImmediateCompaction: () => {},
      modelSwitchDisabledReason: () => undefined,
      switchModel: async () => {},
      interrupt: () => {},
    });
    owner.executions.track(handle);
    trackedExecutions.push({ session: owner, executionId });
  }

  it('publishes sent follow-up events through the owning session fact hub', async () => {
    const run = createRecordingHost();
    const session = trackSession();
    const sent = recordFollowUpsSent(session);
    const lease = session.followUps.claimLive(streamId, 'flow')!;

    trackToolUseFlow({ session });

    const result = await submitFollowUp(streamId, 'please continue', {
      session,
    });

    expect(result).toEqual({ status: 'sent' });
    expect(session.followUps.queue(lease).drainItems()).toMatchObject([
      { text: 'please continue', origin: 'user' },
    ]);
    expect(sent.sent).toEqual([streamId]);
    expect(run.events).toEqual([]);
  });

  it('prefers an explicit session over the active run context when notifying follow-up sent', () => {
    const run = createRecordingHost();
    const explicitSession = trackSession();
    const activeSession = trackSession();
    const explicit = recordFollowUpsSent(explicitSession);
    const active = recordFollowUpsSent(activeSession);

    withRunContext(
      createRunContext({
        session: activeSession,
      }),
      () => notifyFollowUpSent(streamId, explicitSession),
    );

    expect(explicit.sent).toEqual([streamId]);
    expect(active.sent).toEqual([]);
    expect(run.events).toEqual([]);
  });

  it("routes follow-up sent notifications through the active run's current session", () => {
    const run = createRecordingHost();
    const session = trackSession();
    const sent = recordFollowUpsSent(session);

    withRunContext(createRunContext({ session }), () =>
      notifyFollowUpSent(streamId),
    );

    expect(sent.sent).toEqual([streamId]);
    expect(run.events).toEqual([]);
  });

  it('aborts a blocking wait when the owning session emits followUpSent', () => {
    const session = trackSession();
    const ac = new AbortController();
    const otherStream = 'stream:other' as StreamTabId;

    let cleanup: () => void = () => {};
    withRunContext(createRunContext({ session, streamId }), () => {
      cleanup = listenForFollowUp(ac);
    });
    unsubscribeFollowUpObservers.push(cleanup);

    notifyFollowUpSent(otherStream, session);
    expect(ac.signal.aborted).toBe(false);

    notifyFollowUpSent(streamId, session);
    expect(ac.signal.aborted).toBe(true);
  });

  it('stops aborting waits once the follow-up listener is cleaned up', () => {
    const session = trackSession();
    const ac = new AbortController();

    let cleanup: () => void = () => {};
    withRunContext(createRunContext({ session, streamId }), () => {
      cleanup = listenForFollowUp(ac);
    });
    cleanup();

    notifyFollowUpSent(streamId, session);
    expect(ac.signal.aborted).toBe(false);
  });

  it('does not append through stale active contexts after final status', async () => {
    seedStreamStatusForTest(defaultSession().status, streamId, {
      phase: STREAM_PHASE.COMPLETED,
    });
    trackToolUseFlow();

    const result = await submitFollowUp(streamId, 'late follow-up');

    expect(result).toEqual({ status: 'failed', reason: 'not_resumable' });
    expect(defaultSession().followUps.getAll(streamId)).toEqual([]);
  });

  it('does not emit a follow-up sent fact when no follow-up reaches a live session', async () => {
    const session = trackSession();
    const recorded = recordSessionEvents(session);

    const result = await submitFollowUp(
      'stream:no-follow-up-session' as StreamTabId,
      'cannot deliver',
      { session },
    );

    expect(result).toEqual({ status: 'failed', reason: 'not_resumable' });
    expect(recorded.events).toEqual([]);
  });

  it('queues follow-ups for resuming streams through registry admission', async () => {
    const resumingStreamId = 'stream:resuming-follow-up' as StreamTabId;

    seedStreamStatusForTest(defaultSession().status, resumingStreamId, {
      phase: STREAM_PHASE.RUNNING,
      substate: STREAM_SUBSTATE.RESUMING,
    });

    try {
      const result = await submitFollowUp(
        resumingStreamId,
        'queued while resuming',
      );

      // The fake platform's resume port refuses, so the input stays queued
      // behind a failed wake.
      expect(result).toEqual({ status: 'queued', wake: 'failed' });
      expect(defaultSession().followUps.getAll(resumingStreamId)).toEqual([
        'queued while resuming',
      ]);
    } finally {
      defaultSession().followUps.terminalize(resumingStreamId);
    }
  });
});
