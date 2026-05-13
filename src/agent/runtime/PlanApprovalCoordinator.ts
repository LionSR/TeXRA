/**
 * Promise-based coordinator for plan approval gates.
 *
 * Flow:
 * 1. PlanTool calls `waitForApproval()` - returns Promise, emits 'showPlanApproval'
 * 2. User approves/rejects → resolves Promise with corresponding action
 * 3. On resolution → emits 'resolvePlanApproval' to dismiss UI
 */

import { getDefaultAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { Plan } from '@shared/schemas';
import {
  BasePromiseCoordinator,
  type CoordinatorConfig,
} from './BasePromiseCoordinator';

// ============================================================================
// Types
// ============================================================================

/** Result of a plan approval request. */
export type PlanApprovalResult =
  | { action: 'approve' }
  | { action: 'reject'; feedback?: string }
  | { action: 'timeout' };

export interface PlanApprovalRequestOptions {
  approvalId: string;
  plan: Plan;
  /** Timeout in milliseconds (default: wait indefinitely) */
  timeoutMs?: number;
}

/** Payload for show event */
interface PlanApprovalShowPayload extends Record<string, unknown> {
  approvalId: string;
  streamId: string;
  plan: Plan;
}

// ============================================================================
// Coordinator Implementation
// ============================================================================

/** Manages pending plan approval requests. */
export class PlanApprovalCoordinator extends BasePromiseCoordinator<
  PlanApprovalResult,
  PlanApprovalShowPayload
> {
  protected readonly config: CoordinatorConfig = {
    showEventName: 'showPlanApproval',
    resolveEventName: 'resolvePlanApproval',
    idFieldName: 'approvalId',
  };

  /** Bidirectional maps for stream ↔ approval ID lookup. */
  private readonly streamApprovalMap = new Map<string, string>();
  private readonly approvalStreamMap = new Map<string, string>();

  protected getDefaultCancelResult(): PlanApprovalResult {
    return { action: 'reject' };
  }

  /** Wait for user action on a plan. */
  waitForApproval(
    streamId: string,
    options: PlanApprovalRequestOptions,
  ): Promise<PlanApprovalResult> {
    const { approvalId, plan, timeoutMs } = options;

    // Track bidirectional mapping for cleanup
    this.streamApprovalMap.set(streamId, approvalId);
    this.approvalStreamMap.set(approvalId, streamId);

    // Request host to show progress view so user sees the approval prompt
    this.runtimeHost.emit('requestEnsureProgressView', {});

    // Activate the stream that needs approval so user sees the prompt immediately
    this.runtimeHost.emit('setActiveStream', { streamId });

    return this.waitForUserAction(
      approvalId,
      { approvalId, streamId, plan },
      { timeoutMs },
    );
  }

  /** Override to clean up stream mapping on normal resolution. */
  override resolveRequest(id: string, result: PlanApprovalResult): boolean {
    const streamId = this.approvalStreamMap.get(id);
    if (streamId) {
      this.streamApprovalMap.delete(streamId);
      this.approvalStreamMap.delete(id);
    }
    return super.resolveRequest(id, result);
  }

  /** Override to clean up stream mapping on external cancellation. */
  override clearRequest(id: string): void {
    const streamId = this.approvalStreamMap.get(id);
    if (streamId) {
      this.streamApprovalMap.delete(streamId);
      this.approvalStreamMap.delete(id);
    }
    super.clearRequest(id);
  }

  /**
   * Clear any pending plan approval for the given stream.
   * Used for cleanup when flows are interrupted or streams are deleted.
   */
  clearForStream(streamId: string): void {
    const approvalId = this.streamApprovalMap.get(streamId);
    if (approvalId) {
      this.clearRequest(approvalId);
    }
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

/** Singleton coordinator instance. */
export const planApprovalCoordinator = new PlanApprovalCoordinator(
  getDefaultAgentRuntimeHost,
);
