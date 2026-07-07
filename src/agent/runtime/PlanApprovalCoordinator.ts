/**
 * Session-scoped coordinator for plan approval gates.
 */

import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { Plan } from '@shared/schemas';

export type PlanApprovalResult =
  | { action: 'approve' }
  | { action: 'approve_and_goal' }
  | { action: 'reject'; feedback?: string }
  | { action: 'timeout' };

export interface PlanApprovalRequestOptions {
  approvalId: string;
  plan: Plan;
  /** Whether the goal feature flag is enabled — gates the extra button. */
  goalEnabled?: boolean;
  /** Timeout in milliseconds (default: wait indefinitely). */
  timeoutMs?: number;
}

type RuntimeHostProvider = () => AgentRuntimeHost;
type CoordinatorRuntimeHost = AgentRuntimeHost | RuntimeHostProvider;

function toRuntimeHostProvider(
  runtimeHost: CoordinatorRuntimeHost,
): RuntimeHostProvider {
  return typeof runtimeHost === 'function' ? runtimeHost : () => runtimeHost;
}

export class PlanApprovalCoordinator {
  private readonly getRuntimeHost: RuntimeHostProvider;

  /** Bidirectional maps for stream ↔ approval ID lookup. */
  private readonly streamApprovalMap = new Map<string, string>();
  private readonly approvalStreamMap = new Map<string, string>();

  constructor(runtimeHost: CoordinatorRuntimeHost) {
    this.getRuntimeHost = toRuntimeHostProvider(runtimeHost);
  }

  private get runtimeHost(): AgentRuntimeHost {
    return this.getRuntimeHost();
  }

  waitForApproval(
    streamId: string,
    options: PlanApprovalRequestOptions,
  ): Promise<PlanApprovalResult> {
    const { approvalId, plan, goalEnabled = false, timeoutMs } = options;

    if (this.approvalStreamMap.has(approvalId)) {
      this.rejectRequest(approvalId);
    }
    this.streamApprovalMap.set(streamId, approvalId);
    this.approvalStreamMap.set(approvalId, streamId);

    this.runtimeHost.emit('requestEnsureProgressView', {});
    this.runtimeHost.emit('setActiveStream', { streamId });

    const interaction = this.runtimeHost.interactions?.requestPlanApproval?.(
      { approvalId, streamId, plan, goalEnabled },
      { timeoutMs },
    );
    if (!interaction) {
      this.dropMappingByApprovalId(approvalId);
      throw new Error('HostInteractions.requestPlanApproval is required');
    }

    return interaction.finally(() => this.dropMappingByApprovalId(approvalId));
  }

  private dropMappingByApprovalId(approvalId: string): void {
    const streamId = this.approvalStreamMap.get(approvalId);
    if (!streamId) return;
    this.streamApprovalMap.delete(streamId);
    this.approvalStreamMap.delete(approvalId);
  }

  clearRequest(approvalId: string): void {
    this.rejectRequest(approvalId);
  }

  private rejectRequest(approvalId: string): void {
    const streamId = this.approvalStreamMap.get(approvalId);
    this.dropMappingByApprovalId(approvalId);
    if (streamId) {
      const resolved =
        this.runtimeHost.interactions?.resolve(approvalId, {
          kind: 'plan',
          action: 'reject',
        }) ?? false;
      if (!resolved) {
        this.runtimeHost.interactions?.cancelForStream(
          streamId,
          'Plan approval cleared.',
        );
      }
    }
  }

  /** Clear any pending plan approval for the given stream. */
  clearForStream(streamId: string): void {
    const approvalId = this.streamApprovalMap.get(streamId);
    if (approvalId) this.clearRequest(approvalId);
  }

  clearAll(): void {
    const approvalIds = [...this.approvalStreamMap.keys()];
    for (const approvalId of approvalIds) {
      this.clearRequest(approvalId);
    }
  }
}
