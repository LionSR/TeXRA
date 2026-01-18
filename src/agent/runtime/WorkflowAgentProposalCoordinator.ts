/**
 * Promise-based coordinator for workflow agent proposals.
 *
 * Flow:
 * 1. Tool calls `waitForUserAction()` - returns Promise, emits 'showAgentProposal'
 * 2. User approves/rejects/sets up → resolves Promise with corresponding action
 * 3. On resolution → emits 'resolveAgentProposal' to dismiss UI
 */

// Local imports
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import { bus } from '@eventBus/ProgressEventBus';
import type { AgentProposal } from '@eventBus/types';

/** Result of an agent proposal (workflow or tool-use). */
export type ProposalResult =
  | { action: 'approve' }
  | { action: 'reject'; feedback?: string }
  | { action: 'setup' }
  | { action: 'timeout' };

export interface ProposalRequestOptions {
  proposalId: string;
  proposal: AgentProposal;
  /** Timeout in milliseconds (default: wait indefinitely) */
  timeoutMs?: number;
}

/** Internal state: pending (waiting for user) or resolved (done). */
type ProposalRequestState =
  | {
      status: 'pending';
      resolve: (result: ProposalResult) => void;
      timeoutId?: NodeJS.Timeout;
      proposalId: string;
    }
  | { status: 'resolved' };

/** Manages pending workflow agent proposals (singleton). */
class WorkflowAgentProposalCoordinatorImpl {
  private readonly proposals = new Map<string, ProposalRequestState>();

  /** Wait for user action on a proposal. Resolves when user approves, rejects, or timeout. */
  waitForUserAction(
    streamId: string,
    options: ProposalRequestOptions,
  ): Promise<ProposalResult> {
    const { proposalId, proposal, timeoutMs } = options;

    // Cancel any existing pending proposal for this ID
    const existing = this.proposals.get(proposalId);
    if (existing?.status === 'pending') {
      clearTimeout(existing.timeoutId);
      existing.resolve({ action: 'reject' });
    }

    return new Promise<ProposalResult>((resolve) => {
      const timeoutId =
        timeoutMs && timeoutMs > 0
          ? setTimeout(() => {
              const req = this.proposals.get(proposalId);
              if (req?.status === 'pending' && req.resolve === resolve) {
                this.resolveProposal(proposalId, { action: 'timeout' });
              }
            }, timeoutMs)
          : undefined;

      this.proposals.set(proposalId, {
        status: 'pending',
        resolve,
        timeoutId,
        proposalId,
      });

      void safeExecuteCommand('texra.showProgressView');
      bus.emit('showAgentProposal', {
        proposalId,
        streamId,
        ...proposal,
      });
    });
  }

  /** Approve a proposal. Returns true if approved, false if no pending proposal. */
  approveProposal(proposalId: string): boolean {
    if (!this.getPendingProposal(proposalId)) return false;
    this.resolveProposal(proposalId, { action: 'approve' });
    return true;
  }

  /** Reject a proposal with optional feedback. Returns true if rejected. */
  rejectProposal(proposalId: string, feedback?: string): boolean {
    if (!this.getPendingProposal(proposalId)) return false;
    this.resolveProposal(proposalId, { action: 'reject', feedback });
    return true;
  }

  /** Open proposal in main view for editing. Returns true if initiated. */
  setupProposal(proposalId: string): boolean {
    if (!this.getPendingProposal(proposalId)) return false;
    this.resolveProposal(proposalId, { action: 'setup' });
    return true;
  }

  hasPendingProposal(proposalId: string): boolean {
    return this.getPendingProposal(proposalId) !== null;
  }

  /** Clear a pending proposal. Used for cleanup when flow is cancelled externally. */
  clearProposal(proposalId: string): void {
    const req = this.getPendingProposal(proposalId);
    if (!req) return;

    clearTimeout(req.timeoutId);
    req.resolve({ action: 'reject' }); // Avoid hanging Promise
    this.cleanup(proposalId);
  }

  private getPendingProposal(
    proposalId: string,
  ): (ProposalRequestState & { status: 'pending' }) | null {
    const req = this.proposals.get(proposalId);
    return req?.status === 'pending' ? req : null;
  }

  private resolveProposal(proposalId: string, result: ProposalResult): void {
    const req = this.getPendingProposal(proposalId);
    if (!req) return;

    clearTimeout(req.timeoutId);
    req.resolve(result);
    this.cleanup(proposalId);
  }

  private cleanup(proposalId: string): void {
    this.proposals.set(proposalId, { status: 'resolved' });
    bus.emit('resolveAgentProposal', { proposalId });

    // Defer deletion to avoid blocking current execution
    setImmediate(() => {
      if (this.proposals.get(proposalId)?.status === 'resolved') {
        this.proposals.delete(proposalId);
      }
    });
  }
}

/** Singleton coordinator instance. */
export const proposalCoordinator = new WorkflowAgentProposalCoordinatorImpl();
