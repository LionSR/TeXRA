import { Effect } from 'effect';
import '@test/support/defaultSessionTestSetup';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { defaultSession, SessionHandle } from '@agent/runtime/SessionHandle';
import {
  notifyFollowUpSent,
  submitFollowUp,
} from '@agent/followUp/ToolUseFollowUp';
import { RUN_PHASE, RUN_SUBSTATE, type RunId } from '@shared/schemas';
import {
  clearRunStatusForTest,
  seedRunStatusForTest,
} from '@test/support/runStatusTestUtils';
import { testRunHandle } from '@test/support/runHandleFixtures';
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';
import { createTestSession } from '@test/support/sessionTestUtils';
import { listenForFollowUp } from '@tools/executions/waitCoordination';

import {
  createRecordingHost,
  recordFollowUpsSent,
  recordSessionEvents,
} from '../progressTestUtils';

const runId = 'run:follow-up' as RunId;

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
  const trackedRuns: Array<{
    readonly session: SessionHandle;
    readonly runId: RunId;
  }> = [];
  const sessions = new Set<SessionHandle>();

  afterEach(() => {
    for (const unsubscribe of unsubscribeFollowUpObservers.splice(0)) {
      unsubscribe();
    }
    for (const { session, runId } of trackedRuns.splice(0)) {
      session.runs.untrack(runId);
    }
    for (const session of sessions) {
      session.dispose();
    }
    sessions.clear();
    clearRunStatusForTest(defaultSession().status, runId);
  });

  function trackSession(): SessionHandle {
    const session = createTestSession({ roots: paperRoots() });
    sessions.add(session);
    return session;
  }

  function trackToolUseFlow({
    session,
  }: {
    readonly session?: SessionHandle;
  } = {}): void {
    const handle = testRunHandle({ runId, agent: 'search' });
    const owner = session ?? defaultSession();
    handle.attachToolUseFlow({
      ownerSession: owner,
      modelHandler: { supportsManualCompaction: true },
      requestImmediateCompaction: () => {},
      modelSwitchDisabledReason: () => undefined,
      switchModel: async () => {},
      interrupt: () => {},
    });
    owner.runs.track(handle);
    trackedRuns.push({ session: owner, runId });
  }

  it('publishes sent follow-up events through the owning session fact hub', async () => {
    const run = createRecordingHost();
    const session = trackSession();
    const sent = recordFollowUpsSent(session);
    const lease = session.followUps.claimLive(runId, 'flow')!;

    trackToolUseFlow({ session });

    const result = await Effect.runPromise(
      submitFollowUp(runId, 'please continue', {
        session,
      }),
    );

    expect(result).toEqual({ status: 'sent' });
    expect(session.followUps.queue(lease).drainItems()).toMatchObject([
      { text: 'please continue', origin: 'user' },
    ]);
    expect(sent.sent).toEqual([runId]);
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
      () => notifyFollowUpSent(runId, explicitSession),
    );

    expect(explicit.sent).toEqual([runId]);
    expect(active.sent).toEqual([]);
    expect(run.events).toEqual([]);
  });

  it("routes follow-up sent notifications through the active run's current session", () => {
    const run = createRecordingHost();
    const session = trackSession();
    const sent = recordFollowUpsSent(session);

    withRunContext(createRunContext({ session }), () =>
      notifyFollowUpSent(runId),
    );

    expect(sent.sent).toEqual([runId]);
    expect(run.events).toEqual([]);
  });

  it('breaks a blocking wait when the owning session emits followUpSent', () => {
    const session = trackSession();
    const onFollowUp = vi.fn();
    const otherRun = 'run:other' as RunId;

    let cleanup: () => void = () => {};
    withRunContext(createRunContext({ session, runId }), () => {
      cleanup = listenForFollowUp(onFollowUp);
    });
    unsubscribeFollowUpObservers.push(cleanup);

    notifyFollowUpSent(otherRun, session);
    expect(onFollowUp).not.toHaveBeenCalled();

    notifyFollowUpSent(runId, session);
    expect(onFollowUp).toHaveBeenCalledOnce();
  });

  it('does not append through stale active contexts after final status', async () => {
    seedRunStatusForTest(defaultSession().status, runId, {
      phase: RUN_PHASE.COMPLETED,
    });
    trackToolUseFlow();

    const result = await Effect.runPromise(
      submitFollowUp(runId, 'late follow-up', { session: defaultSession() }),
    );

    expect(result).toEqual({ status: 'failed', reason: 'not_resumable' });
    expect(defaultSession().followUps.getAll(runId)).toEqual([]);
  });

  it('queues follow-ups for resuming runs through registry admission', async () => {
    const resumingRunId = 'run:resuming-follow-up' as RunId;

    seedRunStatusForTest(defaultSession().status, resumingRunId, {
      phase: RUN_PHASE.RUNNING,
      substate: RUN_SUBSTATE.RESUMING,
    });

    try {
      const result = await Effect.runPromise(
        submitFollowUp(resumingRunId, 'queued while resuming', {
          session: defaultSession(),
        }),
      );

      // The fake platform's resume port refuses, so the input stays queued
      // behind a failed wake.
      expect(result).toEqual({ status: 'queued', wake: 'failed' });
      expect(defaultSession().followUps.getAll(resumingRunId)).toEqual([
        'queued while resuming',
      ]);
    } finally {
      defaultSession().followUps.terminalize(resumingRunId);
      clearRunStatusForTest(defaultSession().status, resumingRunId);
    }
  });
});
