import {
  tryUseRunContext,
  useRunContext,
  type RunCoordinators,
} from './RunContext';
import type {
  ProposalRequestOptions,
  ProposalResult,
} from './AgentProposalCoordinator';
import type {
  PlanApprovalRequestOptions,
  PlanApprovalResult,
} from './PlanApprovalCoordinator';
import type {
  RetryRequestOptions,
  RetryResult,
} from './RetryRequestCoordinator';

function useRunCoordinators(): RunCoordinators {
  const coordinators = useRunContext().coordinators;
  if (!coordinators) {
    throw new Error('run coordinator request requires active run coordinators');
  }
  return coordinators;
}

/**
 * Bridge host/UI decisions back to the run coordinators that created each
 * pending request.
 *
 * Tool calls create requests inside an active RunContext. Host callbacks resolve
 * those requests later by id, often outside that async scope, so the bridge owns
 * the process-wide request id index while each entry still points at a concrete
 * AgentLaunchContext's coordinators.
 */
export class RunCoordinatorBridge {
  private readonly runStreams = new Map<string, RunCoordinators>();
  private readonly planApprovals = new Map<string, RunCoordinators>();
  private readonly planApprovalStreams = new Map<string, string>();
  private readonly planStreams = new Map<string, RunCoordinators>();
  private readonly proposals = new Map<string, RunCoordinators>();
  private readonly proposalStreams = new Map<string, string>();
  private readonly retries = new Map<string, RunCoordinators>();
  private readonly retryCoordinatorRefs = new Map<RunCoordinators, number>();

  retainForStream(streamId: string, coordinators: RunCoordinators): () => void {
    this.runStreams.set(streamId, coordinators);
    return () => {
      if (this.runStreams.get(streamId) === coordinators) {
        this.runStreams.delete(streamId);
      }
    };
  }

  async waitForPlanApproval(
    streamId: string,
    options: PlanApprovalRequestOptions,
  ): Promise<PlanApprovalResult> {
    const coordinators = useRunCoordinators();
    this.planApprovals.set(options.approvalId, coordinators);
    this.planApprovalStreams.set(options.approvalId, streamId);
    this.planStreams.set(streamId, coordinators);
    try {
      return await coordinators.plan.waitForApproval(streamId, options);
    } finally {
      this.planApprovals.delete(options.approvalId);
      this.planApprovalStreams.delete(options.approvalId);
      this.planStreams.delete(streamId);
    }
  }

  resolvePlanApproval(approvalId: string, result: PlanApprovalResult): boolean {
    return (
      this.planApprovals
        .get(approvalId)
        ?.plan.resolveRequest(approvalId, result) ?? false
    );
  }

  clearPlanApprovalForStream(streamId: string): void {
    (
      this.planStreams.get(streamId)?.plan ??
      this.runStreams.get(streamId)?.plan ??
      tryUseRunContext()?.coordinators?.plan
    )?.clearForStream(streamId);
    this.clearPlanBridgeForStream(streamId);
  }

  async waitForProposal(
    streamId: string,
    options: ProposalRequestOptions,
  ): Promise<ProposalResult> {
    const coordinators = useRunCoordinators();
    this.proposals.set(options.proposalId, coordinators);
    this.proposalStreams.set(options.proposalId, streamId);
    try {
      return await coordinators.proposal.waitForProposal(streamId, options);
    } finally {
      this.proposals.delete(options.proposalId);
      this.proposalStreams.delete(options.proposalId);
    }
  }

  resolveProposal(proposalId: string, result: ProposalResult): boolean {
    return (
      this.proposals
        .get(proposalId)
        ?.proposal.resolveRequest(proposalId, result) ?? false
    );
  }

  async waitForRetry(
    streamId: string,
    options: RetryRequestOptions,
  ): Promise<RetryResult> {
    const coordinators = useRunCoordinators();
    this.retainRetryCoordinator(coordinators);
    this.retries.set(streamId, coordinators);
    try {
      return await coordinators.retry.waitForRetry(streamId, options);
    } finally {
      this.retries.delete(streamId);
      this.releaseRetryCoordinator(coordinators);
    }
  }

  triggerRetry(streamId: string, feedback?: string): boolean {
    return (
      this.retries.get(streamId)?.retry.triggerRetry(streamId, feedback) ??
      false
    );
  }

  cancelRetry(streamId: string): boolean {
    return this.retries.get(streamId)?.retry.cancelRetry(streamId) ?? false;
  }

  clearRetryRequest(streamId: string): void {
    const coordinators = new Set<RunCoordinators>();
    const mappedCoordinators = this.retries.get(streamId);
    if (mappedCoordinators) coordinators.add(mappedCoordinators);
    const runCoordinators = this.runStreams.get(streamId);
    if (runCoordinators) coordinators.add(runCoordinators);
    const ambient = tryUseRunContext()?.coordinators;
    if (ambient) coordinators.add(ambient);
    for (const coordinator of coordinators) {
      coordinator.retry.clearRequest(streamId);
    }
    this.retries.delete(streamId);
  }

  cleanupRequestsForStream(streamId: string): void {
    this.clearPlanApprovalForStream(streamId);
    this.clearProposalForStream(streamId);
    this.clearRetryRequest(streamId);
  }

  cleanupAllRequests(): void {
    this.clearAllPlanApprovals();
    this.clearAllProposals();
    this.clearAllRetryRequests();
  }

  private retainRetryCoordinator(coordinators: RunCoordinators): void {
    this.retryCoordinatorRefs.set(
      coordinators,
      (this.retryCoordinatorRefs.get(coordinators) ?? 0) + 1,
    );
  }

  private releaseRetryCoordinator(coordinators: RunCoordinators): void {
    const nextCount = (this.retryCoordinatorRefs.get(coordinators) ?? 0) - 1;
    if (nextCount > 0) {
      this.retryCoordinatorRefs.set(coordinators, nextCount);
    } else {
      this.retryCoordinatorRefs.delete(coordinators);
    }
  }

  private clearPlanBridgeForStream(streamId: string): void {
    this.planStreams.delete(streamId);
    const approvalIds = [...this.planApprovalStreams.entries()]
      .filter(([, approvalStreamId]) => approvalStreamId === streamId)
      .map(([approvalId]) => approvalId);
    for (const approvalId of approvalIds) {
      this.planApprovals.delete(approvalId);
      this.planApprovalStreams.delete(approvalId);
    }
  }

  private clearAllPlanApprovals(): void {
    const coordinators = new Set(this.planStreams.values());
    for (const runCoordinators of this.runStreams.values()) {
      coordinators.add(runCoordinators);
    }
    for (const coordinator of coordinators) {
      coordinator.plan.clearAll();
    }
    this.planApprovals.clear();
    this.planApprovalStreams.clear();
    this.planStreams.clear();
  }

  private clearProposalForStream(streamId: string): void {
    const proposalIds = [...this.proposalStreams.entries()]
      .filter(([, proposalStreamId]) => proposalStreamId === streamId)
      .map(([proposalId]) => proposalId);
    for (const proposalId of proposalIds) {
      this.proposals.get(proposalId)?.proposal.clearRequest(proposalId);
      this.proposals.delete(proposalId);
      this.proposalStreams.delete(proposalId);
    }
  }

  private clearAllProposals(): void {
    const coordinators = new Set(this.proposals.values());
    for (const coordinator of coordinators) {
      coordinator.proposal.clearAll();
    }
    this.proposals.clear();
    this.proposalStreams.clear();
  }

  private clearAllRetryRequests(): void {
    const coordinators = new Set(this.retryCoordinatorRefs.keys());
    for (const runCoordinators of this.runStreams.values()) {
      coordinators.add(runCoordinators);
    }
    for (const runCoordinators of this.retries.values()) {
      coordinators.add(runCoordinators);
    }
    for (const coordinator of coordinators) {
      coordinator.retry.clearAll();
    }
    this.retryCoordinatorRefs.clear();
    this.retries.clear();
  }
}

export const runCoordinatorBridge = new RunCoordinatorBridge();
