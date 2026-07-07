// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import {
  noopAgentRuntimeHost,
  type AgentRuntimeHost,
} from '@agent/runtime/AgentRuntimeHost';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import type { StreamTabId } from '@shared/schemas';
import {
  cleanupApprovalsForStream,
  cleanupUnscopedApprovals,
  isBashApprovalBypassedForStream,
  setBashApprovalSessionBypass,
} from '@tools/approval';
import { bashApprovalController } from '@tools/approval/bashApproval';
import {
  registerPendingApproval,
  unregisterPendingApproval,
} from '@tools/approval/toolEditApproval';

const sid = (s: string): StreamTabId => s as StreamTabId;
const host = (): AgentRuntimeHost => ({ emit: () => {} });

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
      // (this is what `deleteAllStreams` loops, instead of the process-wide
      // `cleanupAllApprovals` reset) — so a sibling window's stream `b` keeps
      // its pending approval / bypass state.
      cleanupApprovalsForStream(a);
      expect(isBashApprovalBypassedForStream(a)).toBe(false);
      expect(isBashApprovalBypassedForStream(b)).toBe(true);
    } finally {
      cleanupApprovalsForStream(b);
    }
  });

  it('scopes streamless cleanup to the owning runtime host', () => {
    const hostA = host();
    const hostB = host();
    const session = new SessionHandle();
    const cancelUnscoped = vi.fn();
    const detach = session.useHostInteractions({
      handleProgressEvent: () => false,
      resolve: () => false,
      cancelForStream: () => {},
      cancelUnscoped,
    });
    const settled = new Set<string>();
    const createPending = (id: string, runtimeHost: AgentRuntimeHost) => {
      let isSettled = false;
      return {
        streamId: '' as StreamTabId,
        runtimeHost,
        isSettled: () => isSettled,
        settle: () => {
          isSettled = true;
          settled.add(id);
        },
      };
    };

    try {
      registerPendingApproval('tool-a', createPending('tool-a', hostA));
      registerPendingApproval('tool-b', createPending('tool-b', hostB));
      bashApprovalController.registerPending(
        'bash-a',
        createPending('bash-a', hostA),
      );
      bashApprovalController.registerPending(
        'bash-b',
        createPending('bash-b', hostB),
      );

      cleanupUnscopedApprovals(hostA, session);

      expect(settled).toEqual(new Set(['tool-a', 'bash-a']));
      expect(cancelUnscoped).toHaveBeenCalledWith(
        'Streamless approval cleanup.',
      );

      cleanupUnscopedApprovals();

      expect(settled).toEqual(
        new Set(['tool-a', 'bash-a', 'tool-b', 'bash-b']),
      );
    } finally {
      unregisterPendingApproval('tool-a');
      unregisterPendingApproval('tool-b');
      bashApprovalController.unregisterPending('bash-a');
      bashApprovalController.unregisterPending('bash-b');
      detach();
    }
  });
});
