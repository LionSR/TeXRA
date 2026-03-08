/**
 * Promise-based coordinator for plan approval gates.
 *
 * Flow:
 * 1. PlanTool calls `waitForApproval()` - returns Promise, emits 'showPlanApproval'
 * 2. User approves/rejects → resolves Promise with corresponding action
 * 3. On resolution → emits 'resolvePlanApproval' to dismiss UI
 */

// Local imports
import { bus } from '@eventBus/ProgressEventBus';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
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
class PlanApprovalCoordinatorImpl extends BasePromiseCoordinator<
  PlanApprovalResult,
  PlanApprovalShowPayload
> {
  protected readonly config: CoordinatorConfig = {
    showEventName: 'showPlanApproval',
    resolveEventName: 'resolvePlanApproval',
    idFieldName: 'approvalId',
  };

  protected getDefaultCancelResult(): PlanApprovalResult {
    return { action: 'reject' };
  }

  /** Wait for user action on a plan. */
  waitForApproval(
    streamId: string,
    options: PlanApprovalRequestOptions,
  ): Promise<PlanApprovalResult> {
    const { approvalId, plan, timeoutMs } = options;

    // Show progress view to ensure user sees the approval prompt
    void safeExecuteCommand('texra.showProgressView');

    // Activate the stream that needs approval so user sees the prompt immediately
    if (streamId) {
      bus.emit('setActiveStream', { streamId });
    }

    return this.waitForUserAction(
      approvalId,
      { approvalId, streamId, plan },
      { timeoutMs },
    );
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

/** Singleton coordinator instance. */
export const planApprovalCoordinator = new PlanApprovalCoordinatorImpl();
