import { nanoid } from 'nanoid';
import type {
  RuntimePresentationEvent,
  RuntimePresentationEventPayloads,
} from '@agent/runtime/runtimePresentationEvents';
import {
  cancellationResultFor,
  type BashSettlement,
  type HostBashApprovalRequest,
  type HostBashApprovalResult,
  type HostApprovalBypassStateUpdate,
  type HostInteractionCancelSelector,
  type HostInteractionOptions,
  type HostInteractions,
  type HostPlanApprovalRequest,
  type HostRetryRequest,
  type HostUserQuestionResult,
  type PlanApprovalResult,
  type ProposalResult,
  type RetryResult,
  type RetrySettlement,
  type SettledInteractionKind,
  type UserQuestionSettlement,
} from '@agent/runtime/HostInteractions';
import {
  toBashApprovalResult,
  toUserQuestionResult,
} from '@agent/runtime/hostInteractionResultMappers';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  cancelApprovalRequestHandlers,
  type ApprovalRequestHandlerSet,
} from '@controllers/progressView/backend/progressBackendUiConfig';
import type {
  ToolEditApprovalRequest,
  ToolEditApprovalResult,
} from '@platform/interfaces';
import type { AgentProposalPermission, StreamTabId } from '@shared/schemas';

import type { DesktopToolEditApprovalController } from './desktopToolEditApproval.js';

export interface DesktopHostInteractionsOptions {
  interactions: Required<Pick<HostInteractions, 'emit'>>;
  session: SessionHandle;
  getApprovalHandlers(): ApprovalRequestHandlerSet;
  getToolEditApprovals(): DesktopToolEditApprovalController;
  setApprovalBypassState(update: HostApprovalBypassStateUpdate): void;
  showInfoMessage(message: string): Promise<void> | void;
}

export interface DesktopHostInteractions extends HostInteractions {
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

const DESKTOP_PROGRESS_INTERACTION_KINDS = [
  'bash',
  'plan',
  'proposal',
  'retry',
  'userQuestion',
] as const satisfies readonly SettledInteractionKind[];

export function createDesktopHostInteractions(
  options: DesktopHostInteractionsOptions,
): DesktopHostInteractions {
  return new DesktopHostInteractionsImpl(options);
}

class DesktopHostInteractionsImpl implements DesktopHostInteractions {
  constructor(private readonly options: DesktopHostInteractionsOptions) {}

  emit<K extends RuntimePresentationEvent>(
    event: K,
    payload: RuntimePresentationEventPayloads[K],
  ): void {
    this.options.interactions.emit(event, payload);
  }

  showInfoMessage(message: string): Promise<void> | void {
    return this.options.showInfoMessage(message);
  }

  setApprovalBypassState(update: HostApprovalBypassStateUpdate): void {
    this.options.setApprovalBypassState(update);
  }

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

  /**
   * Surface a retryable model failure to the user instead of auto-cancelling it.
   *
   * This previously resolved `{action: 'cancel'}` immediately, which terminated
   * the run with "Retry cancelled by user" without the user ever being asked.
   * It now mirrors the extension: reveal the stream and park the request on the
   * shared `retry` approval handler, whose card the progress view already
   * renders (`RetryRequestPanel`). The renderer settles it through
   * `submitRetryDecision` / a cancel decision below.
   */
  requestRetry(
    request: HostRetryRequest,
    options?: HostInteractionOptions,
  ): Promise<RetryResult> {
    this.revealStream(request.streamId);
    return this.options.getApprovalHandlers().retry.request(request, {
      cancellationScope: options?.cancellationScope,
      cancellationResult: (cause) => cancellationResultFor('retry', cause),
    });
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

  isRetryPending(streamId: StreamTabId, requestId: string): boolean {
    return (
      this.options.getApprovalHandlers().retry.get(streamId)?.requestId ===
      requestId
    );
  }

  /**
   * Settle a pending retry request. Returns false when the request is no longer
   * the pending one for that stream, so a stale renderer click cannot resolve a
   * newer request.
   */
  submitRetryDecision(
    streamId: StreamTabId,
    requestId: string,
    decision: RetrySettlement,
  ): boolean {
    if (!this.isRetryPending(streamId, requestId)) return false;
    return this.options
      .getApprovalHandlers()
      .retry.complete(streamId, decision);
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
    this.cancel({ cause: 'Desktop presentation detached.' });
  }

  // Interaction requests surface per-stream (pending badge on the stream
  // row); `suppressViewSwitch` registers the stream without yanking the
  // active tab away from whatever the user is inspecting — matches the
  // extension host contract (#8246).
  private revealStream(streamId: StreamTabId | undefined): void {
    this.options.interactions.emit('requestEnsureProgressView', {});
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
