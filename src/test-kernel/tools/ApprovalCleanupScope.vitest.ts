// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { noopAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import type { StreamTabId } from '@shared/schemas';
import {
  cleanupApprovalsForStream,
  cleanupUnscopedApprovals,
  isBashApprovalBypassedForStream,
  setBashApprovalSessionBypass,
} from '@tools/approval';
import {
  registerPendingApproval,
  unregisterPendingApproval,
} from '@tools/approval/toolEditApproval';

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
    const sessionA = new SessionHandle();
    const sessionB = new SessionHandle();
    const cancelA = vi.fn();
    sessionA.useHostInteractions({ resolve: () => false, cancel: cancelA });
    const settled = new Set<string>();

    try {
      registerPendingApproval(
        'tool-a',
        createPending('tool-a', settled),
        sessionA,
      );
      registerPendingApproval(
        'tool-b',
        createPending('tool-b', settled),
        sessionB,
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
      unregisterPendingApproval('tool-a', sessionA);
      unregisterPendingApproval('tool-b', sessionB);
      sessionA.approvals.bash.unregisterPending('bash-a');
      sessionB.approvals.bash.unregisterPending('bash-b');
      sessionA.dispose();
      sessionB.dispose();
    }
  });
});

describe('session-owned approval state (#8144)', () => {
  it('keeps bypass state for equal stream ids isolated between sessions', () => {
    const sessionA = new SessionHandle();
    const sessionB = new SessionHandle();
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
    const sessionA = new SessionHandle();
    const sessionB = new SessionHandle();

    try {
      // Session A's prompt slot is occupied by a never-answered approval.
      void sessionA.approvals.bash.enqueue(() => new Promise(() => {}));

      const ranInB = sessionB.approvals.bash.enqueue(() =>
        Promise.resolve('answered'),
      );

      await expect(ranInB).resolves.toBe('answered');
    } finally {
      sessionA.dispose();
      sessionB.dispose();
    }
  });

  it('session disposal rejects its remaining pending approvals and clears bypass state', () => {
    const session = new SessionHandle();
    const streamId = sid('s:appr-dispose');
    const settled = new Set<string>();

    registerPendingApproval(
      'tool-dispose',
      createPending('tool-dispose', settled, streamId),
      session,
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
