import type {
  ProgressEvent,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventContract';
import type {
  AgentProposal,
  Plan,
  ProviderErrorPartial,
  StreamTabId,
  UserQuestionAnswers,
  ExternalInquiryPermission,
  UserQuestionPermission,
} from '@shared/schemas';
import type {
  ToolEditApprovalRequest,
  ToolEditApprovalResult,
} from '@platform/interfaces/toolEditApproval';
import type { PlanApprovalResult } from './PlanApprovalCoordinator';
import type { ProposalResult } from './AgentProposalCoordinator';
import type { RetryResult } from './RetryRequestCoordinator';

export interface HostInteractionOptions {
  readonly timeoutMs?: number;
}

export interface HostPlanApprovalRequest {
  readonly approvalId: string;
  readonly streamId: StreamTabId;
  readonly plan: Plan;
  readonly goalEnabled: boolean;
}

export interface HostBashApprovalRequest {
  readonly command: string;
  readonly cwd?: string | null;
  readonly streamId?: StreamTabId | null;
}

export interface HostBashApprovalResult {
  readonly accepted: boolean;
  readonly userMessage?: string;
}

export type HostAgentProposalRequest = AgentProposal & {
  readonly proposalId: string;
  readonly streamId: StreamTabId;
};

export interface HostRetryRequest {
  readonly streamId: StreamTabId;
  readonly operation: string;
  readonly model?: string;
  readonly errorMessage?: string;
  readonly errorDetails?: ProviderErrorPartial;
}

export type HostUserQuestionRequest = UserQuestionPermission;

export interface HostUserQuestionResult {
  readonly submitted: boolean;
  readonly answers?: UserQuestionAnswers;
  readonly feedback?: string;
}

export type HostExternalInquiryRequest = ExternalInquiryPermission;

export interface HostExternalInquiryHandle {
  readonly threadId: string;
}

export interface HostInteractionResolution {
  readonly kind: string;
  readonly action: string;
  readonly feedback?: string;
  readonly value?: unknown;
}

/**
 * Session-owned host interaction surface.
 *
 * Runtime code asks the session for an interaction; host code owns display,
 * replay (via `ApprovalRequestHandler`), and first-wins resolution.
 */
export interface HostInteractions {
  requestToolEditApproval?(
    request: ToolEditApprovalRequest,
    options?: HostInteractionOptions,
  ): Promise<ToolEditApprovalResult> | undefined;
  requestBashApproval?(
    request: HostBashApprovalRequest,
    options?: HostInteractionOptions,
  ): Promise<HostBashApprovalResult> | undefined;
  requestPlanApproval?(
    request: HostPlanApprovalRequest,
    options?: HostInteractionOptions,
  ): Promise<PlanApprovalResult> | undefined;
  requestAgentProposal?(
    request: HostAgentProposalRequest,
    options?: HostInteractionOptions,
  ): Promise<ProposalResult> | undefined;
  requestRetry?(
    request: HostRetryRequest,
    options?: HostInteractionOptions,
  ): Promise<RetryResult> | undefined;
  askUserQuestion?(
    request: HostUserQuestionRequest,
    options?: HostInteractionOptions,
  ): Promise<HostUserQuestionResult> | undefined;
  openExternalInquiry?(
    request: HostExternalInquiryRequest,
  ): Promise<HostExternalInquiryHandle> | undefined;
  handleProgressEvent<K extends ProgressEvent>(
    event: K,
    payload: ProgressEventPayloads[K],
  ): boolean;
  resolve(requestId: string, result: HostInteractionResolution): boolean;
  cancelForStream(streamId: StreamTabId, cause?: string): void;
  cancelUnscoped?(cause?: string): void;
  cancelAll?(cause?: string): void;
  dispose?(): void;
}

const noopHostInteractions: HostInteractions = {
  handleProgressEvent: () => false,
  resolve: () => false,
  cancelForStream: () => {},
  cancelUnscoped: () => {},
  cancelAll: () => {},
};

/**
 * Stable per-session slot. The `SessionHandle` exposes this object once, while
 * each host installs the concrete implementation for the session lifetime it
 * owns. Keeping the slot stable avoids passing a mutable host callback through
 * every run-construction path during the staged migration.
 */
export class SessionHostInteractions implements HostInteractions {
  private active: HostInteractions = noopHostInteractions;

  use(interactions: HostInteractions): () => void {
    const previous = this.active;
    this.active = interactions;
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (this.active === interactions) this.active = previous;
      interactions.dispose?.();
    };
  }

  handleProgressEvent<K extends ProgressEvent>(
    event: K,
    payload: ProgressEventPayloads[K],
  ): boolean {
    return this.active.handleProgressEvent(event, payload);
  }

  requestToolEditApproval(
    request: ToolEditApprovalRequest,
    options?: HostInteractionOptions,
  ): Promise<ToolEditApprovalResult> | undefined {
    return this.active.requestToolEditApproval?.(request, options);
  }

  requestBashApproval(
    request: HostBashApprovalRequest,
    options?: HostInteractionOptions,
  ): Promise<HostBashApprovalResult> | undefined {
    return this.active.requestBashApproval?.(request, options);
  }

  requestPlanApproval(
    request: HostPlanApprovalRequest,
    options?: HostInteractionOptions,
  ): Promise<PlanApprovalResult> | undefined {
    return this.active.requestPlanApproval?.(request, options);
  }

  requestAgentProposal(
    request: HostAgentProposalRequest,
    options?: HostInteractionOptions,
  ): Promise<ProposalResult> | undefined {
    return this.active.requestAgentProposal?.(request, options);
  }

  requestRetry(
    request: HostRetryRequest,
    options?: HostInteractionOptions,
  ): Promise<RetryResult> | undefined {
    return this.active.requestRetry?.(request, options);
  }

  askUserQuestion(
    request: HostUserQuestionRequest,
    options?: HostInteractionOptions,
  ): Promise<HostUserQuestionResult> | undefined {
    return this.active.askUserQuestion?.(request, options);
  }

  openExternalInquiry(
    request: HostExternalInquiryRequest,
  ): Promise<HostExternalInquiryHandle> | undefined {
    return this.active.openExternalInquiry?.(request);
  }

  resolve(requestId: string, result: HostInteractionResolution): boolean {
    return this.active.resolve(requestId, result);
  }

  cancelForStream(streamId: StreamTabId, cause?: string): void {
    this.active.cancelForStream(streamId, cause);
  }

  cancelUnscoped(cause?: string): void {
    this.active.cancelUnscoped?.(cause);
  }

  cancelAll(cause?: string): void {
    this.active.cancelAll?.(cause);
  }

  dispose(): void {
    this.active.dispose?.();
    this.active = noopHostInteractions;
  }
}
