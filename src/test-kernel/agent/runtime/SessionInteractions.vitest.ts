// Test support imports
import { createTestSession } from '@test/support/sessionTestUtils';

// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - runtime
import { ApprovalRequestHandler } from '@controllers/progressView/backend/ApprovalRequestHandler';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { HostInteractions } from '@agent/runtime/HostInteractions';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import { createDesktopHostInteractions } from '@desktop/main/desktopHostInteractions';
import type { DesktopToolEditApprovalController } from '@desktop/main/desktopToolEditApproval';
import {
  AgentCategory,
  type AgentProposal,
  type AgentProposalPermission,
  type BashPermission,
  type ExternalInquiryPermission,
  type Plan,
  type PlanApprovalPermission,
  type RetryPermission,
  type StreamTabId,
  type ToolEditPermission,
  type UserQuestionPermission,
} from '@shared/schemas';
import type { ApprovalRequestHandlerSet } from '@controllers/progressView/backend/progressBackendUiConfig';

/**
 * Parity pins for the coordinator fold (#7487): plan approval, proposal, and
 * retry requests now travel `session.interactions` directly. The behaviors the
 * deleted coordinator layer guaranteed — first-wins resolution, replacement
 * cancellation for duplicate request ids, and per-stream cleanup — are pinned
 * here against a real production port implementation (the desktop one; it has
 * no VS Code import graph) installed into a real `SessionHandle` slot.
 */

const streamId = 'stream:interactions-test' as StreamTabId;
const plan: Plan = { objective: 'Fold the coordinator layer into the port.' };
const proposal: AgentProposal = {
  agentCategory: AgentCategory.ToolUse,
  agent: 'reviewer',
  model: 'test-model',
  instruction: 'Review the runtime boundary.',
  memories: [],
};

interface UiEvent {
  event: string;
  id: string;
}

function createHandlerSet(events: UiEvent[]): ApprovalRequestHandlerSet {
  const handler = <T extends { streamId: string }, K extends keyof T>(
    kind: string,
    idField: K,
  ): ApprovalRequestHandler<T, K> =>
    new ApprovalRequestHandler<T, K>(
      idField,
      (item) =>
        events.push({ event: `show:${kind}`, id: String(item[idField]) }),
      (id) => events.push({ event: `resolve:${kind}`, id }),
      () => true,
    );
  return {
    toolEdit: handler<ToolEditPermission, 'requestId'>('toolEdit', 'requestId'),
    bash: handler<BashPermission, 'requestId'>('bash', 'requestId'),
    retry: handler<RetryPermission, 'streamId'>('retry', 'streamId'),
    agentProposal: handler<AgentProposalPermission, 'proposalId'>(
      'proposal',
      'proposalId',
    ),
    planApproval: handler<PlanApprovalPermission, 'approvalId'>(
      'plan',
      'approvalId',
    ),
    externalInquiry: handler<ExternalInquiryPermission, 'requestId'>(
      'externalInquiry',
      'requestId',
    ),
    userQuestion: handler<UserQuestionPermission, 'requestId'>(
      'userQuestion',
      'requestId',
    ),
  };
}

function createPortSession(): {
  session: SessionHandle;
  uiEvents: UiEvent[];
  emitted: string[];
  interactions: HostInteractions;
} {
  const uiEvents: UiEvent[] = [];
  const emitted: string[] = [];
  const runtimeHost: AgentRuntimeHost = {
    emit: (event) => emitted.push(event),
  };
  const handlers = createHandlerSet(uiEvents);
  const session = createTestSession();
  const interactions = createDesktopHostInteractions({
    runtimeHost,
    session,
    getApprovalHandlers: () => handlers,
    getToolEditApprovals: () => {
      throw new Error('tool-edit approvals are not exercised here');
    },
  });
  session.useHostInteractions(interactions);
  return { session, uiEvents, emitted, interactions };
}

describe('session.interactions request bookkeeping (coordinator fold)', () => {
  it('resolves a plan approval first-wins through the session slot', async () => {
    const { session, uiEvents, emitted } = createPortSession();
    try {
      const pending = session.interactions.requestPlanApproval({
        approvalId: 'approval:first-wins',
        streamId,
        plan,
        goalEnabled: false,
      });
      expect(pending).toBeDefined();
      // The port owns display and the activation emissions the coordinator
      // layer used to duplicate.
      expect(emitted).toContain('requestEnsureProgressView');
      expect(uiEvents).toContainEqual({
        event: 'show:plan',
        id: 'approval:first-wins',
      });

      expect(
        session.interactions.resolve('approval:first-wins', {
          kind: 'plan',
          action: 'approve',
        }),
      ).toBe(true);
      await expect(pending).resolves.toEqual({ action: 'approve' });

      // First-wins: a second resolution finds nothing pending.
      expect(
        session.interactions.resolve('approval:first-wins', {
          kind: 'plan',
          action: 'reject',
        }),
      ).toBe(false);
    } finally {
      session.dispose();
    }
  });

  it('rejects the stale request when the same id is re-requested (replacement)', async () => {
    const { session, uiEvents } = createPortSession();
    try {
      const first = session.interactions.requestPlanApproval({
        approvalId: 'approval:replace',
        streamId,
        plan,
        goalEnabled: false,
      });
      const second = session.interactions.requestPlanApproval({
        approvalId: 'approval:replace',
        streamId,
        plan,
        goalEnabled: false,
      });

      await expect(first).resolves.toMatchObject({ action: 'reject' });
      expect(
        uiEvents.filter((entry) => entry.event === 'show:plan'),
      ).toHaveLength(2);

      expect(
        session.interactions.resolve('approval:replace', {
          kind: 'plan',
          action: 'approve',
        }),
      ).toBe(true);
      await expect(second).resolves.toEqual({ action: 'approve' });
    } finally {
      session.dispose();
    }
  });

  it('a stream-scoped cancel settles every pending request for that stream only', async () => {
    const { session } = createPortSession();
    const otherStreamId = 'stream:interactions-other' as StreamTabId;
    try {
      const pendingPlan = session.interactions.requestPlanApproval({
        approvalId: 'approval:cleanup',
        streamId,
        plan,
        goalEnabled: false,
      });
      const pendingProposal = session.interactions.requestAgentProposal({
        proposalId: 'proposal:cleanup',
        streamId,
        ...proposal,
      });
      const surviving = session.interactions.requestPlanApproval({
        approvalId: 'approval:survives',
        streamId: otherStreamId,
        plan,
        goalEnabled: false,
      });

      session.interactions.cancel({ streamId, cause: 'Run ended.' });

      await expect(pendingPlan).resolves.toMatchObject({ action: 'reject' });
      await expect(pendingProposal).resolves.toMatchObject({
        action: 'reject',
      });
      expect(
        session.interactions.resolve('approval:cleanup', {
          kind: 'plan',
          action: 'approve',
        }),
      ).toBe(false);
      expect(
        session.interactions.resolve('proposal:cleanup', {
          kind: 'proposal',
          action: 'approve',
        }),
      ).toBe(false);

      // The other stream's request is untouched and still resolvable.
      expect(
        session.interactions.resolve('approval:survives', {
          kind: 'plan',
          action: 'approve',
        }),
      ).toBe(true);
      await expect(surviving).resolves.toEqual({ action: 'approve' });
    } finally {
      session.dispose();
    }
  });

  it('a kind-scoped cancel settles only that kind on the stream', async () => {
    const { session } = createPortSession();
    try {
      const pendingPlan = session.interactions.requestPlanApproval({
        approvalId: 'approval:kind-scope',
        streamId,
        plan,
        goalEnabled: false,
      });
      const pendingProposal = session.interactions.requestAgentProposal({
        proposalId: 'proposal:kind-scope',
        streamId,
        ...proposal,
      });

      session.interactions.cancel({
        streamId,
        kind: 'plan',
        cause: 'Plan approval cleared.',
      });

      await expect(pendingPlan).resolves.toMatchObject({ action: 'reject' });

      // The proposal on the same stream is untouched and still resolvable.
      expect(
        session.interactions.resolve('proposal:kind-scope', {
          kind: 'proposal',
          action: 'approve',
        }),
      ).toBe(true);
      await expect(pendingProposal).resolves.toMatchObject({
        action: 'approve',
      });
    } finally {
      session.dispose();
    }
  });

  it('session dispose settles whatever is still pending in the port', async () => {
    const { session } = createPortSession();
    const pending = session.interactions.requestAgentProposal({
      proposalId: 'proposal:dispose',
      streamId,
      ...proposal,
    });

    session.dispose();

    await expect(pending).resolves.toMatchObject({ action: 'reject' });
  });
});
