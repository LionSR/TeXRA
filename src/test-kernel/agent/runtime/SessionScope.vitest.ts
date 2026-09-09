import '@test/support/defaultSessionTestSetup';

import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';

import { defaultSession } from '@agent/runtime/SessionHandle';
import { submitFollowUp } from '@agent/followUp/ToolUseFollowUp';
import {
  MESSAGE_TYPES,
  STREAM_PHASE,
  type Plan,
  type StreamTabId,
} from '@shared/schemas';
import { testExecutionHandle } from '@test/support/executionHandleFixtures';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { createRunTrace } from '@transcript';
import { createRecordingHost } from '../progressTestUtils';

const plan: Plan = { objective: 'Scope session-owned state.' };

describe('session-owned transcripts and follow-up queues', () => {
  it("writes run trace entries to the launching session's transcript store only", async () => {
    const launching = createTestSession();
    const sibling = createTestSession();
    const streamId = 'stream:session-transcript-owner' as StreamTabId;

    try {
      publishTestRunStart(launching, streamId);
      await launching.settlePublications();
      const lease = await Effect.runPromise(
        launching.transcripts.acquireRunResidency(streamId, streamId),
      );
      const handle = createRunTrace(lease);
      const detach = launching.attachRunTrace(handle, streamId);
      try {
        const output = handle.trace.openStream(MESSAGE_TYPES.MODEL_RESPONSE);
        output.append('owned by launching session');
        output.finalize();
        await launching.settlePublications();

        expect(
          launching.transcripts
            .get(streamId)
            ?.getRange(0)
            .map((entry) => entry.text),
        ).toEqual(['owned by launching session']);
        expect(sibling.transcripts.get(streamId)).toBeUndefined();
        expect(defaultSession().transcripts.get(streamId)).toBeUndefined();
      } finally {
        detach();
        handle.dispose();
      }
    } finally {
      launching.dispose();
      sibling.dispose();
    }
  });

  it('commits partial streaming text when status closes the run', async () => {
    const session = createTestSession();
    const streamId = 'stream:partial-status-close' as StreamTabId;
    publishTestRunStart(session, streamId);
    await session.settlePublications();
    const lease = await Effect.runPromise(
      session.transcripts.acquireRunResidency(streamId, streamId),
    );
    const handle = createRunTrace(lease);
    const detach = session.attachRunTrace(handle, streamId);
    try {
      const output = handle.trace.openStream(MESSAGE_TYPES.MODEL_RESPONSE);
      output.append('partial text');
      session.publishStatus({
        type: 'status',
        streamId,
        phase: STREAM_PHASE.WAITING,
        cause: 'wait',
      });
      await session.settlePublications();
      const entries = await Effect.runPromise(
        session.transcripts.readEntries(streamId),
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
    const streamId = 'stream:session-followups' as StreamTabId;

    try {
      a.followUps.submit(streamId, { text: 'from a' }, 'recoverable');
      b.followUps.submit(streamId, { text: 'from b' }, 'recoverable');

      a.followUps.terminalize(streamId);

      expect(a.followUps.getAll(streamId)).toEqual([]);
      expect(b.followUps.getAll(streamId)).toEqual(['from b']);
    } finally {
      a.dispose();
      b.dispose();
    }
  });
});

describe('approval reset scope', () => {
  it("clears only the given session's pending interactions", async () => {
    const a = createTestSession();
    const b = createTestSession();
    const hostA = createRecordingHost();
    const hostB = createRecordingHost();
    const streamId = 'stream:approval-scope' as StreamTabId;
    a.interactions.use(hostA.interactions);
    b.interactions.use(hostB.interactions);

    try {
      const planA = a.interactions.requestPlanApproval({
        requestId: 'approval:a',
        streamId,
        plan,
        goalEnabled: false,
      });
      const planB = b.interactions.requestPlanApproval({
        requestId: 'approval:b',
        streamId,
        plan,
        goalEnabled: false,
      });

      a.approvals.clearAll();
      a.interactions.cancel({ cause: 'All approvals cleared.' });

      await expect(planA).resolves.toEqual({ action: 'reject' });
      // Session B's request is untouched and still resolvable.
      expect(
        hostB.decisions.submitPlan('approval:b', { action: 'approve' }),
      ).toBe(true);
      await expect(planB).resolves.toEqual({ action: 'approve' });
    } finally {
      a.dispose();
      b.dispose();
    }
  });
});

describe('sendFollowUp host-path session routing', () => {
  it('resolves the follow-up target against the passed session, not the process default', async () => {
    const processSession = createTestSession();
    const parentStream = 'stream:fu-parent' as StreamTabId;

    try {
      // A child run is tracked in the explicit process session, as desktop
      // composition does instead of using the module default.
      processSession.executions.track(
        testExecutionHandle({
          executionId: 'exec:fu-child',
          parentStreamId: parentStream,
          childStreamId: 'stream:fu-child' as StreamTabId,
          agent: 'orchestrator',
        }),
      );

      // A host-path caller (outside any run ALS, like the desktop IPC handler)
      // that passes its process session sees the live child and queues.
      await expect(
        Effect.runPromise(
          submitFollowUp(parentStream, 'continue', {
            session: processSession,
            resumePort: { tryResumeStream: async () => false },
          }),
        ),
      ).resolves.toEqual({ status: 'queued', wake: 'failed' });

      // The default session does not own this run; selecting the actual
      // session is required for desktop follow-up delivery.
      await expect(
        Effect.runPromise(
          submitFollowUp(parentStream, 'continue', {
            session: defaultSession(),
          }),
        ),
      ).resolves.toEqual({
        status: 'failed',
        reason: 'not_resumable',
      });
    } finally {
      processSession.followUps.terminalize(parentStream);
      processSession.dispose();
    }
  });
});
