import type { UserQuestionAnswers } from '@shared/schemas';

import type {
  HostBashApprovalResult,
  HostInteractionResolution,
  HostUserQuestionResult,
} from './HostInteractions';
import type { ProposalResult } from './AgentProposalCoordinator';
import type { PlanApprovalResult } from './PlanApprovalCoordinator';
import type { RetryResult } from './RetryRequestCoordinator';

export function toBashApprovalResult(
  result: HostInteractionResolution,
): HostBashApprovalResult {
  return {
    accepted: result.action === 'approve',
    ...(result.action === 'reject' && result.feedback
      ? { userMessage: result.feedback }
      : {}),
  };
}

export function toPlanApprovalResult(
  result: HostInteractionResolution,
): PlanApprovalResult {
  if (result.action === 'approve') return { action: 'approve' };
  if (result.action === 'approve_and_goal') {
    return { action: 'approve_and_goal' };
  }
  return {
    action: 'reject',
    ...(result.feedback ? { feedback: result.feedback } : {}),
  };
}

export function toProposalResult(
  result: HostInteractionResolution,
): ProposalResult {
  const value = result.value as ProposalResult | undefined;
  if (value?.action === 'approve') return value;
  if (value?.action === 'setup') return value;
  if (value?.action === 'reject') return value;
  if (result.action === 'setup') return { action: 'setup' };
  if (result.action === 'approve') return { action: 'approve' };
  return {
    action: 'reject',
    ...(result.feedback ? { feedback: result.feedback } : {}),
  };
}

export function toRetryResult(result: HostInteractionResolution): RetryResult {
  if (result.action === 'retry') {
    return {
      action: 'retry',
      ...(result.feedback ? { feedback: result.feedback } : {}),
    };
  }
  return { action: 'cancel' };
}

export function toUserQuestionResult(
  result: HostInteractionResolution,
): HostUserQuestionResult {
  if (result.action === 'submit') {
    return {
      submitted: true,
      ...(result.value ? { answers: result.value as UserQuestionAnswers } : {}),
    };
  }
  return {
    submitted: false,
    ...(result.feedback ? { feedback: result.feedback } : {}),
  };
}
