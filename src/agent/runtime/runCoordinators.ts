import { useRunContext, type RunCoordinators } from './RunContext';
import {
  SharedExecutionRegistry,
  type ExecutionRegistry,
} from './executionRegistry';
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
  private readonly planApprovals = new Map<string, CoordinatorRequest>();
  private readonly proposals = new Map<string, CoordinatorRequest>();
  private readonly retries = new Map<string, RunCoordinators>();

  constructor(
    private readonly registry: Pick<
      ExecutionRegistry,
      'getAgentHandleByStream' | 'getAgentHandles'
    > = SharedExecutionRegistry,
  ) {}

  async waitForPlanApproval(
    streamId: string,
    options: PlanApprovalRequestOptions,
  ): Promise<PlanApprovalResult> {
    const coordinators = useRunCoordinators();
    this.planApprovals.set(options.approvalId, { streamId, coordinators });
    try {
      return await coordinators.plan.waitForApproval(streamId, options);
    } finally {
      this.planApprovals.delete(options.approvalId);
    }
  }

  clearPlanApprovalForStream(streamId: string): void {
    const entries = matchingRequests(this.planApprovals, streamId);
    for (const [approvalId, entry] of entries) {
      entry.coordinators.plan.clearRequest(approvalId);
      this.planApprovals.delete(approvalId);
    }
    if (entries.length === 0) {
      this.coordinatorsForStream(streamId)?.plan.clearForStream(streamId);
    }
  }

  async waitForProposal(
    streamId: string,
    options: ProposalRequestOptions,
  ): Promise<ProposalResult> {
    const coordinators = useRunCoordinators();
    this.proposals.set(options.proposalId, { streamId, coordinators });
    try {
      return await coordinators.proposal.waitForProposal(streamId, options);
    } finally {
      this.proposals.delete(options.proposalId);
    }
  }

  async waitForRetry(
    streamId: string,
    options: RetryRequestOptions,
  ): Promise<RetryResult> {
    const coordinators = useRunCoordinators();
    this.retries.set(streamId, coordinators);
    try {
      return await coordinators.retry.waitForRetry(streamId, options);
    } finally {
      if (this.retries.get(streamId) === coordinators) {
        this.retries.delete(streamId);
      }
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
    const runCoordinators = this.coordinatorsForStream(streamId);
    if (runCoordinators) coordinators.add(runCoordinators);
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

  private clearAllPlanApprovals(): void {
    const coordinators = new Set(
      [...this.planApprovals.values()].map((entry) => entry.coordinators),
    );
    for (const runCoordinators of this.activeCoordinators()) {
      coordinators.add(runCoordinators);
    }
    for (const coordinator of coordinators) {
      coordinator.plan.clearAll();
    }
    this.planApprovals.clear();
  }

  private clearProposalForStream(streamId: string): void {
    for (const [proposalId, entry] of matchingRequests(
      this.proposals,
      streamId,
    )) {
      entry.coordinators.proposal.clearRequest(proposalId);
      this.proposals.delete(proposalId);
    }
  }

  private clearAllProposals(): void {
    const coordinators = new Set(
      [...this.proposals.values()].map((entry) => entry.coordinators),
    );
    for (const coordinator of coordinators) {
      coordinator.proposal.clearAll();
    }
    this.proposals.clear();
  }

  private clearAllRetryRequests(): void {
    const coordinators = new Set<RunCoordinators>();
    for (const runCoordinators of this.activeCoordinators()) {
      coordinators.add(runCoordinators);
    }
    for (const runCoordinators of this.retries.values()) {
      coordinators.add(runCoordinators);
    }
    for (const coordinator of coordinators) {
      coordinator.retry.clearAll();
    }
    this.retries.clear();
  }

  private coordinatorsForStream(streamId: string): RunCoordinators | undefined {
    return this.registry.getAgentHandleByStream(streamId)?.coordinators;
  }

  private activeCoordinators(): RunCoordinators[] {
    return this.registry
      .getAgentHandles()
      .flatMap((handle) => (handle.coordinators ? [handle.coordinators] : []));
  }
}

interface CoordinatorRequest {
  readonly streamId: string;
  readonly coordinators: RunCoordinators;
}

function matchingRequests(
  requests: ReadonlyMap<string, CoordinatorRequest>,
  streamId: string,
): [string, CoordinatorRequest][] {
  return [...requests.entries()].filter(
    ([, entry]) => entry.streamId === streamId,
  );
}

export const SharedRunCoordinatorBridge = new RunCoordinatorBridge();
