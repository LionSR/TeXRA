import type { SessionHostInteractions } from '@agent/runtime/HostInteractions';
import type {
  PresentationDelivery,
  RuntimePresentationEvent,
  RuntimePresentationEventPayloads,
} from '@agent/runtime/runtimePresentationEvents';
import {
  cancellationResultFor,
  type BashSettlement,
  type HostApprovalBypassStateUpdate,
  type HostBashApprovalRequest,
  type HostInteractionCancelSelector,
  type HostInteractionOptions,
  type HostInteractions,
  type HostPlanApprovalRequest,
  type HostRetryRequest,
  type PlanApprovalResult,
  type ProposalResult,
  type RetryResult,
  type RetrySettlement,
  type SettledInteractionKind,
  type UserQuestionSettlement,
} from '@agent/runtime/HostInteractions';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { ToolEditApprovalController } from '@controllers/approval/ToolEditApprovalController';
import type { AgentProposalPermission, StreamTabId } from '@shared/schemas';
import { SESSION_DISPOSED_CAUSE } from '@shared/copy/interactionCancellation';
import { prepareBashApprovalPrompt } from '@tools/approval/bashApproval';
import type {
  ToolEditApprovalRequest,
  ToolEditApprovalResult,
} from '@tools/approval/toolEditApproval';

import {
  cancelApprovalRequestHandlers,
  type ApprovalRequestHandlerSet,
} from './progressBackendUiConfig';

export interface ProgressHostInteractionsOptions {
  interactions: Pick<SessionHostInteractions, 'emit'>;
  session: SessionHandle;
  getApprovalHandlers(): ApprovalRequestHandlerSet;
  getToolEditApprovals(): ToolEditApprovalController;
  setApprovalBypassState(update: HostApprovalBypassStateUpdate): void;
}

/**
 * The progress-view host port: every host that renders approvals in the
 * progress view attaches this to its session, adding only its own extras.
 */
export interface ProgressHostInteractions extends HostInteractions {
  /** Approve work requests that were already pending when stream bypass began. */
  approvePendingDelegatedWork(
    streamId: StreamTabId,
    initiatingProposalId: string,
  ): Promise<void>;
  isRetryPending(streamId: StreamTabId, requestId: string): boolean;
  submitBashDecision(requestId: string, decision: BashSettlement): boolean;
  submitPlanDecision(requestId: string, decision: PlanApprovalResult): boolean;
  submitProposalDecision(requestId: string, decision: ProposalResult): boolean;
  submitRetryDecision(
    streamId: StreamTabId,
    requestId: string,
    decision: RetrySettlement,
  ): boolean;
  submitUserQuestionDecision(
    requestId: string,
    decision: UserQuestionSettlement,
  ): boolean;
  dismissExternalInquiry(requestId: string): void;
}

const PROGRESS_INTERACTION_KINDS = [
  'bash',
  'planApproval',
  'proposal',
  'retry',
  'userQuestion',
] as const satisfies readonly SettledInteractionKind[];

export function createProgressHostInteractions(
  options: ProgressHostInteractionsOptions,
): ProgressHostInteractions {
  const handlers = () => options.getApprovalHandlers();

  // Interaction requests surface per-stream: the request panel is scoped to
  // the viewed stream and the requesting stream's row shows a pending badge.
  // `suppressViewSwitch` registers the stream so that row exists without
  // yanking the active tab away from whatever the user is inspecting (#8246).
  const revealStream = (streamId?: StreamTabId | null) => {
    options.interactions.emit('requestEnsureProgressView', {});
    if (streamId) {
      options.session.events.emit({
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
  };

  const cancel = (selector: HostInteractionCancelSelector = {}): void => {
    if (selector.kind == null || selector.kind === 'toolEdit') {
      options.getToolEditApprovals().cancel(selector);
    }
    cancelApprovalRequestHandlers(
      handlers(),
      PROGRESS_INTERACTION_KINDS,
      selector,
    );
  };

  const isRetryPending = (
    streamId: StreamTabId,
    requestId: string,
  ): boolean => {
    return handlers().retry.get(streamId)?.requestId === requestId;
  };

  return {
    // Thin pass-through to the caller-supplied presentation dispatcher.
    emit<K extends RuntimePresentationEvent>(
      event: K,
      payload: RuntimePresentationEventPayloads[K],
    ): PresentationDelivery {
      return options.interactions.emit(event, payload);
    },

    setApprovalBypassState: options.setApprovalBypassState,

    async approvePendingDelegatedWork(
      streamId: StreamTabId,
      initiatingProposalId: string,
    ): Promise<void> {
      handlers().bash.completeWhere((item) => item.streamId === streamId, {
        action: 'approve',
      });
      handlers().proposal.completeWhere(
        (item) =>
          item.streamId === streamId &&
          item.proposalId !== initiatingProposalId,
        { action: 'approve' },
      );
      await options.getToolEditApprovals().approvePendingForStream(streamId);
    },

    isRetryPending,

    /**
     * Settle a pending retry request. Returns false when the request is no
     * longer the pending one for that stream, so a stale renderer click cannot
     * resolve a newer request.
     */
    submitRetryDecision(
      streamId: StreamTabId,
      requestId: string,
      decision: RetrySettlement,
    ): boolean {
      if (!isRetryPending(streamId, requestId)) return false;
      return handlers().retry.complete(streamId, decision);
    },

    submitBashDecision: (requestId, decision) =>
      handlers().bash.complete(requestId, decision),

    submitPlanDecision: (requestId, decision) =>
      handlers().planApproval.complete(requestId, decision),

    submitProposalDecision: (requestId, decision) =>
      handlers().proposal.complete(requestId, decision),

    submitUserQuestionDecision: (requestId, decision) =>
      handlers().userQuestion.complete(requestId, decision),

    dismissExternalInquiry: (requestId) =>
      handlers().externalInquiry.dismiss(requestId),

    requestToolEditApproval(
      request: ToolEditApprovalRequest,
      interactionOptions?: HostInteractionOptions,
    ): Promise<ToolEditApprovalResult> {
      return options
        .getToolEditApprovals()
        .requestApproval(request, interactionOptions);
    },

    requestBashApproval(
      request: HostBashApprovalRequest,
      interactionOptions?: HostInteractionOptions,
    ): Promise<BashSettlement> {
      revealStream(request.streamId);
      return handlers().bash.request(
        prepareBashApprovalPrompt(request, options.session),
        {
          cancellationScope: interactionOptions?.cancellationScope,
          cancellationResult: (cause) => cancellationResultFor('bash', cause),
        },
      );
    },

    requestPlanApproval(
      request: HostPlanApprovalRequest,
      interactionOptions?: HostInteractionOptions,
    ): Promise<PlanApprovalResult> {
      revealStream(request.streamId);
      return handlers().planApproval.request(request, {
        cancellationScope: interactionOptions?.cancellationScope,
        cancellationResult: (cause) =>
          cancellationResultFor('planApproval', cause),
      });
    },

    requestAgentProposal(
      request: AgentProposalPermission,
      interactionOptions?: HostInteractionOptions,
    ): Promise<ProposalResult> {
      revealStream(request.streamId);
      return handlers().proposal.request(request, {
        cancellationScope: interactionOptions?.cancellationScope,
        cancellationResult: (cause) => cancellationResultFor('proposal', cause),
      });
    },

    /**
     * Surface a retryable model failure to the user instead of auto-cancelling
     * it: reveal the stream and park the request on the shared `retry` handler,
     * whose card the progress view already renders (`RetryRequestPanel`). The
     * renderer settles it through `submitRetryDecision` or a cancel decision.
     */
    requestRetry(
      request: HostRetryRequest,
      interactionOptions?: HostInteractionOptions,
    ): Promise<RetryResult> {
      revealStream(request.streamId);
      return handlers().retry.request(request, {
        cancellationScope: interactionOptions?.cancellationScope,
        cancellationResult: (cause) => cancellationResultFor('retry', cause),
      });
    },

    askUserQuestion(
      request: Parameters<NonNullable<HostInteractions['askUserQuestion']>>[0],
      interactionOptions?: HostInteractionOptions,
    ): Promise<UserQuestionSettlement> {
      revealStream(request.streamId || undefined);
      return handlers().userQuestion.request(request, {
        cancellationScope: interactionOptions?.cancellationScope,
        cancellationResult: (cause) =>
          cancellationResultFor('userQuestion', cause),
      });
    },

    async openExternalInquiry(request) {
      revealStream(request.streamId || undefined);
      handlers().externalInquiry.show(request);
      return { threadId: request.threadId };
    },

    cancel,

    dispose(): void {
      cancel({ cause: SESSION_DISPOSED_CAUSE });
    },
  };
}
