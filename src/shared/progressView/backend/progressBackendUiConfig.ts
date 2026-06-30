import type {
  AgentProposalPermission,
  BashPermission,
  ExternalInquiryPermission,
  PlanApprovalPermission,
  RetryPermission,
  ToolEditPermission,
  UserQuestionPermission,
} from '@shared/schemas';

import type { ApprovalRequestHandler } from './ApprovalRequestHandler';
import type { ProgressBackendUiConfig } from './ProgressBackend';
import type { WebviewUpdater } from './WebviewUpdater';

/**
 * The seven pending-approval handlers a progress backend wires. Hosts build
 * each handler with their own show/resolve transport (and `canSend` gate), then
 * hand the set to {@link createProgressBackendUiConfig}, which derives the
 * uniform UI callbacks and the pending-permissions guard from them.
 */
export interface ApprovalRequestHandlerSet {
  toolEdit: ApprovalRequestHandler<ToolEditPermission, 'requestId'>;
  bash: ApprovalRequestHandler<BashPermission, 'requestId'>;
  retry: ApprovalRequestHandler<RetryPermission, 'streamId'>;
  agentProposal: ApprovalRequestHandler<AgentProposalPermission, 'proposalId'>;
  planApproval: ApprovalRequestHandler<PlanApprovalPermission, 'approvalId'>;
  externalInquiry: ApprovalRequestHandler<
    ExternalInquiryPermission,
    'requestId'
  >;
  userQuestion: ApprovalRequestHandler<UserQuestionPermission, 'requestId'>;
}

export interface ProgressBackendUiConfigParams {
  handlers: ApprovalRequestHandlerSet;
  /** Transport for the bypass-state pushes (handlers own their own transport). */
  webviewUpdater: WebviewUpdater;
  /** Gate shared with the handlers; also guards the bypass-state pushes. */
  canSend: () => boolean;
  /**
   * Retry is host-specific and so is supplied directly rather than derived from
   * `handlers.retry`: the extension shows a retry panel (via that handler),
   * while the desktop has no panel and instead cancels the retry. The retry
   * handler still participates in the pending guard — it stays empty on hosts
   * that never call `show` on it.
   */
  showRetryRequest: (payload: RetryPermission) => void;
  resolveRetryRequest: (streamId: string) => void;
}

/**
 * Build the host-neutral {@link ProgressBackendUiConfig} (UI callbacks plus the
 * pending-permissions guard) from a set of {@link ApprovalRequestHandler}s.
 *
 * Every show/resolve callback (other than retry) delegates to its handler, so
 * host differences live entirely in how each handler is constructed (its
 * show/resolve transport and `canSend` gate) — not in this wiring. The guard
 * ORs `hasPendingForStream` across all handlers, reusing the handler's
 * empty-streamId-blocks-all rule instead of re-deriving it per host.
 */
export function createProgressBackendUiConfig(
  params: ProgressBackendUiConfigParams,
): ProgressBackendUiConfig {
  const { handlers, webviewUpdater, canSend } = params;
  return {
    callbacks: {
      showRetryRequest: params.showRetryRequest,
      resolveRetryRequest: params.resolveRetryRequest,
      showToolEditPermission: (p) => handlers.toolEdit.show(p),
      resolveToolEditPermission: (id) => handlers.toolEdit.resolve(id),
      updateToolEditApprovalBypassState: (streamId, bypassActive) => {
        if (canSend()) {
          webviewUpdater.updateBypassState(streamId, 'toolEdit', bypassActive);
        }
      },
      updateSuperYoloBypassState: (streamId, bypassActive) => {
        if (canSend()) {
          webviewUpdater.updateBypassState(streamId, 'superYolo', bypassActive);
        }
      },
      showBashPermission: (p) => handlers.bash.show(p),
      resolveBashPermission: (id) => handlers.bash.resolve(id),
      showAgentProposal: (p) => handlers.agentProposal.show(p),
      resolveAgentProposal: (id) => handlers.agentProposal.resolve(id),
      showPlanApproval: (p) => handlers.planApproval.show(p),
      resolvePlanApproval: (id) => handlers.planApproval.resolve(id),
      showExternalInquiry: (p) => handlers.externalInquiry.show(p),
      resolveExternalInquiry: (id) => handlers.externalInquiry.resolve(id),
      showUserQuestion: (p) => handlers.userQuestion.show(p),
      resolveUserQuestion: (id) => handlers.userQuestion.resolve(id),
    },
    hasPendingPermissions: (streamId) =>
      handlers.retry.hasPendingForStream(streamId) ||
      handlers.toolEdit.hasPendingForStream(streamId) ||
      handlers.bash.hasPendingForStream(streamId) ||
      handlers.agentProposal.hasPendingForStream(streamId) ||
      handlers.planApproval.hasPendingForStream(streamId) ||
      handlers.externalInquiry.hasPendingForStream(streamId) ||
      handlers.userQuestion.hasPendingForStream(streamId),
  };
}
