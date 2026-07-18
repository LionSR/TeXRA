// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Test support imports
import { createTestSession } from '@test/support/sessionTestUtils';

// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { noopAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { StreamTabId } from '@shared/schemas';
import {
  cleanupApprovalsForStream,
  cleanupUnscopedApprovals,
  isBashApprovalBypassedForStream,
  proposalApprovals,
  setDelegatedWorkApprovalBypasses,
  setBashApprovalSessionBypass,
} from '@tools/approval';

const sid = (s: string): StreamTabId => s as StreamTabId;

function createPending(id: string, settled: Set<string>, streamId = '') {
  let isSettled = false;
  return {
    streamId: streamId as StreamTabId,
    isSettled: () => isSettled,
    settle: () => {
      isSettled = true;
      settled.add(id);
    },
  };
}

describe('approval cleanup scope (SDK Step 7d residue #5)', () => {
  it("per-stream cleanup leaves another stream's approval state intact", () => {
    const a = sid('s:appr-scope-a');
    const b = sid('s:appr-scope-b');
    setBashApprovalSessionBypass(a, true, noopAgentRuntimeHost, {
      silent: true,
    });
    setBashApprovalSessionBypass(b, true, noopAgentRuntimeHost, {
      silent: true,
    });

    try {
      // A desktop window deleting its own stream `a` scopes the sweep to `a`
      // (this is what `deleteAllStreams` loops), so a sibling stream `b` keeps
      // its pending approval / bypass state.
      cleanupApprovalsForStream(a);
      expect(isBashApprovalBypassedForStream(a)).toBe(false);
      expect(isBashApprovalBypassedForStream(b)).toBe(true);
    } finally {
      cleanupApprovalsForStream(b);
    }
  });

  it('scopes streamless cleanup to the owning session', () => {
    const sessionA = createTestSession();
    const sessionB = createTestSession();
    const cancelA = vi.fn();
    sessionA.useHostInteractions({ cancel: cancelA });
    const settled = new Set<string>();

    try {
      sessionA.approvals.toolEdit.registerPending(
        'tool-a',
        createPending('tool-a', settled),
      );
      sessionB.approvals.toolEdit.registerPending(
        'tool-b',
        createPending('tool-b', settled),
      );
      sessionA.approvals.bash.registerPending(
        'bash-a',
        createPending('bash-a', settled),
      );
      sessionB.approvals.bash.registerPending(
        'bash-b',
        createPending('bash-b', settled),
      );

      cleanupUnscopedApprovals(sessionA);

      // Only session A's streamless approvals are rejected; session B's stay
      // pending even though they are equally streamless.
      expect(settled).toEqual(new Set(['tool-a', 'bash-a']));
      expect(cancelA).toHaveBeenCalledWith({
        streamId: null,
        cause: 'Streamless approval cleanup.',
      });

      cleanupUnscopedApprovals(sessionB);

      expect(settled).toEqual(
        new Set(['tool-a', 'bash-a', 'tool-b', 'bash-b']),
      );
    } finally {
      sessionA.approvals.toolEdit.unregisterPending('tool-a');
      sessionB.approvals.toolEdit.unregisterPending('tool-b');
      sessionA.approvals.bash.unregisterPending('bash-a');
      sessionB.approvals.bash.unregisterPending('bash-b');
      sessionA.dispose();
      sessionB.dispose();
    }
  });
});

describe('session-owned approval state (#8144)', () => {
  it('keeps complete delegated-task approval grants within their owning session', () => {
    const sessionA = createTestSession();
    const sessionB = createTestSession();
    const streamId = sid('s:delegated-approval-same-id');

    try {
      setDelegatedWorkApprovalBypasses(
        streamId,
        true,
        noopAgentRuntimeHost,
        sessionA,
      );

      expect(proposalApprovals(sessionA).isBypassed(streamId)).toBe(true);
      expect(sessionA.approvals.toolEdit.bypass.isBypassed(streamId)).toBe(
        true,
      );
      expect(sessionA.approvals.bash.bypass.isBypassed(streamId)).toBe(true);
      expect(proposalApprovals(sessionB).isBypassed(streamId)).toBe(false);
      expect(sessionB.approvals.toolEdit.bypass.isBypassed(streamId)).toBe(
        false,
      );
      expect(sessionB.approvals.bash.bypass.isBypassed(streamId)).toBe(false);

      cleanupApprovalsForStream(streamId, sessionA);
      expect(proposalApprovals(sessionA).isBypassed(streamId)).toBe(false);
      expect(proposalApprovals(sessionB).isBypassed(streamId)).toBe(false);
    } finally {
      sessionA.dispose();
      sessionB.dispose();
    }
  });

  it('keeps bypass state for equal stream ids isolated between sessions', () => {
    const sessionA = createTestSession();
    const sessionB = createTestSession();
    const streamId = sid('s:appr-same-id');

    try {
      setBashApprovalSessionBypass(streamId, true, noopAgentRuntimeHost, {
        silent: true,
        session: sessionA,
      });

      expect(isBashApprovalBypassedForStream(streamId, sessionA)).toBe(true);
      // The same stream identifier in a sibling session stays gated.
      expect(isBashApprovalBypassedForStream(streamId, sessionB)).toBe(false);
      // And the process default session is untouched as well.
      expect(isBashApprovalBypassedForStream(streamId)).toBe(false);
    } finally {
      sessionA.dispose();
      sessionB.dispose();
    }
  });

  it("an unanswered approval in one session does not delay another session's queue", async () => {
    const sessionA = createTestSession();
    const sessionB = createTestSession();

    try {
      // Session A's prompt slot is occupied by a never-answered approval.
      void sessionA.approvals.bash.enqueue(
        undefined,
        () => new Promise(() => {}),
      );

      const ranInB = sessionB.approvals.bash.enqueue(undefined, () =>
        Promise.resolve('answered'),
      );

      await expect(ranInB).resolves.toBe('answered');
    } finally {
      sessionA.dispose();
      sessionB.dispose();
    }
  });

  it('session disposal rejects its remaining pending approvals and clears bypass state', () => {
    const session = createTestSession();
    const streamId = sid('s:appr-dispose');
    const settled = new Set<string>();

    session.approvals.toolEdit.registerPending(
      'tool-dispose',
      createPending('tool-dispose', settled, streamId),
    );
    setBashApprovalSessionBypass(streamId, true, noopAgentRuntimeHost, {
      silent: true,
      session,
    });

    session.dispose();

    expect(settled).toEqual(new Set(['tool-dispose']));
    expect(isBashApprovalBypassedForStream(streamId, session)).toBe(false);
  });
});
