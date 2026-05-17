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
import {
  tryUseRunContext,
  useRunContext,
  type RunCoordinators,
} from './RunContext';

const legacyCoordinators: RunCoordinators = {
  plan: planApprovalCoordinator,
  proposal: proposalCoordinator,
  retry: retryCoordinator,
};

function useRunCoordinators(): RunCoordinators {
  const coordinators = useRunContext().coordinators;
  if (!coordinators) {
    throw new Error('run coordinator request requires active run coordinators');
  }
  return coordinators;
}

const bridgeState = {
  runStreams: new Map<string, RunCoordinators>(),
  planApprovals: new Map<string, RunCoordinators>(),
  planApprovalStreams: new Map<string, string>(),
  planStreams: new Map<string, RunCoordinators>(),
  proposals: new Map<string, RunCoordinators>(),
  proposalStreams: new Map<string, string>(),
  retries: new Map<string, RunCoordinators>(),
  retryCoordinatorRefs: new Map<RunCoordinators, number>(),
};

export function retainRunCoordinatorsForStream(
  streamId: string,
  coordinators: RunCoordinators,
): () => void {
  bridgeState.runStreams.set(streamId, coordinators);
  return () => {
    if (bridgeState.runStreams.get(streamId) === coordinators) {
      bridgeState.runStreams.delete(streamId);
    }
  };
}

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
  const coordinators = useRunCoordinators();
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
    bridgeState.planStreams.get(streamId)?.plan ??
    bridgeState.runStreams.get(streamId)?.plan ??
    tryUseRunContext()?.coordinators?.plan ??
    legacyCoordinators.plan
  ).clearForStream(streamId);
  clearPlanBridgeForStream(streamId);
}

function clearAllPlanApprovals(): void {
  const coordinators = new Set(bridgeState.planStreams.values());
  for (const runCoordinators of bridgeState.runStreams.values()) {
    coordinators.add(runCoordinators);
  }
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
  const coordinators = useRunCoordinators();
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

function clearProposalForStream(streamId: string): void {
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

function clearAllProposals(): void {
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
  const coordinators = useRunCoordinators();
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
  const coordinators = new Set<RunCoordinators>();
  const mappedCoordinators = bridgeState.retries.get(streamId);
  if (mappedCoordinators) coordinators.add(mappedCoordinators);
  const runCoordinators = bridgeState.runStreams.get(streamId);
  if (runCoordinators) coordinators.add(runCoordinators);
  const ambient = tryUseRunContext()?.coordinators;
  if (ambient) coordinators.add(ambient);
  coordinators.add(legacyCoordinators);
  for (const coordinator of coordinators) {
    coordinator.retry.clearRequest(streamId);
  }
  bridgeState.retries.delete(streamId);
}

export function clearAllRetryRequests(): void {
  const coordinators = new Set(bridgeState.retryCoordinatorRefs.keys());
  for (const runCoordinators of bridgeState.runStreams.values()) {
    coordinators.add(runCoordinators);
  }
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

export function cleanupCoordinatorRequestsForStream(streamId: string): void {
  clearPlanApprovalForStream(streamId);
  clearProposalForStream(streamId);
  clearRetryRequest(streamId);
}

export function cleanupAllCoordinatorRequests(): void {
  clearAllPlanApprovals();
  clearAllProposals();
  clearAllRetryRequests();
}
