import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

/** All UI callbacks for retry, approval, and proposal event handling. */
export interface UICallbacks {
  showRetryRequest: (
    payload: ProgressEventPayloads['showRetryRequest'],
  ) => void;
  resolveRetryRequest: (streamId: string) => void;
  showToolEditPermission: (
    payload: ProgressEventPayloads['showToolEditPermission'],
  ) => void;
  resolveToolEditPermission: (requestId: string) => void;
  updateToolEditApprovalBypassState: (
    streamId: string,
    bypassActive: boolean,
  ) => void;
  updateSuperYoloBypassState: (streamId: string, bypassActive: boolean) => void;
  showBashPermission: (
    payload: ProgressEventPayloads['showBashPermission'],
  ) => void;
  resolveBashPermission: (requestId: string) => void;
  showAgentProposal: (
    payload: ProgressEventPayloads['showAgentProposal'],
  ) => void;
  resolveAgentProposal: (proposalId: string) => void;
  showPlanApproval: (
    payload: ProgressEventPayloads['showPlanApproval'],
  ) => void;
  resolvePlanApproval: (approvalId: string) => void;
  showExternalInquiry: (
    payload: ProgressEventPayloads['showExternalInquiry'],
  ) => void;
  resolveExternalInquiry: (requestId: string) => void;
  showUserQuestion: (
    payload: ProgressEventPayloads['showUserQuestion'],
  ) => void;
  resolveUserQuestion: (requestId: string) => void;
}
