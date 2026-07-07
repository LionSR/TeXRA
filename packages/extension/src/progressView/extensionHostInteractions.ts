import { nanoid } from 'nanoid';

import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type {
  HostBashApprovalRequest,
  HostBashApprovalResult,
  HostInteractionResolution,
  HostInteractions,
  HostPlanApprovalRequest,
  HostRetryRequest,
  HostUserQuestionResult,
  PendingHostInteraction,
} from '@agent/runtime/HostInteractions';
import type { PlanApprovalResult } from '@agent/runtime/PlanApprovalCoordinator';
import type { ProposalResult } from '@agent/runtime/AgentProposalCoordinator';
import type { RetryResult } from '@agent/runtime/RetryRequestCoordinator';
import type {
  ProgressEvent,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventContract';
import { nativeRequestApproval } from '@frontend/approval/nativeToolEditApproval';
import type {
  AgentProposalPermission,
  StreamTabId,
  UserQuestionAnswers,
} from '@shared/schemas';
import type { ApprovalRequestHandlerSet } from '@shared/progressView/backend/progressBackendUiConfig';
import type {
  ToolEditApprovalRequest,
  ToolEditApprovalResult,
} from '@platform/interfaces/toolEditApproval';

export interface ExtensionHostInteractionsOptions {
  runtimeHost: AgentRuntimeHost;
  getApprovalHandlers(): ApprovalRequestHandlerSet;
  removeStream(streamId: StreamTabId): void;
  handleProgressEvent<K extends ProgressEvent>(
    event: K,
    payload: ProgressEventPayloads[K],
  ): void;
}

type PendingKind = 'bash' | 'plan' | 'proposal' | 'retry' | 'userQuestion';

interface PendingExtensionInteraction<T> extends PendingHostInteraction {
  readonly kind: PendingKind;
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

  const activateStream = (streamId?: StreamTabId | null) => {
    options.runtimeHost.emit('requestEnsureProgressView', {});
    if (streamId) {
      options.runtimeHost.emit('setActiveStream', { streamId });
    }
  };

  const showPending = <T extends PendingExtensionInteractionValue>(
    pending: Omit<PendingExtensionInteraction<T>, 'settle'>,
    show: () => void,
  ): Promise<T> => {
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

  const releasePending = (
    pending: PendingExtensionInteraction<PendingExtensionInteractionValue>,
  ): void => {
    pendingRequests.delete(pending.id);
    switch (pending.kind) {
      case 'bash':
        handlers().bash.resolve(pending.id);
        pending.settle({ accepted: false });
        break;
      case 'plan':
        handlers().planApproval.resolve(pending.id);
        pending.settle({ action: 'reject' });
        break;
      case 'proposal':
        handlers().agentProposal.resolve(pending.id);
        pending.settle({ action: 'reject' });
        break;
      case 'retry':
        handlers().retry.resolve(pending.id);
        pending.settle({ action: 'cancel' });
        break;
      case 'userQuestion':
        handlers().userQuestion.resolve(pending.id);
        pending.settle({ submitted: false });
        break;
    }
  };

  return {
    requestToolEditApproval(
      request: ToolEditApprovalRequest,
    ): Promise<ToolEditApprovalResult> {
      return nativeRequestApproval(request);
    },

    requestBashApproval(
      request: HostBashApprovalRequest,
    ): Promise<HostBashApprovalResult> {
      const requestId = `bash-${nanoid()}`;
      const streamId = request.streamId ?? '';
      activateStream(request.streamId);
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
      activateStream(request.streamId);
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
      activateStream(request.streamId);
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
      activateStream(request.streamId);
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
      activateStream(request.streamId || undefined);
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
      activateStream(request.streamId || undefined);
      handlers().externalInquiry.show(request);
      return { threadId: request.threadId };
    },

    handleProgressEvent(event, payload): boolean {
      if (event === 'addOutputFiles') return true;
      if (event === 'removeStream') {
        const data = payload as ProgressEventPayloads['removeStream'];
        options.removeStream(data.streamId);
        return true;
      }
      options.handleProgressEvent(event, payload);
      return true;
    },

    pending(): readonly PendingHostInteraction[] {
      return [...pendingRequests.values()].map(({ id, kind, streamId }) => ({
        id,
        kind,
        streamId,
      }));
    },

    resolve(requestId: string, result: HostInteractionResolution): boolean {
      switch (result.kind) {
        case 'bash':
          return resolvePending<HostBashApprovalResult>(
            requestId,
            'bash',
            {
              accepted: result.action === 'approve',
              userMessage:
                result.action === 'reject'
                  ? result.feedback?.trim()
                  : undefined,
            },
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
            result.action === 'retry'
              ? { action: 'retry', feedback: result.feedback }
              : { action: 'cancel' },
            () => handlers().retry.resolve(requestId),
          );
        case 'userQuestion':
          return resolvePending<HostUserQuestionResult>(
            requestId,
            'userQuestion',
            {
              submitted: result.action === 'submit',
              answers:
                result.action === 'submit'
                  ? (result.value as UserQuestionAnswers | undefined)
                  : undefined,
              feedback:
                result.action === 'submit' ? undefined : result.feedback,
            },
            () => handlers().userQuestion.resolve(requestId),
          );
        case 'externalInquiry':
          handlers().externalInquiry.resolve(requestId);
          return true;
        default:
          return false;
      }
    },

    cancelForStream(streamId: StreamTabId): void {
      for (const pending of [...pendingRequests.values()]) {
        if (pending.streamId === streamId) {
          releasePending(pending);
        }
      }
    },

    cancelUnscoped(cause?: string): void {
      void cause;
      for (const pending of [...pendingRequests.values()]) {
        if (!pending.streamId) {
          releasePending(pending);
        }
      }
    },

    cancelAll(cause?: string): void {
      void cause;
      for (const pending of [...pendingRequests.values()]) {
        releasePending(pending);
      }
    },

    dispose(): void {
      for (const pending of [...pendingRequests.values()]) {
        releasePending(pending);
      }
    },
  };
}

function toPlanApprovalResult(
  result: HostInteractionResolution,
): PlanApprovalResult {
  if (result.action === 'approve') return { action: 'approve' };
  if (result.action === 'approve_and_goal')
    return { action: 'approve_and_goal' };
  return { action: 'reject', feedback: result.feedback };
}

function toProposalResult(result: HostInteractionResolution): ProposalResult {
  const value = result.value as ProposalResult | undefined;
  if (value?.action === 'approve') return value;
  if (value?.action === 'setup') return value;
  if (value?.action === 'reject') return value;
  if (result.action === 'setup') return { action: 'setup' };
  if (result.action === 'approve') return { action: 'approve' };
  return { action: 'reject', feedback: result.feedback };
}
