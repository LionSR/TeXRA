// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import pDefer from 'p-defer';
import { describe, expect, it } from 'vitest';

// Local imports
import type { BashSettlement } from '@agent/runtime/HostInteractions';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { BashPermissionSchema, type StreamTabId } from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';
import {
  prepareBashApprovalPrompt,
  requestBashApproval,
  setBashApprovalSessionBypass,
} from '@tools/approval/bashApproval';

const sid = (s: string): StreamTabId => s as StreamTabId;

describe('prepareBashApprovalPrompt', () => {
  it('builds a schema-valid payload with a unique prefixed request id', () => {
    const first = prepareBashApprovalPrompt({
      command: 'lake build',
      cwd: '/work',
      streamId: sid('s:bash-prompt'),
    });
    const second = prepareBashApprovalPrompt({ command: 'lake build' });

    expect(BashPermissionSchema.parse(first)).toEqual(first);
    expect(first).toMatchObject({
      command: 'lake build',
      cwd: '/work',
      allowBypass: true,
      streamId: 's:bash-prompt',
    });
    expect(first.requestId).toMatch(/^bash-.+/);
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.streamId).toBe('');
  });

  it('omits a blank or whitespace-only working directory', () => {
    expect(
      prepareBashApprovalPrompt({ command: 'echo hi' }),
    ).not.toHaveProperty('cwd');
    expect(
      prepareBashApprovalPrompt({ command: 'echo hi', cwd: '   ' }),
    ).not.toHaveProperty('cwd');
    expect(
      prepareBashApprovalPrompt({ command: 'echo hi', cwd: ' /work ' }).cwd,
    ).toBe('/work');
  });

  it('drops the bypass affordance for an already-bypassed stream', () => {
    const session = createTestSession();
    const streamId = sid('s:bash-prompt-bypassed');
    setBashApprovalSessionBypass(streamId, true, { silent: true, session });

    expect(
      prepareBashApprovalPrompt({ command: 'echo hi', streamId }, session)
        .allowBypass,
    ).toBe(false);
    expect(
      prepareBashApprovalPrompt(
        { command: 'echo hi', streamId: sid('s:bash-prompt-other') },
        session,
      ).allowBypass,
    ).toBe(true);
  });
});

describe('requestBashApproval queueing', () => {
  it('lets never override a stream bypass at the shared boundary', async () => {
    const session = createTestSession();
    const streamId = sid('s:bash-policy-denial');
    let policyDenials = 0;
    let prompts = 0;
    session.setApprovalPolicy('never');
    setBashApprovalSessionBypass(streamId, true, { silent: true, session });
    session.useHostInteractions({
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
        feedback: 'Denied by TeXRA approval policy.',
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

    session.useHostInteractions({
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
