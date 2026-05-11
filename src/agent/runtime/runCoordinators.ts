// Local imports - runtime
import {
  proposalCoordinator,
  type ProposalRequestOptions,
  type ProposalResult,
} from './AgentProposalCoordinator';
import {
  planApprovalCoordinator,
  type PlanApprovalRequestOptions,
  type PlanApprovalResult,
} from './PlanApprovalCoordinator';
import {
  retryCoordinator,
  type RetryRequestOptions,
  type RetryResult,
} from './RetryRequestCoordinator';
import { tryUseRunContext, type RunCoordinators } from './RunContext';

const legacyCoordinators: RunCoordinators = {
  plan: planApprovalCoordinator,
  proposal: proposalCoordinator,
  retry: retryCoordinator,
};

/** Return the active run's coordinators, falling back to legacy singletons. */
export function getRunCoordinators(): RunCoordinators {
  return tryUseRunContext()?.coordinators ?? legacyCoordinators;
}

const planApprovals = new Map<string, RunCoordinators>();
const planApprovalStreams = new Map<string, string>();
const planStreams = new Map<string, RunCoordinators>();
const proposals = new Map<string, RunCoordinators>();
const proposalStreams = new Map<string, string>();
const retries = new Map<string, RunCoordinators>();

function clearPlanBridgeForStream(streamId: string): void {
  planStreams.delete(streamId);
  for (const [approvalId, approvalStreamId] of planApprovalStreams) {
    if (approvalStreamId === streamId) {
      planApprovals.delete(approvalId);
      planApprovalStreams.delete(approvalId);
    }
  }
}

export async function waitForPlanApproval(
  streamId: string,
  options: PlanApprovalRequestOptions,
): Promise<PlanApprovalResult> {
  const coordinators = getRunCoordinators();
  planApprovals.set(options.approvalId, coordinators);
  planApprovalStreams.set(options.approvalId, streamId);
  planStreams.set(streamId, coordinators);
  try {
    return await coordinators.plan.waitForApproval(streamId, options);
  } finally {
    planApprovals.delete(options.approvalId);
    planApprovalStreams.delete(options.approvalId);
    planStreams.delete(streamId);
  }
}

export function resolvePlanApproval(
  approvalId: string,
  result: PlanApprovalResult,
): boolean {
  return (
    planApprovals.get(approvalId)?.plan ?? legacyCoordinators.plan
  ).resolveRequest(approvalId, result);
}

export function clearPlanApprovalForStream(streamId: string): void {
  (planStreams.get(streamId)?.plan ?? legacyCoordinators.plan).clearForStream(
    streamId,
  );
  clearPlanBridgeForStream(streamId);
}

export function clearAllPlanApprovals(): void {
  const coordinators = new Set(planStreams.values());
  coordinators.add(legacyCoordinators);
  for (const coordinator of coordinators) {
    coordinator.plan.clearAll();
  }
  planApprovals.clear();
  planApprovalStreams.clear();
  planStreams.clear();
}

export async function waitForProposal(
  streamId: string,
  options: ProposalRequestOptions,
): Promise<ProposalResult> {
  const coordinators = getRunCoordinators();
  proposals.set(options.proposalId, coordinators);
  proposalStreams.set(options.proposalId, streamId);
  try {
    return await coordinators.proposal.waitForProposal(streamId, options);
  } finally {
    proposals.delete(options.proposalId);
    proposalStreams.delete(options.proposalId);
  }
}

export function resolveProposal(
  proposalId: string,
  result: ProposalResult,
): boolean {
  return (
    proposals.get(proposalId)?.proposal ?? legacyCoordinators.proposal
  ).resolveRequest(proposalId, result);
}

export function clearProposalForStream(streamId: string): void {
  for (const [proposalId, proposalStreamId] of proposalStreams) {
    if (proposalStreamId !== streamId) continue;
    (
      proposals.get(proposalId)?.proposal ?? legacyCoordinators.proposal
    ).clearRequest(proposalId);
    proposals.delete(proposalId);
    proposalStreams.delete(proposalId);
  }
}

export function clearAllProposals(): void {
  for (const [proposalId, coordinators] of proposals) {
    coordinators.proposal.clearRequest(proposalId);
  }
  proposals.clear();
  proposalStreams.clear();
}

export async function waitForRetry(
  streamId: string,
  options: RetryRequestOptions,
): Promise<RetryResult> {
  const coordinators = getRunCoordinators();
  retries.set(streamId, coordinators);
  try {
    return await coordinators.retry.waitForRetry(streamId, options);
  } finally {
    retries.delete(streamId);
  }
}

export function triggerRetry(streamId: string, feedback?: string): boolean {
  return (
    retries.get(streamId)?.retry ?? legacyCoordinators.retry
  ).triggerRetry(streamId, feedback);
}

export function cancelRetry(streamId: string): boolean {
  return (retries.get(streamId)?.retry ?? legacyCoordinators.retry).cancelRetry(
    streamId,
  );
}

export function clearRetryRequest(streamId: string): void {
  (retries.get(streamId)?.retry ?? legacyCoordinators.retry).clearRequest(
    streamId,
  );
  retries.delete(streamId);
}

export function clearAllRetryRequests(): void {
  for (const [streamId, coordinators] of retries) {
    coordinators.retry.clearRequest(streamId);
  }
  retries.clear();
}
