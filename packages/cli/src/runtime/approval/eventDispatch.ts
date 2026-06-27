import { resolveRuntimeBashApproval } from '@agent/runtime/approvalCommands';
import {
  cancelRuntimeRetry,
  resolveRuntimePlanApproval,
  resolveRuntimeProposal,
  triggerRuntimeRetry,
} from '@agent/runtime/runCoordinatorCommands';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

import { type CliDecisionApprovalEvent } from '../approvalEvents';
import { writeTextStderr } from '../logSinks';

import { type ApprovalDecision } from './approvalPolicy';
import { formatAgentProposalApprovalSummary } from './approvalSummaries';

export function summarizeApprovalEvent<K extends CliDecisionApprovalEvent>(
  event: K,
  payload: ProgressEventPayloads[K],
): string {
  switch (event) {
    case 'showBashPermission': {
      const data = payload as ProgressEventPayloads['showBashPermission'];
      const cwd = data.cwd ? `Directory: ${data.cwd}\n` : '';
      return `Bash command requested:\n${cwd}${data.command}`;
    }
    case 'showPlanApproval': {
      const data = payload as ProgressEventPayloads['showPlanApproval'];
      return `Plan approval requested:\n${JSON.stringify(data.plan, null, 2)}`;
    }
    case 'showAgentProposal': {
      const data = payload as ProgressEventPayloads['showAgentProposal'];
      return formatAgentProposalApprovalSummary(data);
    }
    case 'showRetryRequest': {
      const data = payload as ProgressEventPayloads['showRetryRequest'];
      return `Retry requested for ${data.operation}: ${data.errorMessage ?? 'unknown error'}`;
    }
    default: {
      const never: never = event;
      return String(never);
    }
  }
}

export function dispatchApprovalDecision<K extends CliDecisionApprovalEvent>(
  event: K,
  payload: ProgressEventPayloads[K],
  decision: ApprovalDecision,
  options: { writeRejectionToStderr?: boolean } = {},
): void {
  const action = decision.accepted ? 'approve' : 'reject';
  switch (event) {
    case 'showBashPermission': {
      const data = payload as ProgressEventPayloads['showBashPermission'];
      void resolveRuntimeBashApproval({
        requestId: data.requestId,
        action,
        feedback: decision.userMessage,
      });
      return;
    }
    case 'showPlanApproval': {
      const data = payload as ProgressEventPayloads['showPlanApproval'];
      resolveRuntimePlanApproval({
        approvalId: data.approvalId,
        result: {
          action,
          ...(decision.userMessage ? { feedback: decision.userMessage } : {}),
        },
      });
      return;
    }
    case 'showAgentProposal': {
      const data = payload as ProgressEventPayloads['showAgentProposal'];
      resolveRuntimeProposal({
        proposalId: data.proposalId,
        result: {
          action,
          ...(decision.userMessage ? { feedback: decision.userMessage } : {}),
        },
      });
      return;
    }
    case 'showRetryRequest': {
      const data = payload as ProgressEventPayloads['showRetryRequest'];
      if (decision.accepted) {
        triggerRuntimeRetry({ streamId: data.streamId });
        return;
      }
      if (options.writeRejectionToStderr) {
        const summary = summarizeApprovalEvent(event, payload);
        writeTextStderr(
          decision.userMessage
            ? `${summary}\n${decision.userMessage}`
            : summary,
        );
      }
      cancelRuntimeRetry({ streamId: data.streamId });
      return;
    }
    default: {
      const never: never = event;
      return never;
    }
  }
}
