import { describe, expect, it, vi } from 'vitest';

import {
  cancelRuntimeRetry,
  clearRuntimeRetryRequest,
  resolveRuntimePlanApproval,
  resolveRuntimeProposal,
  triggerRuntimeRetry,
} from '@agent/runtime/runCoordinatorCommands';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import type { StreamTabId } from '@shared/schemas';

describe('runtime run-coordinator commands', () => {
  it('routes approval and retry decisions through the session coordinator bridge', () => {
    const session = new SessionHandle();
    const streamId = 'coordinator-command-stream' as StreamTabId;
    const resolvePlanApproval = vi
      .spyOn(session.coordinators, 'resolvePlanApproval')
      .mockReturnValue(true);
    const resolveProposal = vi
      .spyOn(session.coordinators, 'resolveProposal')
      .mockReturnValue(true);
    const triggerRetry = vi
      .spyOn(session.coordinators, 'triggerRetry')
      .mockReturnValue(true);
    const cancelRetry = vi
      .spyOn(session.coordinators, 'cancelRetry')
      .mockReturnValue(true);
    const clearRetryRequest = vi
      .spyOn(session.coordinators, 'clearRetryRequest')
      .mockReturnValue(undefined);

    try {
      expect(
        resolveRuntimePlanApproval({
          approvalId: 'approval-1',
          result: { action: 'approve' },
          session,
        }),
      ).toBe(true);
      expect(
        resolveRuntimeProposal({
          proposalId: 'proposal-1',
          result: { action: 'reject', feedback: 'Not now.' },
          session,
        }),
      ).toBe(true);
      expect(
        triggerRuntimeRetry({
          streamId,
          feedback: 'Try with a smaller step.',
          session,
        }),
      ).toBe(true);
      expect(cancelRuntimeRetry({ streamId, session })).toBe(true);
      clearRuntimeRetryRequest({ streamId, session });

      expect(resolvePlanApproval).toHaveBeenCalledWith('approval-1', {
        action: 'approve',
      });
      expect(resolveProposal).toHaveBeenCalledWith('proposal-1', {
        action: 'reject',
        feedback: 'Not now.',
      });
      expect(triggerRetry).toHaveBeenCalledWith(
        streamId,
        'Try with a smaller step.',
      );
      expect(cancelRetry).toHaveBeenCalledWith(streamId);
      expect(clearRetryRequest).toHaveBeenCalledWith(streamId);
    } finally {
      session.dispose();
    }
  });
});
