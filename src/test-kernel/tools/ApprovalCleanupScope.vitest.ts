// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { noopAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import {
  cleanupApprovalsForStream,
  setBashApprovalSessionBypass,
  isBashApprovalBypassedForStream,
} from '@tools/approval';
import type { StreamTabId } from '@shared/schemas';

const sid = (s: string): StreamTabId => s as StreamTabId;

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
});
