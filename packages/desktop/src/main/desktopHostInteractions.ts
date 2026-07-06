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
  AgentProposalPermission,
  StreamTabId,
  UserQuestionAnswers,
} from '@shared/schemas';
import type { ApprovalRequestHandlerSet } from '@shared/progressView/backend/progressBackendUiConfig';
import type {
  ToolEditApprovalRequest,
  ToolEditApprovalResult,
} from '@platform/interfaces/toolEditApproval';

import type { DesktopToolEditApprovalController } from './desktopToolEditApproval.js';

type PendingDesktopInteraction =
  | {
      kind: 'bash';
      streamId?: StreamTabId;
      settle: (result: HostBashApprovalResult) => void;
    }
  | {
      kind: 'plan';
      streamId: StreamTabId;
      settle: (result: PlanApprovalResult) => void;
    }
  | {
      kind: 'proposal';
      streamId: StreamTabId;
      settle: (result: ProposalResult) => void;
    }
  | {
      kind: 'userQuestion';
      streamId?: StreamTabId;
      settle: (result: HostUserQuestionResult) => void;
    };

export interface DesktopHostInteractionsOptions {
  runtimeHost: AgentRuntimeHost;
  getApprovalHandlers(): ApprovalRequestHandlerSet;
  getToolEditApprovals(): DesktopToolEditApprovalController;
}

export function createDesktopHostInteractions(
  options: DesktopHostInteractionsOptions,
): HostInteractions {
  return new DesktopHostInteractions(options);
}

class DesktopHostInteractions implements HostInteractions {
  private readonly pendingRequests = new Map<
    string,
    PendingDesktopInteraction
  >();

  constructor(private readonly options: DesktopHostInteractionsOptions) {}

  requestToolEditApproval(
    request: ToolEditApprovalRequest,
  ): Promise<ToolEditApprovalResult> {
    return this.options.getToolEditApprovals().requestApproval(request);
  }

  requestBashApproval(
    request: HostBashApprovalRequest,
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
    return this.showPending(requestId, { kind: 'bash', streamId }, (settle) => {
      this.activateStream(streamId);
      this.options.getApprovalHandlers().bash.show(payload);
      return settle;
    });
  }

  requestPlanApproval(
    request: HostPlanApprovalRequest,
  ): Promise<PlanApprovalResult> {
    return this.showPending(
      request.approvalId,
      { kind: 'plan', streamId: request.streamId },
      (settle) => {
        this.options.getApprovalHandlers().planApproval.show(request);
        return settle;
      },
    );
  }

  requestAgentProposal(
    request: AgentProposalPermission,
  ): Promise<ProposalResult> {
    return this.showPending(
      request.proposalId,
      { kind: 'proposal', streamId: request.streamId },
      (settle) => {
        this.options.getApprovalHandlers().agentProposal.show(request);
        return settle;
      },
    );
  }

  requestRetry(_request: HostRetryRequest): Promise<RetryResult> {
    return Promise.resolve({ action: 'cancel' });
  }

  askUserQuestion(
    request: Parameters<NonNullable<HostInteractions['askUserQuestion']>>[0],
  ): Promise<HostUserQuestionResult> {
    const streamId = request.streamId || undefined;
    return this.showPending(
      request.requestId,
      { kind: 'userQuestion', streamId },
      (settle) => {
        this.activateStream(streamId);
        this.options.getApprovalHandlers().userQuestion.show(request);
        return settle;
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

  handleProgressEvent(): boolean {
    return false;
  }

  pending(): readonly PendingHostInteraction[] {
    return [...this.pendingRequests.entries()].map(([id, request]) => ({
      id,
      kind: request.kind,
      ...(request.streamId ? { streamId: request.streamId } : {}),
    }));
  }

  resolve(requestId: string, result: HostInteractionResolution): boolean {
    if (result.kind === 'externalInquiry') {
      this.options.getApprovalHandlers().externalInquiry.resolve(requestId);
      return true;
    }

    const request = this.pendingRequests.get(requestId);
    if (!request) return false;
    this.pendingRequests.delete(requestId);

    switch (request.kind) {
      case 'bash':
        request.settle({
          accepted: result.action === 'approve',
          ...(result.feedback ? { userMessage: result.feedback } : {}),
        });
        this.options.getApprovalHandlers().bash.resolve(requestId);
        return true;
      case 'plan':
        request.settle(
          result.action === 'approve' || result.action === 'approve_and_goal'
            ? { action: result.action }
            : {
                action: 'reject',
                ...(result.feedback ? { feedback: result.feedback } : {}),
              },
        );
        this.options.getApprovalHandlers().planApproval.resolve(requestId);
        return true;
      case 'proposal':
        request.settle(toProposalResult(result));
        this.options.getApprovalHandlers().agentProposal.resolve(requestId);
        return true;
      case 'userQuestion':
        request.settle({
          submitted: result.action === 'submit',
          ...(result.value
            ? { answers: result.value as UserQuestionAnswers }
            : {}),
          ...(result.feedback ? { feedback: result.feedback } : {}),
        });
        this.options.getApprovalHandlers().userQuestion.resolve(requestId);
        return true;
    }
  }

  cancelForStream(streamId: StreamTabId, cause?: string): void {
    for (const [requestId, request] of [...this.pendingRequests.entries()]) {
      if (request.streamId !== streamId) continue;
      this.resolve(requestId, {
        kind: request.kind,
        action: 'reject',
        feedback: cause,
      });
    }
  }

  dispose(): void {
    for (const requestId of [...this.pendingRequests.keys()]) {
      this.resolve(requestId, {
        kind: 'dispose',
        action: 'reject',
        feedback: 'Desktop session disposed.',
      });
    }
  }

  private showPending<TResult, TEntry extends PendingDesktopInteraction>(
    requestId: string,
    entry: Omit<TEntry, 'settle'>,
    show: (settle: TEntry['settle']) => TEntry['settle'],
  ): Promise<TResult> {
    return new Promise<TResult>((resolve) => {
      const settle = show((result) => resolve(result as TResult));
      this.pendingRequests.set(requestId, {
        ...entry,
        settle,
      } as TEntry);
    });
  }

  private activateStream(streamId: StreamTabId | undefined): void {
    this.options.runtimeHost.emit('requestEnsureProgressView', {});
    if (streamId)
      this.options.runtimeHost.emit('setActiveStream', { streamId });
  }
}

function toProposalResult(result: HostInteractionResolution): ProposalResult {
  if (result.value && typeof result.value === 'object') {
    const value = result.value as ProposalResult;
    if ('action' in value) return value;
  }
  return result.action === 'approve' || result.action === 'setup'
    ? { action: result.action }
    : {
        action: 'reject',
        ...(result.feedback ? { feedback: result.feedback } : {}),
      };
}
