import { nanoid } from 'nanoid';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import {
  matchesCancelSelector,
  type HostBashApprovalRequest,
  type HostBashApprovalResult,
  type HostInteractionCancelSelector,
  type HostInteractionOptions,
  type HostInteractionResolution,
  type HostInteractions,
  type HostPlanApprovalRequest,
  type HostRetryRequest,
  type HostUserQuestionResult,
  type PlanApprovalResult,
  type ProposalResult,
  type RetryResult,
} from '@agent/runtime/HostInteractions';
import {
  toBashApprovalResult,
  toPlanApprovalResult,
  toProposalResult,
  toUserQuestionResult,
} from '@agent/runtime/hostInteractionResultMappers';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentProposalPermission, StreamTabId } from '@shared/schemas';
import type { ApprovalRequestHandlerSet } from '@controllers/progressView/backend/progressBackendUiConfig';
import type {
  ToolEditApprovalRequest,
  ToolEditApprovalResult,
} from '@platform/interfaces';

import type { DesktopToolEditApprovalController } from './desktopToolEditApproval.js';

type PendingDesktopInteraction =
  | {
      kind: 'bash';
      streamId?: StreamTabId;
      cancellationScope?: object;
      settle: (result: HostBashApprovalResult) => void;
    }
  | {
      kind: 'plan';
      streamId: StreamTabId;
      cancellationScope?: object;
      settle: (result: PlanApprovalResult) => void;
    }
  | {
      kind: 'proposal';
      streamId: StreamTabId;
      cancellationScope?: object;
      settle: (result: ProposalResult) => void;
    }
  | {
      kind: 'userQuestion';
      streamId?: StreamTabId;
      cancellationScope?: object;
      settle: (result: HostUserQuestionResult) => void;
    };

export interface DesktopHostInteractionsOptions {
  runtimeHost: AgentRuntimeHost;
  session: SessionHandle;
  getApprovalHandlers(): ApprovalRequestHandlerSet;
  getToolEditApprovals(): DesktopToolEditApprovalController;
}

export interface DesktopHostInteractions extends HostInteractions {
  approvePendingDelegatedWork(
    streamId: StreamTabId,
    initiatingProposalId: string,
  ): Promise<void>;
}

export function createDesktopHostInteractions(
  options: DesktopHostInteractionsOptions,
): DesktopHostInteractions {
  return new DesktopHostInteractionsImpl(options);
}

class DesktopHostInteractionsImpl implements DesktopHostInteractions {
  private readonly pendingRequests = new Map<
    string,
    PendingDesktopInteraction
  >();

  constructor(private readonly options: DesktopHostInteractionsOptions) {}

  requestToolEditApproval(
    request: ToolEditApprovalRequest,
    options?: HostInteractionOptions,
  ): Promise<ToolEditApprovalResult> {
    const approvals = this.options.getToolEditApprovals();
    return options
      ? approvals.requestApproval(request, options)
      : approvals.requestApproval(request);
  }

  requestBashApproval(
    request: HostBashApprovalRequest,
    options?: HostInteractionOptions,
  ): Promise<HostBashApprovalResult> {
    const requestId = `desktop-bash-${nanoid()}`;
    const streamId = request.streamId ?? undefined;
    const payload = {
      requestId,
      command: request.command,
      ...(request.cwd ? { cwd: request.cwd } : {}),
      allowBypass: true,
      streamId: streamId ?? '',
    };
    return this.showPending(
      requestId,
      { kind: 'bash', streamId, cancellationScope: options?.cancellationScope },
      () => {
        this.revealStream(streamId);
        this.options.getApprovalHandlers().bash.show(payload);
      },
    );
  }

  requestPlanApproval(
    request: HostPlanApprovalRequest,
    options?: HostInteractionOptions,
  ): Promise<PlanApprovalResult> {
    return this.showPending(
      request.approvalId,
      {
        kind: 'plan',
        streamId: request.streamId,
        cancellationScope: options?.cancellationScope,
      },
      () => {
        this.revealStream(request.streamId);
        this.options.getApprovalHandlers().planApproval.show(request);
      },
    );
  }

  requestAgentProposal(
    request: AgentProposalPermission,
    options?: HostInteractionOptions,
  ): Promise<ProposalResult> {
    return this.showPending(
      request.proposalId,
      {
        kind: 'proposal',
        streamId: request.streamId,
        cancellationScope: options?.cancellationScope,
      },
      () => {
        this.revealStream(request.streamId);
        this.options.getApprovalHandlers().agentProposal.show(request);
      },
    );
  }

  requestRetry(_request: HostRetryRequest): Promise<RetryResult> {
    return Promise.resolve({ action: 'cancel' });
  }

  askUserQuestion(
    request: Parameters<NonNullable<HostInteractions['askUserQuestion']>>[0],
    options?: HostInteractionOptions,
  ): Promise<HostUserQuestionResult> {
    const streamId = request.streamId || undefined;
    return this.showPending(
      request.requestId,
      {
        kind: 'userQuestion',
        streamId,
        cancellationScope: options?.cancellationScope,
      },
      () => {
        this.revealStream(streamId);
        this.options.getApprovalHandlers().userQuestion.show(request);
      },
    );
  }

  openExternalInquiry(
    request: Parameters<
      NonNullable<HostInteractions['openExternalInquiry']>
    >[0],
  ): Promise<{ threadId: string }> {
    this.options.getApprovalHandlers().externalInquiry.show(request);
    return Promise.resolve({ threadId: request.threadId });
  }

  /**
   * `result.kind` must match the pending request's own recorded kind before
   * it's honored — the same discriminant check the extension host performs
   * — so a caller bug (or a stale/misrouted resolution) can't be silently
   * reinterpreted as whatever kind happens to be pending under that
   * requestId.
   */
  resolve(requestId: string, result: HostInteractionResolution): boolean {
    if (result.kind === 'externalInquiry') {
      this.options.getApprovalHandlers().externalInquiry.resolve(requestId);
      return true;
    }

    const request = this.pendingRequests.get(requestId);
    if (!request || request.kind !== result.kind) return false;
    this.pendingRequests.delete(requestId);

    switch (request.kind) {
      case 'bash':
        request.settle(toBashApprovalResult(result));
        this.options.getApprovalHandlers().bash.resolve(requestId);
        return true;
      case 'plan':
        request.settle(toPlanApprovalResult(result));
        this.options.getApprovalHandlers().planApproval.resolve(requestId);
        return true;
      case 'proposal':
        request.settle(toProposalResult(result));
        this.options.getApprovalHandlers().agentProposal.resolve(requestId);
        return true;
      case 'userQuestion':
        request.settle(toUserQuestionResult(result));
        this.options.getApprovalHandlers().userQuestion.resolve(requestId);
        return true;
    }
  }

  async approvePendingDelegatedWork(
    streamId: StreamTabId,
    initiatingProposalId: string,
  ): Promise<void> {
    for (const [requestId, request] of [...this.pendingRequests]) {
      if (
        request.streamId !== streamId ||
        (request.kind === 'proposal' && requestId === initiatingProposalId)
      ) {
        continue;
      }
      if (request.kind === 'bash' || request.kind === 'proposal') {
        this.resolve(requestId, {
          kind: request.kind,
          action: 'approve',
        });
      }
    }
    this.options.getToolEditApprovals().approvePendingForStream(streamId);
  }

  /**
   * Cancellation is a synthesized rejection routed through the same
   * `resolve()`/mapper path a live UI action takes, forwarding the selector's
   * `cause` as agent-visible feedback — so a cancelled request and a rejected
   * one settle identically for a given kind.
   */
  cancel(selector: HostInteractionCancelSelector = {}): void {
    if (selector.kind == null || selector.kind === 'toolEdit') {
      this.options.getToolEditApprovals().cancel(selector);
    }
    for (const [requestId, request] of [...this.pendingRequests.entries()]) {
      if (!matchesCancelSelector(request, selector)) continue;
      this.resolve(requestId, {
        kind: request.kind,
        action: 'reject',
        feedback: selector.cause,
      });
    }
  }

  dispose(): void {
    this.cancel({ cause: 'Desktop session disposed.' });
  }

  private showPending<TResult, TEntry extends PendingDesktopInteraction>(
    requestId: string,
    entry: Omit<TEntry, 'settle'>,
    show: () => void,
  ): Promise<TResult> {
    // Replacement cancellation: a request re-issued under a still-pending id
    // rejects the stale prompt before the replacement is shown.
    if (this.pendingRequests.has(requestId)) {
      this.resolve(requestId, {
        kind: this.pendingRequests.get(requestId)!.kind,
        action: 'reject',
        feedback: 'Approval request was replaced.',
      });
    }
    return new Promise<TResult>((resolve) => {
      const settle = (result: unknown) => resolve(result as TResult);
      this.pendingRequests.set(requestId, {
        ...entry,
        settle,
      } as TEntry);
      try {
        show();
      } catch (error) {
        this.pendingRequests.delete(requestId);
        throw error;
      }
    });
  }

  // Interaction requests surface per-stream (pending badge on the stream
  // row); `suppressViewSwitch` registers the stream without yanking the
  // active tab away from whatever the user is inspecting — matches the
  // extension host contract (#8246).
  private revealStream(streamId: StreamTabId | undefined): void {
    this.options.runtimeHost.emit('requestEnsureProgressView', {});
    if (streamId) {
      this.options.session.events.emit({
        scope: 'session',
        event: {
          type: 'setActiveStream',
          payload: {
            streamId,
            suppressViewSwitch: true,
            ensureVisible: true,
          },
        },
      });
    }
  }
}
