import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';

import { submitFollowUp } from '@agent/followUp/ToolUseFollowUp';
import { AgentResume } from '@platform/interfaces';
import { MESSAGE_TYPES, type RunId } from '@shared/schemas';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { testRunHandle } from '@test/support/runHandleFixtures';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { createRunTrace } from '@transcript';
import { generateRunId } from '@utils/core';

describe('session-owned transcripts and follow-up queues', () => {
  it("writes run trace entries to the launching session's transcript store only", async () => {
    const launching = createTestSession();
    const sibling = createTestSession();
    const runId = generateRunId();

    try {
      publishTestRunStart(launching, runId);
      await Effect.runPromise(launching.settlePublications());
      const lease = await Effect.runPromise(
        launching.transcripts.acquireRunResidency(runId),
      );
      const handle = createRunTrace(lease);
      const detach = launching.attachRunTrace(handle.trace, runId);
      try {
        const output = handle.trace.openRun(MESSAGE_TYPES.MODEL_RESPONSE);
        output.append('owned by launching session');
        output.finalize();
        await Effect.runPromise(launching.settlePublications());

        expect(
          launching.transcripts
            .get(runId)
            ?.toJSON()
            .map((entry) => entry.text),
        ).toEqual(['owned by launching session']);
        expect(sibling.transcripts.get(runId)).toBeUndefined();
        expect(testDefaultSession().transcripts.get(runId)).toBeUndefined();
      } finally {
        detach();
        handle.dispose();
      }
    } finally {
      await Effect.runPromise(launching.dispose());
      await Effect.runPromise(sibling.dispose());
    }
  });

  it('commits partial streaming text when the run parks', async () => {
    const session = createTestSession();
    const runId = generateRunId();
    publishTestRunStart(session, runId);
    await Effect.runPromise(session.settlePublications());
    const lease = await Effect.runPromise(
      session.transcripts.acquireRunResidency(runId),
    );
    const handle = createRunTrace(lease);
    const detach = session.attachRunTrace(handle.trace, runId);
    try {
      const output = handle.trace.openRun(MESSAGE_TYPES.MODEL_RESPONSE);
      output.append('partial text');
      await Effect.runPromise(session.settlePublications());
      // The `waiting` step parks the run and the loop commits the closure
      // facts in that batch (`loop/toolUse.ts`), so the partial text becomes
      // the row's final text instead of streaming forever.
      session.publish(session.streamClosureFacts(runId));
      await Effect.runPromise(session.settlePublications());
      const entries = await Effect.runPromise(
        session.transcripts.readEntries(runId),
      );
      expect(
        entries
          .filter((entry) => entry.messageType === MESSAGE_TYPES.MODEL_RESPONSE)
          .map((entry) => entry.text),
      ).toEqual(['partial text']);
    } finally {
      detach();
      handle.dispose();
      await Effect.runPromise(session.dispose());
    }
  });

  it('keeps same-stream follow-up queues isolated by session', async () => {
    const a = createTestSession();
    const b = createTestSession();
    const runId = generateRunId();

    try {
      expect(a.followUps.claimLive(runId, 'flow')).toBeDefined();
      expect(b.followUps.claimLive(runId, 'flow')).toBeDefined();

      a.followUps.terminalize(runId);

      expect(a.followUps.hasLiveOwner(runId)).toBe(false);
      expect(
        await Effect.runPromise(
          a.followUps.submit(runId, { text: 'late' }, 'live_owner'),
        ),
      ).toEqual({ kind: 'refused' });
      expect(b.followUps.hasLiveOwner(runId)).toBe(true);
    } finally {
      await Effect.runPromise(a.dispose());
      await Effect.runPromise(b.dispose());
    }
  });
});

describe('sendFollowUp host-path session routing', () => {
  it('resolves the follow-up target against the passed session, not the process default', async () => {
    const processSession = createTestSession();
    const parentRun = publishTestRunStart(processSession);
    await Effect.runPromise(processSession.settlePublications());

    try {
      // A child run is tracked in the explicit process session, as desktop
      // composition does instead of using the module default.
      processSession.runs.track(
        testRunHandle({
          runId: generateRunId(),
          parent: parentRun,
          agent: 'orchestrator',
        }),
      );

      // A host-path caller (outside any run ALS, like the desktop IPC handler)
      // that passes its process session sees the live child and queues.
      await expect(
        Effect.runPromise(
          submitFollowUp(parentRun, 'continue', {
            session: processSession,
          }).pipe(
            Effect.provideService(AgentResume, {
              tryResumeRun: () => Effect.succeed(false),
            }),
          ),
        ),
      ).resolves.toEqual({ status: 'queued', wake: 'failed' });

      // The default session does not own this run; selecting the actual
      // session is required for desktop follow-up delivery. With no live flow
      // and no checkpoint of its own, the classification it falls back to is
      // `finished`.
      await expect(
        Effect.runPromise(
          submitFollowUp(parentRun, 'continue', {
            session: testDefaultSession(),
          }).pipe(
            Effect.provideService(AgentResume, {
              tryResumeRun: () => Effect.succeed(false),
            }),
          ),
        ),
      ).resolves.toEqual({
        status: 'failed',
        reason: 'finished',
      });
    } finally {
      processSession.followUps.terminalize(parentRun);
      await Effect.runPromise(processSession.dispose());
    }
  });
});
