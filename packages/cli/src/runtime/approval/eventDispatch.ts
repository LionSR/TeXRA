import type {
  AgentProposalPermission,
  BashPermission,
  PlanApprovalPermission,
  RetryPermission,
} from '@shared/schemas';

import {
  type CliDecisionApprovalEvent,
  type CliDecisionApprovalPayloads,
} from './approvalPolicy';
import { formatAgentProposalApprovalSummary } from './approvalSummaries';

export function summarizeApprovalEvent<K extends CliDecisionApprovalEvent>(
  event: K,
  payload: CliDecisionApprovalPayloads[K],
): string {
  switch (event) {
    case 'showBashPermission': {
      const data = payload as BashPermission;
      const cwd = data.cwd ? `Directory: ${data.cwd}\n` : '';
      return `Command requested:\n${cwd}${data.command}`;
    }
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
