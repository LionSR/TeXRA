/**
 * Promise-based coordinator for plan approval gates.
 *
 * 1. PlanTool calls `waitForApproval()` → returns Promise, emits 'showPlanApproval'.
 * 2. User approves/rejects → resolves Promise with the corresponding action.
 * 3. On resolution → emits 'resolvePlanApproval' to dismiss UI.
 */

import { getDefaultAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { Plan } from '@shared/schemas';
import {
  BasePromiseCoordinator,
  type CoordinatorConfig,
} from './BasePromiseCoordinator';

export type PlanApprovalResult =
  | { action: 'approve' }
  | { action: 'reject'; feedback?: string }
  | { action: 'timeout' };

export interface PlanApprovalRequestOptions {
  approvalId: string;
  plan: Plan;
  /** Timeout in milliseconds (default: wait indefinitely). */
  timeoutMs?: number;
}

interface PlanApprovalShowPayload extends Record<string, unknown> {
  approvalId: string;
  streamId: string;
  plan: Plan;
}

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

  waitForApproval(
    streamId: string,
    options: PlanApprovalRequestOptions,
  ): Promise<PlanApprovalResult> {
    const { approvalId, plan, timeoutMs } = options;

    this.streamApprovalMap.set(streamId, approvalId);
    this.approvalStreamMap.set(approvalId, streamId);

    this.runtimeHost.emit('requestEnsureProgressView', {});
    this.runtimeHost.emit('setActiveStream', { streamId });

    return this.waitForUserAction(
      approvalId,
      { approvalId, streamId, plan },
      { timeoutMs },
    );
  }

  private dropMappingByApprovalId(approvalId: string): void {
    const streamId = this.approvalStreamMap.get(approvalId);
    if (!streamId) return;
    this.streamApprovalMap.delete(streamId);
    this.approvalStreamMap.delete(approvalId);
  }

  override resolveRequest(id: string, result: PlanApprovalResult): boolean {
    this.dropMappingByApprovalId(id);
    return super.resolveRequest(id, result);
  }

  override clearRequest(id: string): void {
    this.dropMappingByApprovalId(id);
    super.clearRequest(id);
  }

  /** Clear any pending plan approval for the given stream. */
  clearForStream(streamId: string): void {
    const approvalId = this.streamApprovalMap.get(streamId);
    if (approvalId) this.clearRequest(approvalId);
  }
}

export const planApprovalCoordinator = new PlanApprovalCoordinator(
  getDefaultAgentRuntimeHost,
);
