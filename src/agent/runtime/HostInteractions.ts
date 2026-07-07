import type {
  ProgressEvent,
  ProgressEventPayloads,
} from '@agent/runtime/hostProgressEvents';
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

export interface HostInteractionOptions {
  readonly timeoutMs?: number;
}

export type PlanApprovalResult =
  | { action: 'approve' }
  | { action: 'approve_and_goal' }
  | { action: 'reject'; feedback?: string }
  | { action: 'timeout' };

export type ProposalResult =
  | { action: 'approve'; model?: string; agent?: string }
  | { action: 'reject'; feedback?: string }
  | { action: 'setup' }
  | { action: 'timeout' };

export type RetryResult =
  | { action: 'retry'; feedback?: string }
  | { action: 'cancel' }
  | { action: 'timeout' }
  // Policy/headless auto-denial: the retry could not be approved because no
  // human input was available (e.g. `--approval-policy never --no-input`).
  // Distinct from a user `cancel` so retry-exhaustion with no human lands in
  // the `failed` fallback (→ RUN_OUTCOME.FAILED) instead of `cancelled`. See #7331.
  | { action: 'deny'; reason?: string };

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
  /**
   * Set when `accepted: false` came from the host-side interaction timeout
   * rather than an explicit user rejection — mirrors the distinct
   * `{ action: 'timeout' }` shape `PlanApprovalResult`/`ProposalResult`/
   * `RetryResult` already use (see #7327), kept as a flag here since
   * restructuring this result to a discriminated union isn't worth it for a
   * single boolean. Consumers must not report a timeout as a user rejection.
   */
  readonly timedOut?: boolean;
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

export type PendingInteractionKind =
  | 'toolEdit'
  | 'bash'
  | 'plan'
  | 'proposal'
  | 'retry'
  | 'userQuestion'
  | 'externalInquiry';

/**
 * Selector for {@link HostInteractions.cancel}.
 *
 * - `{}` — cancel every pending request.
 * - `{ kind }` — cancel every pending request of that kind.
 * - `{ streamId }` — cancel every pending request on that stream.
 * - `{ streamId, kind }` — cancel that kind on that stream.
 * - `streamId: null` — cancel only requests with no concrete stream
 *   (the streamless/unscoped sweep).
 */
export interface HostInteractionCancelSelector {
  readonly streamId?: StreamTabId | null;
  readonly kind?: PendingInteractionKind;
  readonly cause?: string;
}

/** Shared selector predicate for the ports' pending registries. */
export function matchesCancelSelector(
  pending: {
    readonly kind: PendingInteractionKind;
    readonly streamId?: StreamTabId;
  },
  selector: HostInteractionCancelSelector,
): boolean {
  if (selector.kind !== undefined && pending.kind !== selector.kind) {
    return false;
  }
  if (selector.streamId === undefined) return true;
  if (selector.streamId === null) return !pending.streamId;
  return pending.streamId === selector.streamId;
}

/**
 * Session-owned host interaction surface.
 *
 * Runtime code asks the session for an interaction; host code owns display,
 * replay (via `ApprovalRequestHandler`), request bookkeeping (the pending
 * id→stream registry each implementation keeps), first-wins resolution, and
 * replacement cancellation for duplicate request ids.
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
  /** Settle pending requests matching the selector with their reject/cancel defaults. */
  cancel(selector?: HostInteractionCancelSelector): void;
  dispose?(): void;
}

const noopHostInteractions: HostInteractions = {
  handleProgressEvent: () => false,
  resolve: () => false,
  cancel: () => {},
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

  cancel(selector?: HostInteractionCancelSelector): void {
    this.active.cancel(selector);
  }

  dispose(): void {
    this.active.dispose?.();
    this.active = noopHostInteractions;
  }
}
