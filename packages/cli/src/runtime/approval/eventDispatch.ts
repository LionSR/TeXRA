import type { RuntimeInteractionEventPayloads } from '@agent/runtime/runtimeInteractionEvents';

import { type CliDecisionApprovalEvent } from '../approvalEvents';

import { formatAgentProposalApprovalSummary } from './approvalSummaries';

export function summarizeApprovalEvent<K extends CliDecisionApprovalEvent>(
  event: K,
  payload: RuntimeInteractionEventPayloads[K],
): string {
  switch (event) {
    case 'showBashPermission': {
      const data =
        payload as RuntimeInteractionEventPayloads['showBashPermission'];
      const cwd = data.cwd ? `Directory: ${data.cwd}\n` : '';
      return `Bash command requested:\n${cwd}${data.command}`;
    }
    case 'showPlanApproval': {
      const data =
        payload as RuntimeInteractionEventPayloads['showPlanApproval'];
      return `Plan approval requested:\n${JSON.stringify(data.plan, null, 2)}`;
    }
    case 'showAgentProposal': {
      const data =
        payload as RuntimeInteractionEventPayloads['showAgentProposal'];
      return formatAgentProposalApprovalSummary(data);
    }
    case 'showRetryRequest': {
      const data =
        payload as RuntimeInteractionEventPayloads['showRetryRequest'];
      return `Retry requested for ${data.operation}: ${data.errorMessage ?? 'unknown error'}`;
    }
    default: {
      const never: never = event;
      return String(never);
    }
  }
}
