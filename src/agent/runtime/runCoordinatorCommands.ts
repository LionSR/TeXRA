import type { StreamTabId } from '@shared/schemas';

import { currentSession, type SessionHandle } from './SessionHandle';
import type { ProposalResult } from './AgentProposalCoordinator';
import type { PlanApprovalResult } from './PlanApprovalCoordinator';

export interface RuntimePlanApprovalResolution {
  readonly approvalId: string;
  readonly result: PlanApprovalResult;
  readonly session?: SessionHandle;
}

export interface RuntimeProposalResolution {
  readonly proposalId: string;
  readonly result: ProposalResult;
  readonly session?: SessionHandle;
}

export interface RuntimeRetryRequest {
  readonly streamId: StreamTabId;
  readonly feedback?: string;
  readonly session?: SessionHandle;
}

export interface RuntimeRetryClearRequest {
  readonly streamId: StreamTabId;
  readonly session?: SessionHandle;
}

/** Resolve a pending plan approval request owned by a live run. */
export function resolveRuntimePlanApproval({
  approvalId,
  result,
  session = currentSession(),
}: RuntimePlanApprovalResolution): boolean {
  return session.coordinators.resolvePlanApproval(approvalId, result);
}

/** Resolve a pending agent proposal request owned by a live run. */
export function resolveRuntimeProposal({
  proposalId,
  result,
  session = currentSession(),
}: RuntimeProposalResolution): boolean {
  return session.coordinators.resolveProposal(proposalId, result);
}

/** Trigger a pending retry request owned by a live run. */
export function triggerRuntimeRetry({
  streamId,
  feedback,
  session = currentSession(),
}: RuntimeRetryRequest): boolean {
  return session.coordinators.triggerRetry(streamId, feedback);
}

/** Cancel a pending retry request owned by a live run. */
export function cancelRuntimeRetry({
  streamId,
  session = currentSession(),
}: RuntimeRetryClearRequest): boolean {
  return session.coordinators.cancelRetry(streamId);
}

/** Clear retry state for a stream during host-owned stream cleanup. */
export function clearRuntimeRetryRequest({
  streamId,
  session = currentSession(),
}: RuntimeRetryClearRequest): void {
  session.coordinators.clearRetryRequest(streamId);
}
