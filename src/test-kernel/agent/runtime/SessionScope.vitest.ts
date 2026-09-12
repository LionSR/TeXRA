import '@test/support/defaultSessionTestSetup';

import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';

import { defaultSession } from '@agent/runtime/SessionHandle';
import { submitFollowUp } from '@agent/followUp/ToolUseFollowUp';
import { MESSAGE_TYPES, type RunId } from '@shared/schemas';
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
      await launching.settlePublications();
      const lease = await Effect.runPromise(
        launching.transcripts.acquireRunResidency(runId),
      );
      const handle = createRunTrace(lease);
      const detach = launching.attachRunTrace(handle.trace, runId);
      try {
        const output = handle.trace.openRun(MESSAGE_TYPES.MODEL_RESPONSE);
        output.append('owned by launching session');
        output.finalize();
        await launching.settlePublications();

        expect(
          launching.transcripts
            .get(runId)
            ?.toJSON()
            .map((entry) => entry.text),
        ).toEqual(['owned by launching session']);
        expect(sibling.transcripts.get(runId)).toBeUndefined();
        expect(defaultSession().transcripts.get(runId)).toBeUndefined();
      } finally {
        detach();
        handle.dispose();
      }
    } finally {
      launching.dispose();
      sibling.dispose();
    }
  });

  it('commits partial streaming text when the run parks', async () => {
    const session = createTestSession();
    const runId = generateRunId();
    publishTestRunStart(session, runId);
    await session.settlePublications();
    const lease = await Effect.runPromise(
      session.transcripts.acquireRunResidency(runId),
    );
    const handle = createRunTrace(lease);
    const detach = session.attachRunTrace(handle.trace, runId);
    try {
      const output = handle.trace.openRun(MESSAGE_TYPES.MODEL_RESPONSE);
      output.append('partial text');
      await session.settlePublications();
      // The `waiting` step parks the run and the loop commits the closure
      // facts in that batch (`loop/toolUse.ts`), so the partial text becomes
      // the row's final text instead of streaming forever.
      session.publish(session.streamClosureFacts(runId));
      await session.settlePublications();
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
      session.dispose();
    }
  });

  it('keeps same-stream follow-up queues isolated by session', () => {
    const a = createTestSession();
    const b = createTestSession();
    const runId = generateRunId();

    try {
      a.followUps.submit(runId, { text: 'from a' }, 'recoverable');
      b.followUps.submit(runId, { text: 'from b' }, 'recoverable');

      a.followUps.terminalize(runId);

      expect(a.followUps.getAll(runId)).toEqual([]);
      expect(b.followUps.getAll(runId)).toEqual(['from b']);
    } finally {
      a.dispose();
      b.dispose();
    }
  });
});

describe('sendFollowUp host-path session routing', () => {
  it('resolves the follow-up target against the passed session, not the process default', async () => {
    const processSession = createTestSession();
    const parentRun = generateRunId();

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
            resumePort: { tryResumeRun: async () => false },
          }),
        ),
      ).resolves.toEqual({ status: 'queued', wake: 'failed' });

      // The default session does not own this run; selecting the actual
      // session is required for desktop follow-up delivery. With no live flow
      // and no checkpoint of its own, the classification it falls back to is
      // `finished`.
      await expect(
        Effect.runPromise(
          submitFollowUp(parentRun, 'continue', {
            session: defaultSession(),
          }),
        ),
      ).resolves.toEqual({
        status: 'failed',
        reason: 'finished',
      });
    } finally {
      processSession.followUps.terminalize(parentRun);
      processSession.dispose();
    }
  });
});
