import type {
  AgentProposalPermission,
  BashPermission,
  ExternalInquiryPermission,
  PlanApprovalPermission,
  RetryPermission,
  StreamTabId,
  ToolEditPermission,
} from '@shared/schemas';

/**
 * Host interaction and approval UI requests emitted by runtime/tool code.
 *
 * These are not progress facts. Some hosts still route a subset of them through
 * their progress-view UI adapter for compatibility, but the vocabulary is
 * interaction-owned rather than part of the frozen progress fact map.
 */
export interface RuntimeInteractionEventPayloads {
  showRetryRequest: RetryPermission;
  showToolEditPermission: ToolEditPermission;
  resolveToolEditPermission: { requestId: string };
  updateToolEditApprovalBypassState: {
    streamId: StreamTabId;
    bypassActive: boolean;
  };
  updateBashApprovalBypassState: {
    streamId: StreamTabId;
    bypassActive: boolean;
  };
  updateSuperYoloBypassState: {
    streamId: StreamTabId;
    bypassActive: boolean;
  };
  showBashPermission: BashPermission;
  showAgentProposal: AgentProposalPermission;
  showPlanApproval: PlanApprovalPermission;
  showExternalInquiry: ExternalInquiryPermission;
}
