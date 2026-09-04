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
import { BashPermissionSchema, type StreamTabId } from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';
import {
  requestBashApproval,
  setBashApprovalSessionBypass,
} from '@tools/approval/bashApproval';

const sid = (s: string): StreamTabId => s as StreamTabId;

describe('requestBashApproval queueing', () => {
  it('hands the host a schema-valid permission with a prefixed request id and a trimmed cwd', async () => {
    const session = createTestSession();
    const streamId = sid('s:bash-prompt');
    const prompted: HostBashApprovalRequest[] = [];
    session.interactions.use({
      requestBashApproval: async (request) => {
        prompted.push(request);
        return { action: 'approve' };
      },
      cancel: () => undefined,
    });
    const request = (command: string, cwd?: string) =>
      withRunContext(createRunContext({ streamId, session }), () =>
        requestBashApproval({ command, ...(cwd ? { cwd } : {}) }),
      );

    try {
      await request('lake build', ' /work ');
      await request('echo hi', '   ');
      const [first, second] = prompted.map((p) => p.permission);
      expect(BashPermissionSchema.parse(first)).toEqual(first);
      expect(first).toMatchObject({
        command: 'lake build',
        cwd: '/work',
        allowBypass: true,
        streamId,
      });
      expect(first.requestId).toMatch(/^bash-.+/);
      expect(second.requestId).not.toBe(first.requestId);
      expect(second).not.toHaveProperty('cwd');
    } finally {
      session.dispose();
    }
  });

  it('lets never override a stream bypass at the shared boundary', async () => {
    const session = createTestSession();
    const streamId = sid('s:bash-policy-denial');
    let policyDenials = 0;
    let prompts = 0;
    session.setApprovalPolicy('never');
    setBashApprovalSessionBypass(streamId, true, { silent: true, session });
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
          streamId,
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

  it('auto-approves a queued request once the stream is bypassed while it waits', async () => {
    const session = createTestSession();
    const streamId = sid('s:bash-queued-bypass');
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
      withRunContext(createRunContext({ streamId, session }), () =>
        requestBashApproval({ command }),
      );

    try {
      const first = request('echo first');
      const second = request('echo second');
      await firstPrompted.promise;
      expect(prompts).toBe(1);

      // The user answers the first prompt with "approve and stop asking";
      // the second must honor that instead of prompting again.
      setBashApprovalSessionBypass(streamId, true, { silent: true, session });
      firstAnswer.resolve({ action: 'approve' });

      expect(await first).toEqual({ action: 'approve' });
      expect(await second).toEqual({ action: 'approve' });
      expect(prompts).toBe(1);
    } finally {
      session.dispose();
    }
  });
});
