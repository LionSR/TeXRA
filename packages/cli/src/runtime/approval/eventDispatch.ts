import type {
  AgentProposalPermission,
  PlanApprovalPermission,
  RetryPermission,
} from '@shared/schemas';

import {
  type CliDecisionApprovalEvent,
  type CliDecisionApprovalPayloads,
} from './approvalPrompts';
import { formatAgentProposalApprovalSummary } from './approvalSummaries';

export function summarizeApprovalEvent<K extends CliDecisionApprovalEvent>(
  event: K,
  payload: CliDecisionApprovalPayloads[K],
): string {
  switch (event) {
    case 'showPlanApproval': {
      const data = payload as PlanApprovalPermission;
      return `Plan approval requested:\n${JSON.stringify(data.plan, null, 2)}`;
    }
    case 'showAgentProposal': {
      const data = payload as AgentProposalPermission;
      return formatAgentProposalApprovalSummary(data);
    }
    case 'showRetryRequest': {
      const data = payload as RetryPermission;
      return `Retry requested for ${data.operation}: ${data.errorMessage ?? 'unknown error'}`;
    }
    default: {
      const never: never = event;
      return String(never);
    }
  }
}
