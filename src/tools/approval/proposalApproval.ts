import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { StreamTabId } from '@shared/schemas';

/** Owns per-stream bypass state for agent delegation proposals. */
export class ProposalApprovalState {
  private readonly bypassedByStream = new Map<StreamTabId, boolean>();

  /** Toggle per-stream proposal bypass. Returns new state. */
  toggleBypass(streamId: StreamTabId, runtimeHost: AgentRuntimeHost): boolean {
    const next = !this.isBypassed(streamId);
    this.bypassedByStream.set(streamId, next);
    this.notifyBypassState(streamId, runtimeHost);
    return next;
  }

  /** Check if proposals are bypassed for a specific stream. */
  isBypassed(streamId: StreamTabId): boolean {
    return this.bypassedByStream.get(streamId) ?? false;
  }

  clearForStream(streamId: StreamTabId): void {
    this.bypassedByStream.delete(streamId);
  }

  clearAll(): void {
    this.bypassedByStream.clear();
  }

  private notifyBypassState(
    streamId: StreamTabId,
    runtimeHost: AgentRuntimeHost,
  ): void {
    runtimeHost.emit('updateSuperYoloBypassState', {
      streamId,
      bypassActive: this.isBypassed(streamId),
    });
  }
}

export const proposalApprovalState = new ProposalApprovalState();
