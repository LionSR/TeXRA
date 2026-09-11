// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import pDefer from 'p-defer';
import { describe, expect, it } from 'vitest';

// Local imports
import type {
  BashSettlement,
  HostBashApprovalRequest,
} from '@agent/runtime/HostInteractions';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { BashPermissionSchema } from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';
import { requestBashApproval } from '@tools/approval/bashApproval';
import { generateRunId } from '@utils/core';

describe('requestBashApproval queueing', () => {
  it('lets never override a run bypass at the shared boundary', async () => {
    const session = createTestSession();
    const runId = generateRunId();
    let policyDenials = 0;
    let prompts = 0;
    session.setApprovalPolicy('never');
    session.approvals.bash.bypass.setBypass(runId, true, { silent: true });
    session.interactions.use({
      requestBashApproval: async () => {
        prompts += 1;
        return { action: 'approve' };
      },
      cancel: () => undefined,
    });

    try {
      const result = await withRunContext(
        createRunContext({
          runId,
          session,
          onApprovalPolicyDenial: () => {
            policyDenials += 1;
          },
        }),
        () => requestBashApproval({ command: 'echo denied' }),
      );

      expect(result).toEqual({
        action: 'reject',
        reason: 'Denied by TeXRA approval policy.',
      });
      expect(policyDenials).toBe(1);
      expect(prompts).toBe(0);
    } finally {
      session.dispose();
    }
  });

  it('auto-approves a queued request once the run is bypassed while it waits', async () => {
    const session = createTestSession();
    const runId = generateRunId();
    const firstPrompted = pDefer<void>();
    const firstAnswer = pDefer<BashSettlement>();
    let prompts = 0;

    session.interactions.use({
      requestBashApproval: () => {
        prompts += 1;
        firstPrompted.resolve();
        return firstAnswer.promise;
      },
      cancel: () => undefined,
    });

    const request = (command: string) =>
      withRunContext(createRunContext({ runId, session }), () =>
        requestBashApproval({ command }),
      );

    try {
      const first = request('echo first');
      const second = request('echo second');
      await firstPrompted.promise;
      expect(prompts).toBe(1);

      // The user answers the first prompt with "approve and stop asking";
      // the second must honor that instead of prompting again.
      session.approvals.bash.bypass.setBypass(runId, true, { silent: true });
      firstAnswer.resolve({ action: 'approve' });

      expect(await first).toEqual({ action: 'approve' });
      expect(await second).toEqual({ action: 'approve' });
      expect(prompts).toBe(1);
    } finally {
      session.dispose();
    }
  });
});
