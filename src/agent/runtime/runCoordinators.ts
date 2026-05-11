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
function getRunCoordinators(): RunCoordinators {
  return tryUseRunContext()?.coordinators ?? legacyCoordinators;
}

const planApprovals = new Map<string, RunCoordinators>();
const planApprovalStreams = new Map<string, string>();
const planStreams = new Map<string, RunCoordinators>();
const proposals = new Map<string, RunCoordinators>();
const proposalStreams = new Map<string, string>();
const retries = new Map<string, RunCoordinators>();
const retryCoordinators = new Set<RunCoordinators>();

function clearPlanBridgeForStream(streamId: string): void {
  planStreams.delete(streamId);
  const approvalIds = [...planApprovalStreams.entries()]
    .filter(([, approvalStreamId]) => approvalStreamId === streamId)
    .map(([approvalId]) => approvalId);
  for (const approvalId of approvalIds) {
    planApprovals.delete(approvalId);
    planApprovalStreams.delete(approvalId);
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
  const proposalIds = [...proposalStreams.entries()]
    .filter(([, proposalStreamId]) => proposalStreamId === streamId)
    .map(([proposalId]) => proposalId);
  for (const proposalId of proposalIds) {
    (
      proposals.get(proposalId)?.proposal ?? legacyCoordinators.proposal
    ).clearRequest(proposalId);
    proposals.delete(proposalId);
    proposalStreams.delete(proposalId);
  }
}

export function clearAllProposals(): void {
  const coordinators = new Set(proposals.values());
  coordinators.add(legacyCoordinators);
  for (const coordinator of coordinators) {
    coordinator.proposal.clearAll();
  }
  proposals.clear();
  proposalStreams.clear();
}

export async function waitForRetry(
  streamId: string,
  options: RetryRequestOptions,
): Promise<RetryResult> {
  const coordinators = getRunCoordinators();
  retryCoordinators.add(coordinators);
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
  const coordinators = new Set(retryCoordinators);
  const mappedCoordinators = retries.get(streamId);
  if (mappedCoordinators) coordinators.add(mappedCoordinators);
  coordinators.add(legacyCoordinators);
  for (const coordinator of coordinators) {
    coordinator.retry.clearRequest(streamId);
  }
  retries.delete(streamId);
}

export function clearAllRetryRequests(): void {
  const coordinators = new Set(retryCoordinators);
  for (const retryCoordinator of retries.values()) {
    coordinators.add(retryCoordinator);
  }
  coordinators.add(legacyCoordinators);
  for (const coordinator of coordinators) {
    coordinator.retry.clearAll();
  }
  retryCoordinators.clear();
  retries.clear();
}
