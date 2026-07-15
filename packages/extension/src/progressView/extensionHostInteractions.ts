import { nanoid } from 'nanoid';

import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import {
  cancellationSettlementFor,
  matchesCancelSelector,
  type HostBashApprovalRequest,
  type HostBashApprovalResult,
  type HostInteractionCancelSelector,
  type HostInteractionOptions,
  type HostInteractionResultByKind,
  type HostInteractionSettlement,
  type HostInteractions,
  type HostPlanApprovalRequest,
  type HostRetryRequest,
  type HostUserQuestionResult,
  type PlanApprovalResult,
  type ProposalResult,
  type RetryResult,
  type RetrySettlement,
} from '@agent/runtime/HostInteractions';
import {
  toBashApprovalResult,
  toUserQuestionResult,
} from '@agent/runtime/hostInteractionResultMappers';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  approveNativeToolEditApprovals,
  cancelNativeToolEditApprovals,
  nativeRequestApproval,
} from '@frontend/approval/nativeToolEditApproval';
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

export interface ExtensionHostInteractions extends HostInteractions {
  /** Approve work requests that were already pending when stream bypass began. */
  approvePendingDelegatedWork(
    streamId: StreamTabId,
    initiatingProposalId: string,
  ): Promise<void>;
  isRetryPending(streamId: StreamTabId, requestId: string): boolean;
  resolveRetry(
    streamId: StreamTabId,
    requestId: string,
    decision: RetrySettlement,
  ): boolean;
}

type PendingKind = keyof HostInteractionResultByKind;

interface PendingExtensionRegistration<K extends PendingKind> {
  readonly id: string;
  readonly requestId?: string;
  readonly kind: K;
  readonly streamId?: StreamTabId;
  readonly cancellationScope?: object;
}

type PendingExtensionInteraction<K extends PendingKind> =
  PendingExtensionRegistration<K> & {
    settle(value: HostInteractionResultByKind[K]): void;
  };

type AnyPendingExtensionInteraction = PendingExtensionInteraction<PendingKind>;

export function createExtensionHostInteractions(
  options: ExtensionHostInteractionsOptions,
): ExtensionHostInteractions {
  const pendingRequests = new Map<string, AnyPendingExtensionInteraction>();

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

  const showPending = <K extends PendingKind>(
    pending: PendingExtensionRegistration<K>,
    show: () => void,
  ): Promise<HostInteractionResultByKind[K]> => {
    // Replacement cancellation: a request re-issued under an id that is still
    // pending dismisses the stale prompt (settling it as a rejection carrying
    // the replacement cause) before the replacement is shown.
    const replaced = pendingRequests.get(pending.id);
    if (replaced) releasePending(replaced, 'Approval request was replaced.');
    return new Promise<HostInteractionResultByKind[K]>((settle) => {
      const interaction: PendingExtensionInteraction<K> = {
        ...pending,
        settle(value) {
          settle(value);
        },
      };
      pendingRequests.set(pending.id, interaction);
      show();
    });
  };

  const resolvePending = <K extends PendingKind>(
    requestId: string,
    expectedKind: K,
    value: HostInteractionResultByKind[K],
    resolveUi: () => void,
  ): boolean => {
    const pending = pendingRequests.get(requestId);
    if (!pending || pending.kind !== expectedKind) return false;
    pendingRequests.delete(requestId);
    pending.settle(value);
    resolveUi();
    return true;
  };

  /** Release a pending interaction with its kind-specific rejection result. */
  const releasePending = (
    pending: AnyPendingExtensionInteraction,
    cause?: string,
  ): void => {
    settleInteraction(
      pending.id,
      cancellationSettlementFor(pending.kind, cause),
    );
  };

  const cancel = (selector: HostInteractionCancelSelector = {}): void => {
    if (selector.kind == null || selector.kind === 'toolEdit') {
      cancelNativeToolEditApprovals(options.session, selector);
    }
    for (const pending of [...pendingRequests.values()]) {
      if (matchesCancelSelector(pending, selector)) {
        releasePending(pending, selector.cause);
      }
    }
  };

  const approvePendingDelegatedWork = async (
    streamId: StreamTabId,
    initiatingProposalId: string,
  ): Promise<void> => {
    for (const pending of [...pendingRequests.values()]) {
      if (
        pending.streamId !== streamId ||
        (pending.kind === 'proposal' && pending.id === initiatingProposalId)
      ) {
        continue;
      }
      switch (pending.kind) {
        case 'bash':
          resolvePending(
            pending.id,
            'bash',
            toBashApprovalResult({ action: 'approve' }),
            () => handlers().bash.resolve(pending.id),
          );
          break;
        case 'proposal':
          resolvePending(pending.id, 'proposal', { action: 'approve' }, () =>
            handlers().agentProposal.resolve(pending.id),
          );
          break;
        case 'plan':
        case 'retry':
        case 'userQuestion':
          break;
      }
    }
    await approveNativeToolEditApprovals(options.session, streamId);
  };

  const isRetryPending = (
    streamId: StreamTabId,
    requestId: string,
  ): boolean => {
    const pending = pendingRequests.get(streamId);
    return pending?.kind === 'retry' && pending.requestId === requestId;
  };

  const resolveRetry = (
    streamId: StreamTabId,
    requestId: string,
    decision: RetrySettlement,
  ): boolean => {
    if (!isRetryPending(streamId, requestId)) return false;
    return resolvePending(streamId, 'retry', decision, () =>
      handlers().retry.resolve(streamId),
    );
  };

  const settleInteraction = (
    requestId: string,
    settlement: HostInteractionSettlement,
  ): boolean => {
    switch (settlement.kind) {
      case 'bash':
        return resolvePending(
          requestId,
          'bash',
          toBashApprovalResult(settlement.decision),
          () => handlers().bash.resolve(requestId),
        );
      case 'plan':
        return resolvePending(requestId, 'plan', settlement.decision, () =>
          handlers().planApproval.resolve(requestId),
        );
      case 'proposal':
        return resolvePending(requestId, 'proposal', settlement.decision, () =>
          handlers().agentProposal.resolve(requestId),
        );
      case 'retry':
        return resolvePending(requestId, 'retry', settlement.decision, () =>
          handlers().retry.resolve(requestId),
        );
      case 'userQuestion':
        return resolvePending(
          requestId,
          'userQuestion',
          toUserQuestionResult(settlement.decision),
          () => handlers().userQuestion.resolve(requestId),
        );
      case 'externalInquiry':
        handlers().externalInquiry.resolve(requestId);
        return true;
    }
  };

  return {
    approvePendingDelegatedWork,
    isRetryPending,
    resolveRetry,
    requestToolEditApproval(
      request: ToolEditApprovalRequest,
      interactionOptions?: HostInteractionOptions,
    ): Promise<ToolEditApprovalResult> {
      return nativeRequestApproval(request, {
        session: options.session,
        cancellationScope: interactionOptions?.cancellationScope,
      });
    },

    requestBashApproval(
      request: HostBashApprovalRequest,
      interactionOptions?: HostInteractionOptions,
    ): Promise<HostBashApprovalResult> {
      const requestId = `bash-${nanoid()}`;
      const streamId = request.streamId ?? '';
      revealStream(request.streamId);
      return showPending(
        {
          id: requestId,
          kind: 'bash',
          streamId,
          cancellationScope: interactionOptions?.cancellationScope,
        },
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
      interactionOptions?: HostInteractionOptions,
    ): Promise<PlanApprovalResult> {
      revealStream(request.streamId);
      return showPending(
        {
          id: request.approvalId,
          kind: 'plan',
          streamId: request.streamId,
          cancellationScope: interactionOptions?.cancellationScope,
        },
        () => handlers().planApproval.show(request),
      );
    },

    requestAgentProposal(
      request: AgentProposalPermission,
      interactionOptions?: HostInteractionOptions,
    ): Promise<ProposalResult> {
      revealStream(request.streamId);
      return showPending(
        {
          id: request.proposalId,
          kind: 'proposal',
          streamId: request.streamId,
          cancellationScope: interactionOptions?.cancellationScope,
        },
        () => handlers().agentProposal.show(request),
      );
    },

    requestRetry(
      request: HostRetryRequest,
      interactionOptions?: HostInteractionOptions,
    ): Promise<RetryResult> {
      revealStream(request.streamId);
      return showPending(
        {
          id: request.streamId,
          requestId: request.requestId,
          kind: 'retry',
          streamId: request.streamId,
          cancellationScope: interactionOptions?.cancellationScope,
        },
        () => handlers().retry.show(request),
      );
    },

    askUserQuestion(
      request: Parameters<NonNullable<HostInteractions['askUserQuestion']>>[0],
      interactionOptions?: HostInteractionOptions,
    ): Promise<HostUserQuestionResult> {
      revealStream(request.streamId || undefined);
      return showPending(
        {
          id: request.requestId,
          kind: 'userQuestion',
          streamId: request.streamId,
          cancellationScope: interactionOptions?.cancellationScope,
        },
        () => handlers().userQuestion.show(request),
      );
    },

    async openExternalInquiry(request) {
      revealStream(request.streamId || undefined);
      handlers().externalInquiry.show(request);
      return { threadId: request.threadId };
    },

    resolve: settleInteraction,

    cancel,

    dispose(): void {
      cancel({ cause: 'Extension session disposed.' });
    },
  };
}
