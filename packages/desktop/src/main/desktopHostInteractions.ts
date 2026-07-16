import { nanoid } from 'nanoid';
import {
  cancelApprovalRequestHandlers,
  type ApprovalRequestHandlerSet,
} from '@controllers/progressView/backend/progressBackendUiConfig';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import {
  cancellationResultFor,
  type BashSettlement,
  type HostBashApprovalRequest,
  type HostBashApprovalResult,
  type HostInteractionCancelSelector,
  type HostInteractionOptions,
  type HostInteractions,
  type HostPlanApprovalRequest,
  type HostRetryRequest,
  type HostUserQuestionResult,
  type PlanApprovalResult,
  type ProposalResult,
  type RetryResult,
  type SettledInteractionKind,
  type UserQuestionSettlement,
} from '@agent/runtime/HostInteractions';
import {
  toBashApprovalResult,
  toUserQuestionResult,
} from '@agent/runtime/hostInteractionResultMappers';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentProposalPermission, StreamTabId } from '@shared/schemas';
import type {
  ToolEditApprovalRequest,
  ToolEditApprovalResult,
} from '@platform/interfaces';

import type { DesktopToolEditApprovalController } from './desktopToolEditApproval.js';

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
  submitBashDecision(requestId: string, decision: BashSettlement): boolean;
  submitPlanDecision(requestId: string, decision: PlanApprovalResult): boolean;
  submitProposalDecision(requestId: string, decision: ProposalResult): boolean;
  submitUserQuestionDecision(
    requestId: string,
    decision: UserQuestionSettlement,
  ): boolean;
  dismissExternalInquiry(requestId: string): void;
}

const DESKTOP_PROGRESS_INTERACTION_KINDS = [
  'bash',
  'plan',
  'proposal',
  'userQuestion',
] as const satisfies readonly SettledInteractionKind[];

export function createDesktopHostInteractions(
  options: DesktopHostInteractionsOptions,
): DesktopHostInteractions {
  return new DesktopHostInteractionsImpl(options);
}

class DesktopHostInteractionsImpl implements DesktopHostInteractions {
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
    this.revealStream(streamId);
    return this.options.getApprovalHandlers().bash.request(payload, {
      cancellationScope: options?.cancellationScope,
      cancellationResult: (cause) => cancellationResultFor('bash', cause),
    });
  }

  requestPlanApproval(
    request: HostPlanApprovalRequest,
    options?: HostInteractionOptions,
  ): Promise<PlanApprovalResult> {
    this.revealStream(request.streamId);
    return this.options.getApprovalHandlers().planApproval.request(request, {
      cancellationScope: options?.cancellationScope,
      cancellationResult: (cause) => cancellationResultFor('plan', cause),
    });
  }

  requestAgentProposal(
    request: AgentProposalPermission,
    options?: HostInteractionOptions,
  ): Promise<ProposalResult> {
    this.revealStream(request.streamId);
    return this.options.getApprovalHandlers().agentProposal.request(request, {
      cancellationScope: options?.cancellationScope,
      cancellationResult: (cause) => cancellationResultFor('proposal', cause),
    });
  }

  requestRetry(_request: HostRetryRequest): Promise<RetryResult> {
    return Promise.resolve({ action: 'cancel' });
  }

  askUserQuestion(
    request: Parameters<NonNullable<HostInteractions['askUserQuestion']>>[0],
    options?: HostInteractionOptions,
  ): Promise<HostUserQuestionResult> {
    const streamId = request.streamId || undefined;
    this.revealStream(streamId);
    return this.options.getApprovalHandlers().userQuestion.request(request, {
      cancellationScope: options?.cancellationScope,
      cancellationResult: (cause) =>
        cancellationResultFor('userQuestion', cause),
    });
  }

  openExternalInquiry(
    request: Parameters<
      NonNullable<HostInteractions['openExternalInquiry']>
    >[0],
  ): Promise<{ threadId: string }> {
    this.options.getApprovalHandlers().externalInquiry.show(request);
    return Promise.resolve({ threadId: request.threadId });
  }

  submitBashDecision(requestId: string, decision: BashSettlement): boolean {
    return this.options
      .getApprovalHandlers()
      .bash.complete(requestId, toBashApprovalResult(decision));
  }

  submitPlanDecision(requestId: string, decision: PlanApprovalResult): boolean {
    return this.options
      .getApprovalHandlers()
      .planApproval.complete(requestId, decision);
  }

  submitProposalDecision(requestId: string, decision: ProposalResult): boolean {
    return this.options
      .getApprovalHandlers()
      .agentProposal.complete(requestId, decision);
  }

  submitUserQuestionDecision(
    requestId: string,
    decision: UserQuestionSettlement,
  ): boolean {
    return this.options
      .getApprovalHandlers()
      .userQuestion.complete(requestId, toUserQuestionResult(decision));
  }

  dismissExternalInquiry(requestId: string): void {
    this.options.getApprovalHandlers().externalInquiry.dismiss(requestId);
  }

  async approvePendingDelegatedWork(
    streamId: StreamTabId,
    initiatingProposalId: string,
  ): Promise<void> {
    const handlers = this.options.getApprovalHandlers();
    handlers.bash.completeWhere(
      (request) => request.streamId === streamId,
      toBashApprovalResult({ action: 'approve' }),
    );
    handlers.agentProposal.completeWhere(
      (request) =>
        request.streamId === streamId &&
        request.proposalId !== initiatingProposalId,
      { action: 'approve' },
    );
    await this.options.getToolEditApprovals().approvePendingForStream(streamId);
  }

  cancel(selector: HostInteractionCancelSelector = {}): void {
    if (selector.kind == null || selector.kind === 'toolEdit') {
      this.options.getToolEditApprovals().cancel(selector);
    }
    cancelApprovalRequestHandlers(
      this.options.getApprovalHandlers(),
      DESKTOP_PROGRESS_INTERACTION_KINDS,
      selector,
    );
  }

  dispose(): void {
    this.cancel({ cause: 'Desktop session disposed.' });
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
