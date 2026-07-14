// Test support imports
import { createTestSession } from '@test/support/sessionTestUtils';

// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - runtime
import { ApprovalRequestHandler } from '@controllers/progressView/backend/ApprovalRequestHandler';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import {
  matchesCancelSelector,
  type HostInteractionOptions,
  HostInteractions,
  type HostPlanApprovalRequest,
  type PlanApprovalResult,
} from '@agent/runtime/HostInteractions';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import { createDesktopHostInteractions } from '@desktop/main/desktopHostInteractions';
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
    getToolEditApprovals: () => ({
      approvePendingForStream: async () => {},
      cancel: () => {},
      dispose: () => {},
      handleAction: () => false,
      requestApproval: async () => {
        throw new Error('tool-edit approvals are not exercised here');
      },
    }),
  });
  session.useHostInteractions(interactions);
  return { session, uiEvents, emitted, interactions };
}

function createControllablePlanAdapter(
  options: { settleOnDispose?: boolean } = {},
) {
  const requests: HostPlanApprovalRequest[] = [];
  const pending = new Map<
    string,
    {
      readonly request: HostPlanApprovalRequest;
      readonly cancellationScope?: object;
      readonly settle: (result: PlanApprovalResult) => void;
    }
  >();
  const dispose = vi.fn(() => {
    if (options.settleOnDispose === false) return;
    for (const { settle } of pending.values()) settle({ action: 'reject' });
    pending.clear();
  });
  const interactions: HostInteractions = {
    requestPlanApproval(request, requestOptions?: HostInteractionOptions) {
      requests.push(request);
      return new Promise((settle) =>
        pending.set(request.approvalId, {
          request,
          cancellationScope: requestOptions?.cancellationScope,
          settle,
        }),
      );
    },
    resolve(requestId, result) {
      const entry = pending.get(requestId);
      if (!entry || result.kind !== 'plan') return false;
      pending.delete(requestId);
      entry.settle(
        result.action === 'approve'
          ? { action: 'approve' }
          : { action: 'reject', feedback: result.feedback },
      );
      return true;
    },
    cancel(selector = {}) {
      for (const [requestId, entry] of pending) {
        if (
          !matchesCancelSelector(
            {
              kind: 'plan',
              streamId: entry.request.streamId,
              cancellationScope: entry.cancellationScope,
            },
            selector,
          )
        )
          continue;
        pending.delete(requestId);
        entry.settle({ action: 'reject' });
      }
    },
    dispose,
  };
  return { interactions, requests, dispose };
}

describe('session.interactions request bookkeeping (coordinator fold)', () => {
  it('disposes an adapter offered after terminal slot disposal', () => {
    const session = createTestSession();
    const adapter = createControllablePlanAdapter();
    session.interactions.dispose();
    session.useHostInteractions(adapter.interactions);

    expect(adapter.dispose).toHaveBeenCalledOnce();
    session.dispose();
  });

  it('does not turn an unattached external inquiry into a parked approval', () => {
    const session = createTestSession();
    try {
      expect(
        session.interactions.openExternalInquiry({
          requestId: 'inquiry:unattached',
          threadId: 'inquiry:unattached',
          question: 'Can this notification be shown?',
          streamId,
          mode: 'new',
          allowBypass: false,
          sessionLinks: null,
          draft: null,
          transcript: null,
        }),
      ).toBeUndefined();
    } finally {
      session.dispose();
    }
  });

  it('limits forwarded cancellation to the source owner requests', async () => {
    const source = createTestSession();
    const target = createTestSession();
    const adapter = createControllablePlanAdapter();
    const cancel = vi.fn(adapter.interactions.cancel);
    target.useHostInteractions({ ...adapter.interactions, cancel });
    source.useHostInteractions(target.interactions.createForwarder());

    const sourceStream = 'stream:forwarded-owner' as StreamTabId;
    const targetStream = sourceStream;
    const sourcePending = source.interactions.requestPlanApproval({
      approvalId: 'approval:forwarded-owner',
      streamId: sourceStream,
      plan,
      goalEnabled: false,
    });
    const targetPending = target.interactions.requestPlanApproval({
      approvalId: 'approval:target-owner',
      streamId: targetStream,
      plan,
      goalEnabled: false,
    });

    source.dispose();

    await expect(sourcePending).resolves.toEqual({
      action: 'reject',
      feedback: 'Session disposed.',
    });
    expect(cancel).toHaveBeenCalledWith({
      kind: 'plan',
      streamId: sourceStream,
      cause: 'Session disposed.',
      cancellationScope: expect.any(Object),
    });
    expect(
      target.interactions.resolve('approval:target-owner', {
        kind: 'plan',
        action: 'approve',
      }),
    ).toBe(true);
    await expect(targetPending).resolves.toEqual({ action: 'approve' });
    target.dispose();
  });

  it('tracks forwarded ownership before presentation can cancel reentrantly', async () => {
    const source = createTestSession();
    const target = createTestSession();
    let settle: ((result: PlanApprovalResult) => void) | undefined;
    const cancel = vi.fn(() => {
      settle?.({ action: 'reject', feedback: 'Cancelled while presenting.' });
    });
    target.useHostInteractions({
      requestPlanApproval: () =>
        new Promise<PlanApprovalResult>((resolve) => {
          settle = resolve;
          source.dispose();
        }),
      resolve: () => false,
      cancel,
    });
    source.useHostInteractions(target.interactions.createForwarder());

    const pending = source.interactions.requestPlanApproval({
      approvalId: 'approval:reentrant-cancel',
      streamId: 'stream:reentrant-cancel' as StreamTabId,
      plan,
      goalEnabled: false,
    });

    await expect(pending).resolves.toEqual({
      action: 'reject',
      feedback: 'Session disposed.',
    });
    expect(cancel).toHaveBeenCalledWith({
      kind: 'plan',
      streamId: 'stream:reentrant-cancel',
      cause: 'Session disposed.',
      cancellationScope: expect.any(Object),
    });
    target.dispose();
  });

  it('disposes attachments even when cancellation throws', () => {
    const session = createTestSession();
    const dispose = vi.fn();
    session.useHostInteractions({
      resolve: () => false,
      cancel: () => {
        throw new Error('cancel failed');
      },
      dispose,
    });

    expect(() => session.interactions.dispose()).toThrow('cancel failed');
    expect(dispose).toHaveBeenCalledOnce();
    session.dispose();
  });

  it('buffers a request made while no adapter is attached', async () => {
    const session = createTestSession();
    const adapter = createControllablePlanAdapter();
    try {
      const pending = session.interactions.requestPlanApproval({
        approvalId: 'approval:unattached',
        streamId,
        plan,
        goalEnabled: false,
      });
      expect(adapter.requests).toEqual([]);

      session.useHostInteractions(adapter.interactions);
      expect(adapter.requests).toHaveLength(1);
      expect(
        session.interactions.resolve('approval:unattached', {
          kind: 'plan',
          action: 'approve',
        }),
      ).toBe(true);
      await expect(pending).resolves.toEqual({ action: 'approve' });
    } finally {
      session.dispose();
    }
  });

  it('keeps a pending request across adapter detach and reattach', async () => {
    const session = createTestSession();
    const first = createControllablePlanAdapter();
    const second = createControllablePlanAdapter();
    try {
      const detach = session.useHostInteractions(first.interactions);
      const pending = session.interactions.requestPlanApproval({
        approvalId: 'approval:reattach',
        streamId,
        plan,
        goalEnabled: false,
      });
      detach();
      await Promise.resolve();
      expect(first.dispose).toHaveBeenCalledOnce();

      session.useHostInteractions(second.interactions);
      expect(second.requests).toHaveLength(1);
      expect(
        session.interactions.resolve('approval:reattach', {
          kind: 'plan',
          action: 'approve',
        }),
      ).toBe(true);
      await expect(pending).resolves.toEqual({ action: 'approve' });
    } finally {
      session.dispose();
    }
  });

  it('ignores a result produced by a detached adapter', async () => {
    const session = createTestSession();
    const first = createControllablePlanAdapter({ settleOnDispose: false });
    const second = createControllablePlanAdapter();
    try {
      const detach = session.useHostInteractions(first.interactions);
      const pending = session.interactions.requestPlanApproval({
        approvalId: 'approval:stale',
        streamId,
        plan,
        goalEnabled: false,
      });
      detach();
      session.useHostInteractions(second.interactions);

      expect(
        first.interactions.resolve('approval:stale', {
          kind: 'plan',
          action: 'reject',
        }),
      ).toBe(true);
      await Promise.resolve();
      expect(
        session.interactions.resolve('approval:stale', {
          kind: 'plan',
          action: 'approve',
        }),
      ).toBe(true);
      await expect(pending).resolves.toEqual({ action: 'approve' });
    } finally {
      session.dispose();
    }
  });

  it('settles an explicit cancellation while unattached', async () => {
    const session = createTestSession();
    const pending = session.interactions.requestPlanApproval({
      approvalId: 'approval:cancel-unattached',
      streamId,
      plan,
      goalEnabled: false,
    });

    session.interactions.cancel({ streamId, cause: 'Run ended.' });

    await expect(pending).resolves.toEqual({
      action: 'reject',
      feedback: 'Run ended.',
    });
    session.dispose();
  });

  it('preserves user-question feedback while unattached', async () => {
    const session = createTestSession();
    const pending = session.interactions.askUserQuestion({
      requestId: 'question:cancel-unattached',
      questions: [
        {
          question: 'Which normalization should be used?',
          options: [{ label: 'Unit volume' }, { label: 'Unit mass' }],
        },
      ],
      allowBypass: false,
      streamId: '',
    });

    session.interactions.cancel({
      streamId: null,
      cause: 'No stream owns this question.',
    });

    await expect(pending).resolves.toEqual({
      submitted: false,
      feedback: 'No stream owns this question.',
    });
    session.dispose();
  });

  it('settles buffered requests on terminal session disposal', async () => {
    const session = createTestSession();
    const pending = session.interactions.requestAgentProposal({
      proposalId: 'proposal:dispose-unattached',
      streamId,
      ...proposal,
    });

    session.dispose();

    await expect(pending).resolves.toEqual({
      action: 'reject',
      feedback: 'Session disposed.',
    });
  });

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
