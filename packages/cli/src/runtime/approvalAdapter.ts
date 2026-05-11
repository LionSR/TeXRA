// Local imports - runtime
import {
  cancelRetry,
  resolvePlanApproval,
  resolveProposal,
  triggerRetry,
} from '@agent/runtime/runCoordinators';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

// Local imports - tools
import { handleProgressViewBashApprovalAction } from '@tools/approval/bashApproval';
import {
  setToolEditApprovalHandler,
  type ToolEditApprovalRequest,
  type ToolEditApprovalResult,
} from '@tools/approval/toolEditApproval';
import { handleExternalInquiryAction } from '@tools/inquiry/ExternalInquiryTool';

// Local imports - CLI runtime
import type { CliContext } from './cliContext';

function denyMessage(policy: CliContext['approvalPolicy']): string {
  return policy === 'ask'
    ? 'Interactive approval prompts are not implemented in this CLI path yet.'
    : 'Denied by CLI approval policy.';
}

function externalInquiryMessage(policy: CliContext['approvalPolicy']): string {
  if (policy === 'yolo') {
    return 'External inquiry requires human input; yolo mode cannot synthesize an external answer.';
  }
  return denyMessage(policy);
}

async function decideToolEdit(
  request: ToolEditApprovalRequest,
  context: CliContext,
): Promise<ToolEditApprovalResult> {
  if (context.approvalPolicy === 'yolo') {
    return { accepted: true, appliedContent: request.proposedContent };
  }
  return { accepted: false, userMessage: denyMessage(context.approvalPolicy) };
}

export function installCliApprovalHandlers(context: CliContext): void {
  setToolEditApprovalHandler((request) => decideToolEdit(request, context));
}

export function handleCliApprovalEvent<K extends keyof ProgressEventPayloads>(
  event: K,
  payload: ProgressEventPayloads[K],
  context: CliContext,
): boolean {
  switch (event) {
    case 'showBashPermission': {
      const data = payload as ProgressEventPayloads['showBashPermission'];
      void handleProgressViewBashApprovalAction({
        requestId: data.requestId,
        action: context.approvalPolicy === 'yolo' ? 'approve' : 'reject',
        feedback:
          context.approvalPolicy === 'yolo'
            ? undefined
            : denyMessage(context.approvalPolicy),
      });
      return true;
    }
    case 'showPlanApproval': {
      const data = payload as ProgressEventPayloads['showPlanApproval'];
      resolvePlanApproval(data.approvalId, {
        action: context.approvalPolicy === 'yolo' ? 'approve' : 'reject',
        ...(context.approvalPolicy === 'yolo'
          ? {}
          : { feedback: denyMessage(context.approvalPolicy) }),
      });
      return true;
    }
    case 'showAgentProposal': {
      const data = payload as ProgressEventPayloads['showAgentProposal'];
      resolveProposal(data.proposalId, {
        action: context.approvalPolicy === 'yolo' ? 'approve' : 'reject',
        ...(context.approvalPolicy === 'yolo'
          ? {}
          : { feedback: denyMessage(context.approvalPolicy) }),
      });
      return true;
    }
    case 'showRetryRequest': {
      const data = payload as ProgressEventPayloads['showRetryRequest'];
      if (context.approvalPolicy === 'yolo') {
        triggerRetry(data.streamId);
      } else {
        cancelRetry(data.streamId);
      }
      return true;
    }
    case 'showExternalInquiry': {
      const data = payload as ProgressEventPayloads['showExternalInquiry'];
      void handleExternalInquiryAction({
        requestId: data.requestId,
        action: 'skip',
        feedback: externalInquiryMessage(context.approvalPolicy),
      });
      return true;
    }
    default:
      return false;
  }
}
