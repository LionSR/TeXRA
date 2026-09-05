// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import type { StreamTabId } from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';
import {
  cleanupUnscopedApprovals,
  isBashApprovalBypassedForStream,
  proposalApprovals,
  releaseStreamResources,
  setBashApprovalSessionBypass,
} from '@tools/approval';
import type { ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';
import {
  bashApprovalRequest,
  toolEditApprovalRequest,
} from '../agent/progressTestUtils';

const sid = (s: string): StreamTabId => s as StreamTabId;

/** A never-answered approval prompt, holding a session's prompt slot open. */
const pendingApproval = (): Promise<never> => new Promise(() => {});

function toolEditRequest(
  path: string,
  streamId?: StreamTabId,
): ToolEditApprovalRequest {
  return toolEditApprovalRequest({
    path,
    originalContent: 'old',
    proposedContent: 'new',
    sourceTool: 'edit_file',
    ...(streamId ? { streamId } : {}),
  });
}

describe('approval cleanup scope', () => {
  it("per-stream cleanup leaves another stream's approval state intact", () => {
    const a = sid('s:appr-scope-a');
    const b = sid('s:appr-scope-b');
    setBashApprovalSessionBypass(a, true, {
      silent: true,
    });
    setBashApprovalSessionBypass(b, true, {
      silent: true,
    });

    try {
      // A desktop window deleting its own stream `a` scopes the sweep to `a`
      // (this is what `deleteAllStreams` loops), so a sibling stream `b`
      // keeps its bypass state.
      releaseStreamResources(a);
      expect(isBashApprovalBypassedForStream(a)).toBe(false);
      expect(isBashApprovalBypassedForStream(b)).toBe(true);
    } finally {
      releaseStreamResources(b);
    }
  });

  it('settles a stream tool-edit approval with the cancellation cause', async () => {
    const session = createTestSession();
    const streamId = sid('s:cause-swallow');
    const cancel = vi.fn();
    session.interactions.use({
      requestToolEditApproval: pendingApproval,
      cancel,
    });
    const pending = session.interactions.requestToolEditApproval(
      toolEditRequest('paper.tex', streamId),
    );

    try {
      releaseStreamResources(streamId, session);
      await expect(pending).resolves.toEqual({
        action: 'reject',
        cause: 'Stream resources released.',
      });
      expect(cancel).toHaveBeenCalledWith({
        streamId,
        cause: 'Stream resources released.',
      });
    } finally {
      session.dispose();
    }
  });

  it('scopes streamless cleanup to the owning session', async () => {
    const sessionA = createTestSession();
    const sessionB = createTestSession();
    const cancelA = vi.fn();
    const cancelB = vi.fn();
    sessionA.interactions.use({
      requestToolEditApproval: pendingApproval,
      requestBashApproval: pendingApproval,
      cancel: cancelA,
    });
    sessionB.interactions.use({
      requestToolEditApproval: pendingApproval,
      requestBashApproval: pendingApproval,
      cancel: cancelB,
    });
    const streamlessCleanupSettlements = [
      {
        action: 'reject',
        cause: 'Streamless approval cleanup.',
      },
      {
        action: 'reject',
        cause: 'Streamless approval cleanup.',
      },
    ];

    try {
      const toolA = sessionA.interactions.requestToolEditApproval(
        toolEditRequest('a.tex'),
      );
      const bashA = sessionA.interactions.requestBashApproval(
        bashApprovalRequest({
          command: 'echo a',
        }),
      );
      const toolB = sessionB.interactions.requestToolEditApproval(
        toolEditRequest('b.tex'),
      );
      const bashB = sessionB.interactions.requestBashApproval(
        bashApprovalRequest({
          command: 'echo b',
        }),
      );
      let sessionBSettled = false;
      void Promise.all([toolB, bashB]).then(() => {
        sessionBSettled = true;
      });

      cleanupUnscopedApprovals(sessionA);

      await expect(Promise.all([toolA, bashA])).resolves.toEqual(
        streamlessCleanupSettlements,
      );
      expect(sessionBSettled).toBe(false);
      expect(cancelA).toHaveBeenCalledWith({
        streamId: null,
        cause: 'Streamless approval cleanup.',
      });

      cleanupUnscopedApprovals(sessionB);

      await expect(Promise.all([toolB, bashB])).resolves.toEqual(
        streamlessCleanupSettlements,
      );
      expect(cancelB).toHaveBeenCalledWith({
        streamId: null,
        cause: 'Streamless approval cleanup.',
      });
    } finally {
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
      sessionA.approvals.setDelegatedWorkBypasses(streamId, true);

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

      releaseStreamResources(streamId, sessionA);
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
      setBashApprovalSessionBypass(streamId, true, {
        silent: true,
        session: sessionA,
      });

      expect(isBashApprovalBypassedForStream(streamId, sessionA)).toBe(true);
      expect(isBashApprovalBypassedForStream(streamId, sessionB)).toBe(false);
      // The no-session call reads the process default session, untouched here.
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
      void sessionA.approvals.bash.enqueue(undefined, {
        prompt: pendingApproval,
        bypassed: () => 'never bypassed',
      });

      const ranInB = sessionB.approvals.bash.enqueue(undefined, {
        prompt: () => Promise.resolve('answered'),
        bypassed: () => 'never bypassed',
      });

      await expect(ranInB).resolves.toBe('answered');
    } finally {
      sessionA.dispose();
      sessionB.dispose();
    }
  });

  it('session disposal rejects its remaining pending approvals and clears bypass state', async () => {
    const session = createTestSession();
    const streamId = sid('s:appr-dispose');
    session.interactions.use({
      requestToolEditApproval: pendingApproval,
      cancel: vi.fn(),
    });
    const pending = session.interactions.requestToolEditApproval(
      toolEditRequest('dispose.tex', streamId),
    );
    setBashApprovalSessionBypass(streamId, true, {
      silent: true,
      session,
    });

    session.dispose();

    await expect(pending).resolves.toEqual({
      action: 'reject',
      cause: 'Session disposed.',
    });
    expect(isBashApprovalBypassedForStream(streamId, session)).toBe(false);
  });
});
