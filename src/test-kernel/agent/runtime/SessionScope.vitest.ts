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
import { SessionHandle } from '@agent/runtime/SessionHandle';
import { type Plan, type StreamTabId } from '@shared/schemas';
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
        b.coordinators.resolvePlanApproval('approval:b', { action: 'approve' }),
      ).toBe(true);
      await expect(planB).resolves.toEqual({ action: 'approve' });
    } finally {
      a.dispose();
      b.dispose();
    }
  });
});
