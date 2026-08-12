import '@test/support/defaultSessionTestSetup';

import { describe, expect, it } from 'vitest';

import { defaultSession } from '@agent/runtime/SessionHandle';
import { submitFollowUp } from '@agent/followUp/ToolUseFollowUp';
import { MESSAGE_TYPES, type Plan, type StreamTabId } from '@shared/schemas';
import { testExecutionHandle } from '@test/support/executionHandleFixtures';
import { createTestSession } from '@test/support/sessionTestUtils';
import { cleanupAllApprovals } from '@tools/approval';
import { createRunTrace, StreamLogStore } from '@transcript';
import { createRecordingHost } from '../progressTestUtils';

const plan: Plan = { objective: 'Scope session-owned state.' };

describe('session-scoped trace flushers', () => {
  it('registers the flush in the run session set, not the default set', () => {
    const store = StreamLogStore.ephemeral('test');
    const sessionB = createTestSession();
    try {
      const defaultBefore = defaultSession().flushers.size;
      const handle = createRunTrace(
        'stream:flusher-b' as StreamTabId,
        store,
        sessionB.flushers,
      );

      expect(sessionB.flushers.size).toBe(1);
      // The default (process) set did not gain this session's stream flush.
      expect(defaultSession().flushers.size).toBe(defaultBefore);
      expect(() => sessionB.flushPendingTraces()).not.toThrow();

      handle.dispose();
      expect(sessionB.flushers.size).toBe(0);
    } finally {
      sessionB.dispose();
    }
  });

  it("does not drain another session's trace flushers", () => {
    const store = StreamLogStore.ephemeral('test');
    const sessionB = createTestSession();
    let drained = 0;

    const handle = createRunTrace(
      'stream:flusher-dispose' as StreamTabId,
      store,
      sessionB.flushers,
    );
    sessionB.flushers.set('manual', {
      state: 'active',
      flush: () => {
        drained += 1;
      },
    });

    defaultSession().flushPendingTraces();
    expect(drained).toBe(0);

    sessionB.flushPendingTraces();
    expect(drained).toBeGreaterThan(0);
    handle.dispose();
    sessionB.dispose();
  });
});

describe('session-owned transcripts and follow-up queues', () => {
  it("writes run trace entries to the launching session's transcript store only", () => {
    const launching = createTestSession();
    const sibling = createTestSession();
    const streamId = 'stream:session-transcript-owner' as StreamTabId;

    try {
      const handle = createRunTrace(
        streamId,
        launching.transcripts,
        launching.flushers,
      );
      try {
        const output = handle.trace.openStream(MESSAGE_TYPES.MODEL_RESPONSE);
        output.append('owned by launching session');

        expect(
          launching.transcripts
            .get(streamId)
            ?.getRange(0)
            .map((entry) => entry.text),
        ).toEqual(['owned by launching session']);
        expect(sibling.transcripts.get(streamId)).toBeUndefined();
        expect(defaultSession().transcripts.get(streamId)).toBeUndefined();
      } finally {
        handle.dispose();
      }
    } finally {
      launching.dispose();
      sibling.dispose();
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

describe('cleanupAllApprovals scope', () => {
  it("clears only the given session's pending interactions", async () => {
    const a = createTestSession();
    const b = createTestSession();
    const hostA = createRecordingHost();
    const hostB = createRecordingHost();
    const streamId = 'stream:approval-scope' as StreamTabId;
    a.useHostInteractions(hostA.interactions);
    b.useHostInteractions(hostB.interactions);

    try {
      const planA = a.interactions.requestPlanApproval({
        approvalId: 'approval:a',
        streamId,
        plan,
        goalEnabled: false,
      });
      const planB = b.interactions.requestPlanApproval({
        approvalId: 'approval:b',
        streamId,
        plan,
        goalEnabled: false,
      });

      cleanupAllApprovals(a);

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
        submitFollowUp(parentStream, 'continue', {
          session: processSession,
          resumePort: { tryResumeStream: async () => false },
        }),
      ).resolves.toEqual({
        status: 'queued',
        reason: 'children_running',
        continuation: 'resume_failed',
      });

      // Without the session it falls back to the default session, which does
      // not track this run — this is the dropped-follow-up regression the
      // session parameter prevents on desktop.
      await expect(submitFollowUp(parentStream, 'continue')).resolves.toEqual({
        status: 'no_session',
        streamStatus: undefined,
      });
    } finally {
      processSession.followUps.terminalize(parentStream);
      processSession.dispose();
    }
  });
});
