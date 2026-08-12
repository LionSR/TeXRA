import '@test/support/defaultSessionTestSetup';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import type { LiveToolUseFlowContext } from '@agent/runtime/ExecutionHandle';
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
import { createTestSession } from '@test/support/sessionTestUtils';
import { listenForFollowUp } from '@tools/executions/waitCoordination';

import { createRecordingHost, recordSessionEvents } from '../progressTestUtils';

const streamId = 'stream:follow-up' as StreamTabId;

function followUpSentEvent(stream: StreamTabId) {
  return {
    scope: 'session',
    event: { type: 'followUpSent', payload: { streamId: stream } },
  };
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
    const session = createTestSession();
    sessions.add(session);
    return session;
  }

  function trackToolUseFlow({
    stream = streamId,
    appendFollowUp,
    executionId = `exec-${stream}`,
    session,
  }: {
    readonly stream?: StreamTabId;
    readonly appendFollowUp: LiveToolUseFlowContext['session']['appendFollowUp'];
    readonly executionId?: string;
    readonly session?: SessionHandle;
  }): void {
    const handle = testExecutionHandle({
      executionId,
      parentStreamId: stream,
      agent: 'search',
    });
    handle.attachToolUseFlow({
      ...(session ? { ownerSession: session } : {}),
      session: { appendFollowUp },
      modelHandler: { supportsManualCompaction: true },
      requestImmediateCompaction: () => {},
      modelSwitchDisabledReason: () => undefined,
      switchModel: async () => {},
      interrupt: () => {},
    });
    const owner = session ?? defaultSession();
    owner.executions.track(handle);
    trackedExecutions.push({ session: owner, executionId });
  }

  it('publishes sent follow-up events through the owning session fact hub', async () => {
    const run = createRecordingHost();
    const session = trackSession();
    const recorded = recordSessionEvents(session.events);
    const appendFollowUp = vi.fn();

    trackToolUseFlow({ appendFollowUp, session });

    const result = await submitFollowUp(streamId, 'please continue', {
      session,
    });
    recorded.detach();

    expect(result).toEqual({ status: 'sent' });
    expect(appendFollowUp).toHaveBeenCalledWith({
      text: 'please continue',
      mediaFiles: undefined,
      displayText: undefined,
    });
    expect(recorded.events).toEqual([followUpSentEvent(streamId)]);
    expect(run.events).toEqual([]);
  });

  it('prefers an explicit session over the active run context when notifying follow-up sent', () => {
    const run = createRecordingHost();
    const explicitSession = trackSession();
    const activeSession = trackSession();
    const explicit = recordSessionEvents(explicitSession.events);
    const active = recordSessionEvents(activeSession.events);

    try {
      withRunContext(
        createRunContext({
          session: activeSession,
        }),
        () => notifyFollowUpSent(streamId, explicitSession),
      );

      expect(explicit.events).toEqual([followUpSentEvent(streamId)]);
      expect(active.events).toEqual([]);
      expect(run.events).toEqual([]);
    } finally {
      explicit.detach();
      active.detach();
    }
  });

  it("routes follow-up sent notifications through the active run's current session", () => {
    const run = createRecordingHost();
    const session = trackSession();
    const recorded = recordSessionEvents(session.events);

    try {
      withRunContext(createRunContext({ session }), () =>
        notifyFollowUpSent(streamId),
      );

      expect(recorded.events).toEqual([followUpSentEvent(streamId)]);
      expect(run.events).toEqual([]);
    } finally {
      recorded.detach();
    }
  });

  it('falls back to the default session when the active run has no event hub', () => {
    const run = createRecordingHost();
    const recorded = recordSessionEvents(defaultSession().events);

    try {
      withRunContext(
        createRunContext({
          session: {} as SessionHandle,
        }),
        () => notifyFollowUpSent(streamId),
      );

      expect(recorded.events).toEqual([followUpSentEvent(streamId)]);
      expect(run.events).toEqual([]);
    } finally {
      recorded.detach();
    }
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
    const appendFollowUp = vi.fn();

    seedStreamStatusForTest(defaultSession().status, streamId, {
      phase: STREAM_PHASE.COMPLETED,
    });
    trackToolUseFlow({ appendFollowUp });

    const result = await submitFollowUp(streamId, 'late follow-up');

    expect(result).toEqual({
      status: 'no_session',
      streamStatus: STREAM_PHASE.COMPLETED,
    });
    expect(appendFollowUp).not.toHaveBeenCalled();
  });

  it('does not emit a follow-up sent fact when no follow-up reaches a live session', async () => {
    const session = trackSession();
    const recorded = recordSessionEvents(session.events);

    try {
      const result = await submitFollowUp(
        'stream:no-follow-up-session' as StreamTabId,
        'cannot deliver',
        { session },
      );

      expect(result).toEqual({
        status: 'no_session',
        streamStatus: undefined,
      });
      expect(recorded.events).toEqual([]);
    } finally {
      recorded.detach();
    }
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

      expect(result).toEqual({
        status: 'queued',
        reason: 'resuming',
        continuation: 'resume_failed',
      });
      expect(defaultSession().followUps.getAll(resumingStreamId)).toEqual([
        'queued while resuming',
      ]);
    } finally {
      defaultSession().followUps.terminalize(resumingStreamId);
    }
  });

  it('keeps terminal parents with active children on the children-running queue path', async () => {
    const parentStreamId = 'stream:terminal-parent' as StreamTabId;
    const childStreamId = 'stream:terminal-parent-child' as StreamTabId;
    const executionId = 'exec-terminal-parent-child';
    const handle = testExecutionHandle({
      executionId,
      parentStreamId,
      childStreamId,
      agent: 'critic',
    });

    seedStreamStatusForTest(defaultSession().status, parentStreamId, {
      phase: STREAM_PHASE.COMPLETED,
    });
    defaultSession().executions.track(handle);

    try {
      const result = await submitFollowUp(parentStreamId, 'continue child');

      expect(result).toEqual({
        status: 'queued',
        reason: 'children_running',
        continuation: 'resume_failed',
      });
      expect(defaultSession().followUps.getAll(parentStreamId)).toEqual([
        'continue child',
      ]);
    } finally {
      defaultSession().executions.untrack(executionId);
      defaultSession().followUps.terminalize(parentStreamId);
    }
  });
});
