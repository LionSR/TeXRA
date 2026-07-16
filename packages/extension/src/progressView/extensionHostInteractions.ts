import { nanoid } from 'nanoid';
import * as vscode from 'vscode';

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
  approveNativeToolEditApprovals,
  cancelNativeToolEditApprovals,
  nativeRequestApproval,
} from '@frontend/approval/nativeToolEditApproval';
import { getLinterMessages } from '@frontend/latex/linter';
import { pushManualCriticism } from '@frontend/latex/inlineCriticism';
import type { AgentProposalPermission, StreamTabId } from '@shared/schemas';
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

const EXTENSION_PROGRESS_INTERACTION_KINDS = [
  'bash',
  'plan',
  'proposal',
  'retry',
  'userQuestion',
] as const satisfies readonly SettledInteractionKind[];

export function createExtensionHostInteractions(
  options: ExtensionHostInteractionsOptions,
): ExtensionHostInteractions {
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

  const cancel = (selector: HostInteractionCancelSelector = {}): void => {
    if (selector.kind == null || selector.kind === 'toolEdit') {
      cancelNativeToolEditApprovals(options.session, selector);
    }
    cancelApprovalRequestHandlers(
      handlers(),
      EXTENSION_PROGRESS_INTERACTION_KINDS,
      selector,
    );
  };

  const approvePendingDelegatedWork = async (
    streamId: StreamTabId,
    initiatingProposalId: string,
  ): Promise<void> => {
    handlers().bash.completeWhere(
      (item) => item.streamId === streamId,
      toBashApprovalResult({ action: 'approve' }),
    );
    handlers().agentProposal.completeWhere(
      (item) =>
        item.streamId === streamId && item.proposalId !== initiatingProposalId,
      { action: 'approve' },
    );
    await approveNativeToolEditApprovals(options.session, streamId);
  };

  const isRetryPending = (
    streamId: StreamTabId,
    requestId: string,
  ): boolean => {
    return handlers().retry.get(streamId)?.requestId === requestId;
  };

  const submitRetryDecision = (
    streamId: StreamTabId,
    requestId: string,
    decision: RetrySettlement,
  ): boolean => {
    if (!isRetryPending(streamId, requestId)) return false;
    return handlers().retry.complete(streamId, decision);
  };

  const submitBashDecision = (
    requestId: string,
    decision: BashSettlement,
  ): boolean =>
    handlers().bash.complete(requestId, toBashApprovalResult(decision));

  const submitPlanDecision = (
    requestId: string,
    decision: PlanApprovalResult,
  ): boolean => handlers().planApproval.complete(requestId, decision);

  const submitProposalDecision = (
    requestId: string,
    decision: ProposalResult,
  ): boolean => handlers().agentProposal.complete(requestId, decision);

  const submitUserQuestionDecision = (
    requestId: string,
    decision: UserQuestionSettlement,
  ): boolean =>
    handlers().userQuestion.complete(requestId, toUserQuestionResult(decision));

  return {
    readDiagnostics: getLinterMessages,
    addCriticism: (payload) => {
      const accepted = pushManualCriticism(payload);
      return { accepted, resolvedPath: payload.absolutePath };
    },
    notifyUnavailableTools: (message, actionCommand, actionLabel) => {
      if (!actionCommand) {
        void vscode.window.showInformationMessage(message);
        return;
      }
      const label = actionLabel ?? 'Open Tools Dashboard';
      void vscode.window
        .showInformationMessage(message, label)
        .then((choice) => {
          if (choice === label) {
            void vscode.commands.executeCommand(actionCommand);
          }
        });
    },
    approvePendingDelegatedWork,
    isRetryPending,
    submitBashDecision,
    submitPlanDecision,
    submitProposalDecision,
    submitRetryDecision,
    submitUserQuestionDecision,
    dismissExternalInquiry: (requestId) =>
      handlers().externalInquiry.dismiss(requestId),
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
      return handlers().bash.request(
        {
          requestId,
          command: request.command,
          ...(request.cwd ? { cwd: request.cwd } : {}),
          allowBypass: true,
          streamId,
        },
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
        cancellationResult: (cause) => cancellationResultFor('plan', cause),
      });
    },

    requestAgentProposal(
      request: AgentProposalPermission,
      interactionOptions?: HostInteractionOptions,
    ): Promise<ProposalResult> {
      revealStream(request.streamId);
      return handlers().agentProposal.request(request, {
        cancellationScope: interactionOptions?.cancellationScope,
        cancellationResult: (cause) => cancellationResultFor('proposal', cause),
      });
    },

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
    ): Promise<HostUserQuestionResult> {
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
      cancel({ cause: 'Extension session disposed.' });
    },
  };
}
