// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - runtime
import {
  createRunTrace,
  flushPendingRunTraces,
  getActiveFlushers,
  getDefaultStreamLogStore,
  setDefaultStreamLogStore,
  StreamLogStore,
} from '@transcript';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { AgentProposalCoordinator } from '@agent/runtime/AgentProposalCoordinator';
import { PlanApprovalCoordinator } from '@agent/runtime/PlanApprovalCoordinator';
import { RetryRequestCoordinatorImpl } from '@agent/runtime/RetryRequestCoordinator';
import {
  createRunContext,
  withRunContext,
  type RunCoordinators,
} from '@agent/runtime/RunContext';
import {
  SessionHandle,
  getAllActiveExecutionIds,
} from '@agent/runtime/SessionHandle';
import { AgentExecutionHandle } from '@agent/runtime/executionRegistry';
import { sendFollowUp } from '@agent/followUp/ToolUseFollowUp';
import { MESSAGE_TYPES, type Plan, type StreamTabId } from '@shared/schemas';
import { cleanupAllApprovals } from '@tools/approval';

import { createRecordingHost } from '../progressTestUtils';

const plan: Plan = { objective: 'Scope session-owned state.' };

function createCoordinators(host: AgentRuntimeHost): RunCoordinators {
  return {
    plan: new PlanApprovalCoordinator(host),
    proposal: new AgentProposalCoordinator(host),
    retry: new RetryRequestCoordinatorImpl(host),
  };
}

describe('cross-session active executions (SDK Step 7d PR 4)', () => {
  it('aggregates active execution ids across live sessions and drops them on dispose', () => {
    const a = new SessionHandle();
    const b = new SessionHandle();
    const { host } = createRecordingHost();
    const track = (session: SessionHandle, id: string): void => {
      session.executions.track(
        new AgentExecutionHandle(
          id,
          `${id}-stream` as StreamTabId,
          `${id}-stream` as StreamTabId,
          'orchestrator',
          'toolUse',
          host,
          createCoordinators(host),
        ),
      );
    };

    try {
      track(a, 'exec:agg-a');
      track(b, 'exec:agg-b');

      const ids = getAllActiveExecutionIds();
      expect(ids).toContain('exec:agg-a');
      expect(ids).toContain('exec:agg-b');

      // Disposing one session removes only its executions from the aggregate.
      a.dispose();
      const after = getAllActiveExecutionIds();
      expect(after).not.toContain('exec:agg-a');
      expect(after).toContain('exec:agg-b');
    } finally {
      a.dispose();
      b.dispose();
    }
  });
});

describe('session-scoped trace flushers (SDK Step 7d PR 3)', () => {
  it('registers the flush in the run session set, not the default set', () => {
    const previousStore = getDefaultStreamLogStore();
    const store = new StreamLogStore();
    setDefaultStreamLogStore(store);
    const sessionB = new SessionHandle();
    try {
      const defaultBefore = getActiveFlushers().size;
      const handle = createRunTrace(
        'stream:flusher-b' as StreamTabId,
        store,
        sessionB.flushers,
      );

      expect(sessionB.flushers.size).toBe(1);
      // The default (process) set did not gain this session's stream flush.
      expect(getActiveFlushers().size).toBe(defaultBefore);
      // The process-wide drain still reaches the registered session set.
      expect(() => flushPendingRunTraces()).not.toThrow();

      handle.dispose();
      expect(sessionB.flushers.size).toBe(0);
    } finally {
      setDefaultStreamLogStore(previousStore);
      sessionB.dispose();
    }
  });

  it("drops the disposed session's flusher set from the process-wide drain", () => {
    const previousStore = getDefaultStreamLogStore();
    const store = new StreamLogStore();
    setDefaultStreamLogStore(store);
    const sessionB = new SessionHandle();
    let drained = 0;

    try {
      // Registers sessionB.flushers in the process-wide drain registry.
      createRunTrace(
        'stream:flusher-dispose' as StreamTabId,
        store,
        sessionB.flushers,
      );
      sessionB.flushers.add(() => {
        drained += 1;
      });

      flushPendingRunTraces();
      // While live, the session's set is reached by the process-wide drain.
      expect(drained).toBeGreaterThan(0);

      sessionB.dispose();

      drained = 0;
      flushPendingRunTraces();
      // After dispose the set is unregistered — no longer iterated forever.
      expect(drained).toBe(0);
    } finally {
      setDefaultStreamLogStore(previousStore);
    }
  });
});

describe('session-owned transcripts and follow-up queues (Stage 3a)', () => {
  it("writes run trace entries to the launching session's transcript store only", () => {
    const launching = new SessionHandle();
    const sibling = new SessionHandle();
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
        expect(getDefaultStreamLogStore().get(streamId)).toBeUndefined();
      } finally {
        handle.dispose();
      }
    } finally {
      launching.dispose();
      sibling.dispose();
    }
  });

  it('keeps same-stream follow-up queues isolated by session', () => {
    const a = new SessionHandle();
    const b = new SessionHandle();
    const streamId = 'stream:session-followups' as StreamTabId;

    try {
      a.followUps.acquire(streamId);
      b.followUps.acquire(streamId);
      a.followUps.enqueue(streamId, { text: 'from a' });
      b.followUps.enqueue(streamId, { text: 'from b' });

      a.followUps.release(streamId);

      expect(a.followUps.getAll(streamId)).toEqual([]);
      expect(b.followUps.getAll(streamId)).toEqual(['from b']);
    } finally {
      a.dispose();
      b.dispose();
    }
  });
});

describe('cleanupAllApprovals scope (SDK Step 7d PR 3)', () => {
  it("clears only the given session's coordinator requests", async () => {
    const a = new SessionHandle();
    const b = new SessionHandle();
    const hostA = createRecordingHost();
    const hostB = createRecordingHost();
    const coordA = createCoordinators(hostA.host);
    const coordB = createCoordinators(hostB.host);
    const streamId = 'stream:approval-scope' as StreamTabId;

    try {
      const planA = withRunContext(
        createRunContext({ runtimeHost: hostA.host, coordinators: coordA }),
        () =>
          a.coordinators.waitForPlanApproval(streamId, {
            approvalId: 'approval:a',
            plan,
          }),
      );
      const planB = withRunContext(
        createRunContext({ runtimeHost: hostB.host, coordinators: coordB }),
        () =>
          b.coordinators.waitForPlanApproval(streamId, {
            approvalId: 'approval:b',
            plan,
          }),
      );

      cleanupAllApprovals(a);

      await expect(planA).resolves.toEqual({ action: 'reject' });
      // Session B's request is untouched and still resolvable.
      expect(
        hostB.host.interactions?.resolve('approval:b', {
          kind: 'plan',
          action: 'approve',
        }),
      ).toBe(true);
      await expect(planB).resolves.toEqual({ action: 'approve' });
    } finally {
      a.dispose();
      b.dispose();
    }
  });
});

describe('sendFollowUp host-path session routing (SDK Step 7d PR 4)', () => {
  it('resolves the follow-up target against the passed session, not the process default', async () => {
    const windowSession = new SessionHandle();
    const { host } = createRecordingHost();
    const parentStream = 'stream:fu-parent' as StreamTabId;

    try {
      // A child run is tracked in the per-window session, exactly as a desktop
      // run is after PR 4 (launched with { session: this.session }).
      windowSession.executions.track(
        new AgentExecutionHandle(
          'exec:fu-child',
          parentStream,
          'stream:fu-child' as StreamTabId,
          'orchestrator',
          'toolUse',
          host,
          createCoordinators(host),
        ),
      );

      // A host-path caller (outside any run ALS, like the desktop IPC handler)
      // that passes its window session sees the live child and queues.
      await expect(
        sendFollowUp(
          parentStream,
          'continue',
          undefined,
          undefined,
          windowSession,
        ),
      ).resolves.toEqual({ status: 'queued', reason: 'children_running' });

      // Without the session it falls back to the default session, which does
      // not track this run — this is the dropped-follow-up regression the
      // session parameter prevents on desktop.
      await expect(sendFollowUp(parentStream, 'continue')).resolves.toEqual({
        status: 'no_session',
        streamStatus: undefined,
      });
    } finally {
      windowSession.followUps.release(parentStream);
      windowSession.dispose();
    }
  });
});
