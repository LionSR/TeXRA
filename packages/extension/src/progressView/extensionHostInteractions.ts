import { nanoid } from 'nanoid';

import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import {
  matchesCancelSelector,
  type HostBashApprovalRequest,
  type HostBashApprovalResult,
  type HostInteractionCancelSelector,
  type HostInteractionResolution,
  type HostInteractions,
  type HostPlanApprovalRequest,
  type HostRetryRequest,
  type HostUserQuestionResult,
  type PendingInteractionKind,
  type PlanApprovalResult,
  type ProposalResult,
  type RetryResult,
} from '@agent/runtime/HostInteractions';
import {
  toBashApprovalResult,
  toPlanApprovalResult,
  toProposalResult,
  toRetryResult,
  toUserQuestionResult,
} from '@agent/runtime/hostInteractionResultMappers';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { nativeRequestApproval } from '@frontend/approval/nativeToolEditApproval';
import type { AgentProposalPermission, StreamTabId } from '@shared/schemas';
import type { ApprovalRequestHandlerSet } from '@controllers/progressView/backend/progressBackendUiConfig';
import type {
  ToolEditApprovalRequest,
  ToolEditApprovalResult,
} from '@platform/interfaces';

export interface ExtensionHostInteractionsOptions {
  runtimeHost: AgentRuntimeHost;
  session: SessionHandle;
  getApprovalHandlers(): ApprovalRequestHandlerSet;
}

type PendingKind = Extract<
  PendingInteractionKind,
  'bash' | 'plan' | 'proposal' | 'retry' | 'userQuestion'
>;

interface PendingExtensionInteraction<T> {
  readonly id: string;
  readonly kind: PendingKind;
  readonly streamId?: StreamTabId;
  readonly settle: (value: T) => void;
}

type PendingExtensionInteractionValue =
  | HostBashApprovalResult
  | PlanApprovalResult
  | ProposalResult
  | RetryResult
  | HostUserQuestionResult;

export function createExtensionHostInteractions(
  options: ExtensionHostInteractionsOptions,
): HostInteractions {
  const pendingRequests = new Map<
    string,
    PendingExtensionInteraction<PendingExtensionInteractionValue>
  >();

  const handlers = () => options.getApprovalHandlers();

  // Interaction requests surface per-stream: the request panel is scoped to
  // the viewed stream and the requesting stream's row shows a pending badge.
  // `suppressViewSwitch` registers the stream so that row exists without
  // yanking the active tab away from whatever the user is inspecting (#8246).
  const revealStream = (streamId?: StreamTabId | null) => {
    options.runtimeHost.emit('requestEnsureProgressView', {});
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

  const showPending = <T extends PendingExtensionInteractionValue>(
    pending: Omit<PendingExtensionInteraction<T>, 'settle'>,
    show: () => void,
  ): Promise<T> => {
    // Replacement cancellation: a request re-issued under an id that is still
    // pending dismisses the stale prompt (settling it as a rejection carrying
    // the replacement cause) before the replacement is shown.
    const replaced = pendingRequests.get(pending.id);
    if (replaced) releasePending(replaced, 'Approval request was replaced.');
    return new Promise<T>((resolve) => {
      pendingRequests.set(pending.id, {
        ...pending,
        settle: resolve as (value: PendingExtensionInteractionValue) => void,
      });
      show();
    });
  };

  const resolvePending = <T extends PendingExtensionInteractionValue>(
    requestId: string,
    expectedKind: PendingKind,
    value: T,
    resolveUi: () => void,
  ): boolean => {
    const pending = pendingRequests.get(requestId);
    if (!pending || pending.kind !== expectedKind) return false;
    pendingRequests.delete(requestId);
    pending.settle(value);
    resolveUi();
    return true;
  };

  /**
   * Releases a pending interaction as a synthesized rejection, forwarding
   * `cause` as agent-visible feedback through the same result mappers
   * `resolve()` uses — so a cancellation and a live UI rejection settle
   * identically for a given kind.
   */
  const releasePending = (
    pending: PendingExtensionInteraction<PendingExtensionInteractionValue>,
    cause?: string,
  ): void => {
    pendingRequests.delete(pending.id);
    const rejection: HostInteractionResolution = {
      kind: pending.kind,
      action: 'reject',
      feedback: cause,
    };
    switch (pending.kind) {
      case 'bash':
        handlers().bash.resolve(pending.id);
        pending.settle(toBashApprovalResult(rejection));
        break;
      case 'plan':
        handlers().planApproval.resolve(pending.id);
        pending.settle(toPlanApprovalResult(rejection));
        break;
      case 'proposal':
        handlers().agentProposal.resolve(pending.id);
        pending.settle(toProposalResult(rejection));
        break;
      case 'retry':
        handlers().retry.resolve(pending.id);
        pending.settle(toRetryResult(rejection));
        break;
      case 'userQuestion':
        handlers().userQuestion.resolve(pending.id);
        pending.settle(toUserQuestionResult(rejection));
        break;
    }
  };

  const cancel = (selector: HostInteractionCancelSelector = {}): void => {
    for (const pending of [...pendingRequests.values()]) {
      if (matchesCancelSelector(pending, selector)) {
        releasePending(pending, selector.cause);
      }
    }
  };

  return {
    requestToolEditApproval(
      request: ToolEditApprovalRequest,
    ): Promise<ToolEditApprovalResult> {
      return nativeRequestApproval(request, { session: options.session });
    },

    requestBashApproval(
      request: HostBashApprovalRequest,
    ): Promise<HostBashApprovalResult> {
      const requestId = `bash-${nanoid()}`;
      const streamId = request.streamId ?? '';
      revealStream(request.streamId);
      return showPending<HostBashApprovalResult>(
        { id: requestId, kind: 'bash', streamId },
        () =>
          handlers().bash.show({
            requestId,
            command: request.command,
            ...(request.cwd ? { cwd: request.cwd } : {}),
            allowBypass: true,
            streamId,
          }),
      );
    },

    requestPlanApproval(
      request: HostPlanApprovalRequest,
    ): Promise<PlanApprovalResult> {
      revealStream(request.streamId);
      return showPending<PlanApprovalResult>(
        {
          id: request.approvalId,
          kind: 'plan',
          streamId: request.streamId,
        },
        () => handlers().planApproval.show(request),
      );
    },

    requestAgentProposal(
      request: AgentProposalPermission,
    ): Promise<ProposalResult> {
      revealStream(request.streamId);
      return showPending<ProposalResult>(
        {
          id: request.proposalId,
          kind: 'proposal',
          streamId: request.streamId,
        },
        () => handlers().agentProposal.show(request),
      );
    },

    requestRetry(request: HostRetryRequest): Promise<RetryResult> {
      revealStream(request.streamId);
      return showPending<RetryResult>(
        {
          id: request.streamId,
          kind: 'retry',
          streamId: request.streamId,
        },
        () => handlers().retry.show(request),
      );
    },

    askUserQuestion(
      request: Parameters<NonNullable<HostInteractions['askUserQuestion']>>[0],
    ): Promise<HostUserQuestionResult> {
      revealStream(request.streamId || undefined);
      return showPending<HostUserQuestionResult>(
        {
          id: request.requestId,
          kind: 'userQuestion',
          streamId: request.streamId,
        },
        () => handlers().userQuestion.show(request),
      );
    },

    async openExternalInquiry(request) {
      revealStream(request.streamId || undefined);
      handlers().externalInquiry.show(request);
      return { threadId: request.threadId };
    },

    resolve(requestId: string, result: HostInteractionResolution): boolean {
      switch (result.kind) {
        case 'bash':
          return resolvePending<HostBashApprovalResult>(
            requestId,
            'bash',
            toBashApprovalResult(result),
            () => handlers().bash.resolve(requestId),
          );
        case 'plan':
          return resolvePending<PlanApprovalResult>(
            requestId,
            'plan',
            toPlanApprovalResult(result),
            () => handlers().planApproval.resolve(requestId),
          );
        case 'proposal':
          return resolvePending<ProposalResult>(
            requestId,
            'proposal',
            toProposalResult(result),
            () => handlers().agentProposal.resolve(requestId),
          );
        case 'retry':
          return resolvePending<RetryResult>(
            requestId,
            'retry',
            toRetryResult(result),
            () => handlers().retry.resolve(requestId),
          );
        case 'userQuestion':
          return resolvePending<HostUserQuestionResult>(
            requestId,
            'userQuestion',
            toUserQuestionResult(result),
            () => handlers().userQuestion.resolve(requestId),
          );
        case 'externalInquiry':
          handlers().externalInquiry.resolve(requestId);
          return true;
        default:
          return false;
      }
    },

    cancel,

    dispose(): void {
      cancel({ cause: 'Extension session disposed.' });
    },
  };
}
