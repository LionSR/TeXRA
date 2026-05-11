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

const bridgeState = {
  planApprovals: new Map<string, RunCoordinators>(),
  planApprovalStreams: new Map<string, string>(),
  planStreams: new Map<string, RunCoordinators>(),
  proposals: new Map<string, RunCoordinators>(),
  proposalStreams: new Map<string, string>(),
  retries: new Map<string, RunCoordinators>(),
  retryCoordinatorRefs: new Map<RunCoordinators, number>(),
};

function retainRetryCoordinator(coordinators: RunCoordinators): void {
  bridgeState.retryCoordinatorRefs.set(
    coordinators,
    (bridgeState.retryCoordinatorRefs.get(coordinators) ?? 0) + 1,
  );
}

function releaseRetryCoordinator(coordinators: RunCoordinators): void {
  const nextCount =
    (bridgeState.retryCoordinatorRefs.get(coordinators) ?? 0) - 1;
  if (nextCount > 0) {
    bridgeState.retryCoordinatorRefs.set(coordinators, nextCount);
  } else {
    bridgeState.retryCoordinatorRefs.delete(coordinators);
  }
}

function clearPlanBridgeForStream(streamId: string): void {
  bridgeState.planStreams.delete(streamId);
  const approvalIds = [...bridgeState.planApprovalStreams.entries()]
    .filter(([, approvalStreamId]) => approvalStreamId === streamId)
    .map(([approvalId]) => approvalId);
  for (const approvalId of approvalIds) {
    bridgeState.planApprovals.delete(approvalId);
    bridgeState.planApprovalStreams.delete(approvalId);
  }
}

export async function waitForPlanApproval(
  streamId: string,
  options: PlanApprovalRequestOptions,
): Promise<PlanApprovalResult> {
  const coordinators = getRunCoordinators();
  bridgeState.planApprovals.set(options.approvalId, coordinators);
  bridgeState.planApprovalStreams.set(options.approvalId, streamId);
  bridgeState.planStreams.set(streamId, coordinators);
  try {
    return await coordinators.plan.waitForApproval(streamId, options);
  } finally {
    bridgeState.planApprovals.delete(options.approvalId);
    bridgeState.planApprovalStreams.delete(options.approvalId);
    bridgeState.planStreams.delete(streamId);
  }
}

export function resolvePlanApproval(
  approvalId: string,
  result: PlanApprovalResult,
): boolean {
  return (
    bridgeState.planApprovals.get(approvalId)?.plan ?? legacyCoordinators.plan
  ).resolveRequest(approvalId, result);
}

export function clearPlanApprovalForStream(streamId: string): void {
  (
    bridgeState.planStreams.get(streamId)?.plan ?? legacyCoordinators.plan
  ).clearForStream(streamId);
  clearPlanBridgeForStream(streamId);
}

export function clearAllPlanApprovals(): void {
  const coordinators = new Set(bridgeState.planStreams.values());
  coordinators.add(legacyCoordinators);
  for (const coordinator of coordinators) {
    coordinator.plan.clearAll();
  }
  bridgeState.planApprovals.clear();
  bridgeState.planApprovalStreams.clear();
  bridgeState.planStreams.clear();
}

export async function waitForProposal(
  streamId: string,
  options: ProposalRequestOptions,
): Promise<ProposalResult> {
  const coordinators = getRunCoordinators();
  bridgeState.proposals.set(options.proposalId, coordinators);
  bridgeState.proposalStreams.set(options.proposalId, streamId);
  try {
    return await coordinators.proposal.waitForProposal(streamId, options);
  } finally {
    bridgeState.proposals.delete(options.proposalId);
    bridgeState.proposalStreams.delete(options.proposalId);
  }
}

export function resolveProposal(
  proposalId: string,
  result: ProposalResult,
): boolean {
  return (
    bridgeState.proposals.get(proposalId)?.proposal ??
    legacyCoordinators.proposal
  ).resolveRequest(proposalId, result);
}

export function clearProposalForStream(streamId: string): void {
  const proposalIds = [...bridgeState.proposalStreams.entries()]
    .filter(([, proposalStreamId]) => proposalStreamId === streamId)
    .map(([proposalId]) => proposalId);
  for (const proposalId of proposalIds) {
    (
      bridgeState.proposals.get(proposalId)?.proposal ??
      legacyCoordinators.proposal
    ).clearRequest(proposalId);
    bridgeState.proposals.delete(proposalId);
    bridgeState.proposalStreams.delete(proposalId);
  }
}

export function clearAllProposals(): void {
  const coordinators = new Set(bridgeState.proposals.values());
  coordinators.add(legacyCoordinators);
  for (const coordinator of coordinators) {
    coordinator.proposal.clearAll();
  }
  bridgeState.proposals.clear();
  bridgeState.proposalStreams.clear();
}

export async function waitForRetry(
  streamId: string,
  options: RetryRequestOptions,
): Promise<RetryResult> {
  const coordinators = getRunCoordinators();
  retainRetryCoordinator(coordinators);
  bridgeState.retries.set(streamId, coordinators);
  try {
    return await coordinators.retry.waitForRetry(streamId, options);
  } finally {
    bridgeState.retries.delete(streamId);
    releaseRetryCoordinator(coordinators);
  }
}

export function triggerRetry(streamId: string, feedback?: string): boolean {
  return (
    bridgeState.retries.get(streamId)?.retry ?? legacyCoordinators.retry
  ).triggerRetry(streamId, feedback);
}

export function cancelRetry(streamId: string): boolean {
  return (
    bridgeState.retries.get(streamId)?.retry ?? legacyCoordinators.retry
  ).cancelRetry(streamId);
}

export function clearRetryRequest(streamId: string): void {
  const coordinators = new Set(bridgeState.retryCoordinatorRefs.keys());
  const mappedCoordinators = bridgeState.retries.get(streamId);
  if (mappedCoordinators) coordinators.add(mappedCoordinators);
  coordinators.add(legacyCoordinators);
  for (const coordinator of coordinators) {
    coordinator.retry.clearRequest(streamId);
  }
  bridgeState.retries.delete(streamId);
}

export function clearAllRetryRequests(): void {
  const coordinators = new Set(bridgeState.retryCoordinatorRefs.keys());
  for (const runCoordinators of bridgeState.retries.values()) {
    coordinators.add(runCoordinators);
  }
  coordinators.add(legacyCoordinators);
  for (const coordinator of coordinators) {
    coordinator.retry.clearAll();
  }
  bridgeState.retryCoordinatorRefs.clear();
  bridgeState.retries.clear();
}
