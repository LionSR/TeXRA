// Test composition imports
import '@test/support/defaultSessionTestSetup';
import { describe, expect, it, vi } from 'vitest';
import { currentSession } from '@agent/runtime/SessionHandle';

// Third-party imports

// Local imports
import type { RunId } from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';
import { proposalApprovals, releaseRunResources } from '@tools/approval';
import type { ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';
import {
  bashApprovalRequest,
  toolEditApprovalRequest,
} from '../agent/progressTestUtils';

const sid = (s: string): RunId => s as RunId;

/** A never-answered approval prompt, holding a session's prompt slot open. */
const pendingApproval = (): Promise<never> => new Promise(() => {});

function toolEditRequest(
  path: string,
  runId?: RunId,
): ToolEditApprovalRequest {
  return toolEditApprovalRequest({
    path,
    originalContent: 'old',
    proposedContent: 'new',
    sourceTool: 'edit_file',
    ...(runId ? { runId } : {}),
  });
}

describe('approval cleanup scope', () => {
  it("per-stream cleanup leaves another stream's approval state intact", () => {
    const a = sid('s:appr-scope-a');
    const b = sid('s:appr-scope-b');
    currentSession().approvals.bash.bypass.setBypass(a, true, {
      silent: true,
    });
    currentSession().approvals.bash.bypass.setBypass(b, true, {
      silent: true,
    });

    try {
      // A desktop window deleting its own stream `a` scopes the sweep to `a`
      // (this is what `deleteAllRuns` loops), so a sibling stream `b`
      // keeps its bypass state.
      releaseRunResources(a);
      expect(currentSession().approvals.bash.bypass.isBypassed(a)).toBe(false);
      expect(currentSession().approvals.bash.bypass.isBypassed(b)).toBe(true);
    } finally {
      releaseRunResources(b);
    }
  });

  it('settles a stream tool-edit approval with the cancellation cause', async () => {
    const session = createTestSession();
    const runId = sid('s:cause-swallow');
    const cancel = vi.fn();
    session.interactions.use({
      requestToolEditApproval: pendingApproval,
      cancel,
    });
    const pending = session.interactions.requestToolEditApproval(
      toolEditRequest('paper.tex', runId),
    );

    try {
      releaseRunResources(runId, session);
      await expect(pending).resolves.toEqual({
        action: 'reject',
        cause: 'Stream resources released.',
      });
      expect(cancel).toHaveBeenCalledWith({
        runId,
        cause: 'Stream resources released.',
      });
    } finally {
      session.dispose();
    }
  });

  it('scopes runless cleanup to the owning session', async () => {
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
    const runlessCleanupSettlements = [
      {
        action: 'reject',
        cause: 'Runless approval cleanup.',
      },
      {
        action: 'reject',
        cause: 'Runless approval cleanup.',
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

      sessionA.interactions.cancel({
        runId: null,
        cause: 'Runless approval cleanup.',
      });

      await expect(Promise.all([toolA, bashA])).resolves.toEqual(
        runlessCleanupSettlements,
      );
      expect(sessionBSettled).toBe(false);
      expect(cancelA).toHaveBeenCalledWith({
        runId: null,
        cause: 'Runless approval cleanup.',
      });

      sessionB.interactions.cancel({
        runId: null,
        cause: 'Runless approval cleanup.',
      });

      await expect(Promise.all([toolB, bashB])).resolves.toEqual(
        runlessCleanupSettlements,
      );
      expect(cancelB).toHaveBeenCalledWith({
        runId: null,
        cause: 'Runless approval cleanup.',
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
    const runId = sid('s:delegated-approval-same-id');

    try {
      sessionA.approvals.setDelegatedWorkBypasses(runId, true);

      expect(proposalApprovals(sessionA).isBypassed(runId)).toBe(true);
      expect(sessionA.approvals.toolEdit.bypass.isBypassed(runId)).toBe(
        true,
      );
      expect(sessionA.approvals.bash.bypass.isBypassed(runId)).toBe(true);
      expect(proposalApprovals(sessionB).isBypassed(runId)).toBe(false);
      expect(sessionB.approvals.toolEdit.bypass.isBypassed(runId)).toBe(
        false,
      );
      expect(sessionB.approvals.bash.bypass.isBypassed(runId)).toBe(false);

      releaseRunResources(runId, sessionA);
      expect(proposalApprovals(sessionA).isBypassed(runId)).toBe(false);
      expect(proposalApprovals(sessionB).isBypassed(runId)).toBe(false);
    } finally {
      sessionA.dispose();
      sessionB.dispose();
    }
  });

  it('keeps bypass state for equal stream ids isolated between sessions', () => {
    const sessionA = createTestSession();
    const sessionB = createTestSession();
    const runId = sid('s:appr-same-id');

    try {
      sessionA.approvals.bash.bypass.setBypass(runId, true, {
        silent: true,
      });

      expect(sessionA.approvals.bash.bypass.isBypassed(runId)).toBe(true);
      expect(sessionB.approvals.bash.bypass.isBypassed(runId)).toBe(false);
      // The no-session call reads the process default session, untouched here.
      expect(currentSession().approvals.bash.bypass.isBypassed(runId)).toBe(
        false,
      );
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
    const runId = sid('s:appr-dispose');
    session.interactions.use({
      requestToolEditApproval: pendingApproval,
      cancel: vi.fn(),
    });
    const pending = session.interactions.requestToolEditApproval(
      toolEditRequest('dispose.tex', runId),
    );
    session.approvals.bash.bypass.setBypass(runId, true, {
      silent: true,
    });

    session.dispose();

    await expect(pending).resolves.toEqual({
      action: 'reject',
      cause: 'Session disposed.',
    });
    expect(session.approvals.bash.bypass.isBypassed(runId)).toBe(false);
  });
});
