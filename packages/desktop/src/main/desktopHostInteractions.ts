import { nanoid } from 'nanoid';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import {
  cancellationResultFor,
  matchesCancelSelector,
  type BashSettlement,
  type HostBashApprovalRequest,
  type HostBashApprovalResult,
  type HostInteractionCancelSelector,
  type HostInteractionOptions,
  type HostInteractionResultByKind,
  type HostInteractions,
  type HostPlanApprovalRequest,
  type HostRetryRequest,
  type HostUserQuestionResult,
  type PlanApprovalResult,
  type ProposalResult,
  type RetryResult,
  type UserQuestionSettlement,
} from '@agent/runtime/HostInteractions';
import {
  toBashApprovalResult,
  toUserQuestionResult,
} from '@agent/runtime/hostInteractionResultMappers';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentProposalPermission, StreamTabId } from '@shared/schemas';
import { assertNever } from '@utils/core';
import type { ApprovalRequestHandlerSet } from '@controllers/progressView/backend/progressBackendUiConfig';
import type {
  ToolEditApprovalRequest,
  ToolEditApprovalResult,
} from '@platform/interfaces';

import type { DesktopToolEditApprovalController } from './desktopToolEditApproval.js';

type PendingDesktopKind = Exclude<keyof HostInteractionResultByKind, 'retry'>;

interface PendingDesktopMetadataByKind {
  readonly bash: { readonly streamId?: StreamTabId };
  readonly plan: { readonly streamId: StreamTabId };
  readonly proposal: { readonly streamId: StreamTabId };
  readonly userQuestion: { readonly streamId?: StreamTabId };
}

type PendingDesktopRegistration<K extends PendingDesktopKind> = {
  readonly kind: K;
  readonly cancellationScope?: object;
} & PendingDesktopMetadataByKind[K];

type PendingDesktopInteraction<K extends PendingDesktopKind> =
  PendingDesktopRegistration<K> & {
    settle(result: HostInteractionResultByKind[K]): void;
  };

type AnyPendingDesktopInteraction =
  PendingDesktopInteraction<PendingDesktopKind>;

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

export function createDesktopHostInteractions(
  options: DesktopHostInteractionsOptions,
): DesktopHostInteractions {
  return new DesktopHostInteractionsImpl(options);
}

class DesktopHostInteractionsImpl implements DesktopHostInteractions {
  private readonly pendingRequests = new Map<
    string,
    AnyPendingDesktopInteraction
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

  submitBashDecision(requestId: string, decision: BashSettlement): boolean {
    return this.completePending(
      requestId,
      'bash',
      toBashApprovalResult(decision),
      () => this.options.getApprovalHandlers().bash.resolve(requestId),
    );
  }

  submitPlanDecision(requestId: string, decision: PlanApprovalResult): boolean {
    return this.completePending(requestId, 'plan', decision, () =>
      this.options.getApprovalHandlers().planApproval.resolve(requestId),
    );
  }

  submitProposalDecision(requestId: string, decision: ProposalResult): boolean {
    return this.completePending(requestId, 'proposal', decision, () =>
      this.options.getApprovalHandlers().agentProposal.resolve(requestId),
    );
  }

  submitUserQuestionDecision(
    requestId: string,
    decision: UserQuestionSettlement,
  ): boolean {
    return this.completePending(
      requestId,
      'userQuestion',
      toUserQuestionResult(decision),
      () => this.options.getApprovalHandlers().userQuestion.resolve(requestId),
    );
  }

  dismissExternalInquiry(requestId: string): void {
    this.options.getApprovalHandlers().externalInquiry.resolve(requestId);
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
      if (request.kind === 'bash') {
        this.submitBashDecision(requestId, { action: 'approve' });
      } else if (request.kind === 'proposal') {
        this.submitProposalDecision(requestId, { action: 'approve' });
      }
    }
    await this.options.getToolEditApprovals().approvePendingForStream(streamId);
  }

  cancel(selector: HostInteractionCancelSelector = {}): void {
    if (selector.kind == null || selector.kind === 'toolEdit') {
      this.options.getToolEditApprovals().cancel(selector);
    }
    for (const [requestId, request] of [...this.pendingRequests.entries()]) {
      if (!matchesCancelSelector(request, selector)) continue;
      this.rejectPending(requestId, request, selector.cause);
    }
  }

  dispose(): void {
    this.cancel({ cause: 'Desktop session disposed.' });
  }

  private showPending<K extends PendingDesktopKind>(
    requestId: string,
    entry: PendingDesktopRegistration<K>,
    show: () => void,
  ): Promise<HostInteractionResultByKind[K]> {
    // Replacement cancellation: a request re-issued under a still-pending id
    // rejects the stale prompt before the replacement is shown.
    const replaced = this.pendingRequests.get(requestId);
    if (replaced) {
      this.rejectPending(requestId, replaced, 'Approval request was replaced.');
    }
    return new Promise<HostInteractionResultByKind[K]>((settle) => {
      const interaction: PendingDesktopInteraction<K> = {
        ...entry,
        settle(result) {
          settle(result);
        },
      };
      this.pendingRequests.set(requestId, interaction);
      try {
        show();
      } catch (error) {
        this.pendingRequests.delete(requestId);
        throw error;
      }
    });
  }

  private rejectPending(
    requestId: string,
    request: AnyPendingDesktopInteraction,
    feedback?: string,
  ): void {
    switch (request.kind) {
      case 'bash':
        this.completePending(
          requestId,
          'bash',
          cancellationResultFor('bash', feedback),
          () => this.options.getApprovalHandlers().bash.resolve(requestId),
        );
        return;
      case 'plan':
        this.completePending(
          requestId,
          'plan',
          cancellationResultFor('plan', feedback),
          () =>
            this.options.getApprovalHandlers().planApproval.resolve(requestId),
        );
        return;
      case 'proposal':
        this.completePending(
          requestId,
          'proposal',
          cancellationResultFor('proposal', feedback),
          () =>
            this.options.getApprovalHandlers().agentProposal.resolve(requestId),
        );
        return;
      case 'userQuestion':
        this.completePending(
          requestId,
          'userQuestion',
          cancellationResultFor('userQuestion', feedback),
          () =>
            this.options.getApprovalHandlers().userQuestion.resolve(requestId),
        );
        return;
    }
    assertNever(request.kind, 'Unhandled desktop interaction kind');
  }

  private completePending<K extends PendingDesktopKind>(
    requestId: string,
    expectedKind: K,
    value: HostInteractionResultByKind[K],
    resolveUi: () => void,
  ): boolean {
    const pending = this.pendingRequests.get(requestId);
    if (!pending || pending.kind !== expectedKind) return false;
    this.pendingRequests.delete(requestId);
    pending.settle(value);
    resolveUi();
    return true;
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
