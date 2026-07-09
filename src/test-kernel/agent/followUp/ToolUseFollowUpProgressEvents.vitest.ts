// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import {
  clearAllStreamStatusesForTest,
  seedStreamStatusForTest,
} from '@test/helpers/streamStatusTestUtils';
import {
  noopAgentRuntimeHost,
  type AgentRuntimeHost,
} from '@agent/runtime/AgentRuntimeHost';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import {
  AgentExecutionHandle,
  SharedExecutionRegistry,
  type LiveToolUseFlowContext,
} from '@agent/runtime/executionRegistry';
import { defaultSession, SessionHandle } from '@agent/runtime/SessionHandle';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import {
  notifyFollowUpSent,
  onFollowUpSent,
  sendFollowUp,
} from '@agent/followUp/ToolUseFollowUp';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import { STREAM_PHASE, STREAM_STATUS, type StreamTabId } from '@shared/schemas';
import { createRecordingHost } from '../progressTestUtils';

const streamId = 'stream:follow-up' as StreamTabId;

describe('tool-use follow-up progress events', () => {
  const unsubscribeFollowUpObservers: Array<() => void> = [];
  const trackedExecutionIds = new Set<string>();
  const sessionTrackedExecutions: Array<{
    readonly session: SessionHandle;
    readonly executionId: string;
  }> = [];
  const sessions = new Set<SessionHandle>();

  afterEach(() => {
    for (const unsubscribe of unsubscribeFollowUpObservers.splice(0)) {
      unsubscribe();
    }
    for (const executionId of trackedExecutionIds) {
      SharedExecutionRegistry.untrack(executionId);
    }
    trackedExecutionIds.clear();
    for (const { session, executionId } of sessionTrackedExecutions.splice(0)) {
      session.executions.untrack(executionId);
    }
    for (const session of sessions) {
      session.dispose({ keepActiveExecutions: true });
    }
    sessions.clear();
    clearAllStreamStatusesForTest(StreamStatusService);
  });

  function trackToolUseFlow({
    stream = streamId,
    host = noopAgentRuntimeHost,
    appendFollowUp,
    executionId = `exec-${stream}`,
    session,
  }: {
    readonly stream?: StreamTabId;
    readonly host?: AgentRuntimeHost;
    readonly appendFollowUp: LiveToolUseFlowContext['session']['appendFollowUp'];
    readonly executionId?: string;
    readonly session?: SessionHandle;
  }): void {
    const handle = new AgentExecutionHandle(
      executionId,
      stream,
      stream,
      'search',
      'toolUse',
      host,
    );
    handle.attachToolUseFlow({
      ...(session ? { ownerSession: session } : {}),
      session: { appendFollowUp },
      modelHandler: { supportsManualCompaction: true },
      runtimeHost: host,
      requestImmediateCompaction: () => {},
      modelSwitchDisabledReason: () => undefined,
      switchModel: async () => {},
      interrupt: () => {},
    });
    if (session) {
      session.executions.track(handle);
      sessionTrackedExecutions.push({ session, executionId });
    } else {
      SharedExecutionRegistry.track(handle);
      trackedExecutionIds.add(executionId);
    }
  }

  it('publishes sent follow-up events through the owning session fact hub', async () => {
    const { events, host } = createRecordingHost();
    const session = new SessionHandle();
    sessions.add(session);
    const facts: unknown[] = [];
    const detachFacts = session.events.subscribe((event) => {
      facts.push(event);
    });
    const appendFollowUp = vi.fn();

    trackToolUseFlow({ host, appendFollowUp, session });

    const result = await sendFollowUp(
      streamId,
      'please continue',
      undefined,
      undefined,
      session,
    );
    detachFacts();

    expect(result).toEqual({ status: 'sent' });
    expect(appendFollowUp).toHaveBeenCalledWith({
      text: 'please continue',
      mediaFiles: undefined,
      displayText: undefined,
    });
    expect(facts).toEqual([
      {
        scope: 'session',
        event: {
          type: 'followUpSent',
          payload: { streamId },
        },
      },
    ]);
    expect(events).toEqual([]);
  });

  it('prefers an explicit session over the active run context when notifying follow-up sent', () => {
    const run = createRecordingHost();
    const explicitSession = new SessionHandle();
    const activeSession = new SessionHandle();
    sessions.add(explicitSession);
    sessions.add(activeSession);
    const explicitFacts: unknown[] = [];
    const activeFacts: unknown[] = [];
    const detachExplicitFacts = explicitSession.events.subscribe((event) => {
      explicitFacts.push(event);
    });
    const detachActiveFacts = activeSession.events.subscribe((event) => {
      activeFacts.push(event);
    });

    try {
      withRunContext(
        createRunContext({
          runtimeHost: run.host,
          session: activeSession,
        }),
        () => notifyFollowUpSent(streamId, explicitSession),
      );

      expect(explicitFacts).toEqual([
        {
          scope: 'session',
          event: {
            type: 'followUpSent',
            payload: { streamId },
          },
        },
      ]);
      expect(activeFacts).toEqual([]);
      expect(run.events).toEqual([]);
    } finally {
      detachExplicitFacts();
      detachActiveFacts();
    }
  });

  it("routes follow-up sent notifications through the active run's current session", () => {
    const run = createRecordingHost();
    const session = new SessionHandle();
    sessions.add(session);
    const facts: unknown[] = [];
    const detachFacts = session.events.subscribe((event) => {
      facts.push(event);
    });

    try {
      withRunContext(
        createRunContext({
          runtimeHost: run.host,
          session,
        }),
        () => notifyFollowUpSent(streamId),
      );

      expect(facts).toEqual([
        {
          scope: 'session',
          event: {
            type: 'followUpSent',
            payload: { streamId },
          },
        },
      ]);
      expect(run.events).toEqual([]);
    } finally {
      detachFacts();
    }
  });

  it('falls back to the default session when the active run has no event hub', () => {
    const run = createRecordingHost();
    const defaultFacts: unknown[] = [];
    const detachDefaultFacts = defaultSession().events.subscribe((event) => {
      defaultFacts.push(event);
    });

    try {
      withRunContext(
        createRunContext({
          runtimeHost: run.host,
          session: {} as SessionHandle,
        }),
        () => notifyFollowUpSent(streamId),
      );

      expect(defaultFacts).toEqual([
        {
          scope: 'session',
          event: {
            type: 'followUpSent',
            payload: { streamId },
          },
        },
      ]);
      expect(run.events).toEqual([]);
    } finally {
      detachDefaultFacts();
    }
  });

  it('notifies local follow-up observers through onFollowUpSent', async () => {
    const { host } = createRecordingHost();
    const observed: StreamTabId[] = [];
    unsubscribeFollowUpObservers.push(
      onFollowUpSent((observedStreamId) => {
        observed.push(observedStreamId);
      }),
    );

    trackToolUseFlow({ host, appendFollowUp: vi.fn() });

    await sendFollowUp(streamId, 'break wait');
    unsubscribeFollowUpObservers.pop()?.();
    await sendFollowUp(streamId, 'after unsubscribe');

    expect(observed).toEqual([streamId]);
  });

  it('runs observers before session emission and catches observer errors', async () => {
    const session = new SessionHandle();
    sessions.add(session);
    const order: string[] = [];
    const detachFacts = session.events.subscribe(() => {
      order.push('session event');
    });
    unsubscribeFollowUpObservers.push(
      onFollowUpSent(() => {
        order.push('throwing observer');
        throw new Error('observer failure');
      }),
      onFollowUpSent(() => {
        order.push('next observer');
      }),
    );

    try {
      trackToolUseFlow({
        appendFollowUp: vi.fn(),
        session,
      });

      const result = await sendFollowUp(
        streamId,
        'observer ordering',
        undefined,
        undefined,
        session,
      );

      expect(result).toEqual({ status: 'sent' });
      expect(order).toEqual([
        'throwing observer',
        'next observer',
        'session event',
      ]);
    } finally {
      detachFacts();
    }
  });

  it('does not append through stale active contexts after final status', async () => {
    const { host } = createRecordingHost();
    const appendFollowUp = vi.fn();

    seedStreamStatusForTest(
      StreamStatusService,
      streamId,
      STREAM_PHASE.COMPLETED,
    );
    trackToolUseFlow({ host, appendFollowUp });

    const result = await sendFollowUp(streamId, 'late follow-up');

    expect(result).toEqual({
      status: 'no_session',
      streamStatus: STREAM_PHASE.COMPLETED,
    });
    expect(appendFollowUp).not.toHaveBeenCalled();
  });

  it('does not emit a follow-up sent fact when no follow-up reaches a live session', async () => {
    const session = new SessionHandle();
    sessions.add(session);
    const facts: unknown[] = [];
    const detachFacts = session.events.subscribe((event) => {
      facts.push(event);
    });

    try {
      const result = await sendFollowUp(
        'stream:no-follow-up-session' as StreamTabId,
        'cannot deliver',
        undefined,
        undefined,
        session,
      );

      expect(result).toEqual({
        status: 'no_session',
        streamStatus: undefined,
      });
      expect(facts).toEqual([]);
    } finally {
      detachFacts();
    }
  });

  it('queues follow-ups for resuming streams through registry admission', async () => {
    const resumingStreamId = 'stream:resuming-follow-up' as StreamTabId;

    seedStreamStatusForTest(
      StreamStatusService,
      resumingStreamId,
      STREAM_STATUS.RESUMING,
    );

    try {
      const result = await sendFollowUp(
        resumingStreamId,
        'queued while resuming',
      );

      expect(result).toEqual({
        status: 'queued',
        reason: 'resuming',
      });
      expect(ToolUseFollowUpQueue.getAll(resumingStreamId)).toEqual([
        'queued while resuming',
      ]);
    } finally {
      ToolUseFollowUpQueue.release(resumingStreamId);
    }
  });

  it('keeps terminal parents with active children on the children-running queue path', async () => {
    const parentStreamId = 'stream:terminal-parent' as StreamTabId;
    const childStreamId = 'stream:terminal-parent-child' as StreamTabId;
    const executionId = 'exec-terminal-parent-child';
    const handle = new AgentExecutionHandle(
      executionId,
      parentStreamId,
      childStreamId,
      'critic',
      'toolUse',
      noopAgentRuntimeHost,
    );

    seedStreamStatusForTest(
      StreamStatusService,
      parentStreamId,
      STREAM_STATUS.STOPPED,
    );
    SharedExecutionRegistry.track(handle);

    try {
      const result = await sendFollowUp(parentStreamId, 'continue child');

      expect(result).toEqual({
        status: 'queued',
        reason: 'children_running',
      });
      expect(ToolUseFollowUpQueue.getAll(parentStreamId)).toEqual([
        'continue child',
      ]);
    } finally {
      SharedExecutionRegistry.untrack(executionId);
      ToolUseFollowUpQueue.release(parentStreamId);
    }
  });
});
