import {
  classifyRejection,
  type BashSettlement,
  type HostBashApprovalRequest,
} from '@agent/runtime/HostInteractions';
import {
  currentSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import {
  getRunContextStreamId,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import { effectRuntime } from '@platform/processRuntime';
import {
  BASH_APPROVAL_CONFIG_KEY,
  type BashPermission,
  type StreamTabId,
  type ToolResult,
} from '@shared/schemas';
import {
  decideTexraApproval,
  isTexraApprovalDenied,
  texraApprovalDenialMessage,
} from '@shared/approvalPolicy';
import { requireInteractions } from '@tools/contextHelpers';
import { errorResult } from '@tools/core/result';
import { generateShortId } from '@utils/core';
import { getConfig } from '@utils/config/configUtils';
import { truncateWithEllipsis } from '@utils/text/stringUtils';

const DEFAULT_BASH_REJECTION_GUIDANCE =
  'Do not retry this rejected command or another approval-gated shell command for the same check. ' +
  'Continue without running it, use a non-shell method, or explain what approval would be needed.';

/**
 * Build the bash permission payload every host publishes to its approval
 * surface, the bash counterpart of `prepareToolEditApprovalPrompt`.
 *
 * Owning it here keeps one request-id scheme, derives the bypass affordance
 * from the stream's current bypass state, and drops a blank working directory
 * so no renderer has to decide what an empty `cwd` means. Pass `session` when
 * the host owns one (extension, desktop); the CLI hosts run on the default
 * session.
 */
function isBashApprovalBypassedForStream(
  streamId: StreamTabId,
  session: SessionHandle = currentSession(),
): boolean {
  return session.approvals.bash.bypass.isBypassed(streamId);
}

function prepareBashApprovalPrompt(
  request: Omit<HostBashApprovalRequest, 'permission'>,
  session?: SessionHandle,
): BashPermission {
  const streamId = request.streamId ?? undefined;
  const isBypassed = streamId
    ? isBashApprovalBypassedForStream(streamId, session)
    : false;
  const cwd = request.cwd?.trim();
  return {
    requestId: `bash-${generateShortId()}`,
    command: request.command,
    ...(cwd && { cwd }),
    allowBypass: !isBypassed,
    streamId: streamId ?? '',
  };
}

export async function requestBashApproval(
  request: Omit<HostBashApprovalRequest, 'permission'>,
): Promise<BashSettlement> {
  const approvalsEnabled = getConfig<boolean>(BASH_APPROVAL_CONFIG_KEY);

  const context = tryUseRunContext();
  const session = currentSession();
  const streamId = request.streamId ?? getRunContextStreamId(context);
  const isStreamBypassed = Boolean(
    streamId && session.approvals.bash.bypass.isBypassed(streamId),
  );
  const decision = decideTexraApproval({
    policy: session.approvalPolicy,
    promptRequired: approvalsEnabled,
    scopedBypass: isStreamBypassed,
    canPresent: context?.approvalPromptsUnavailable !== true,
  });

  if (decision === 'allow') return { action: 'approve' };
  if (isTexraApprovalDenied(decision)) {
    context?.onApprovalPolicyDenial?.();
    return {
      action: 'reject',
      reason: texraApprovalDenialMessage(decision),
    };
  }

  requireInteractions('bash approval', context);

  const hostRequest: Omit<HostBashApprovalRequest, 'permission'> = {
    command: request.command,
    ...(request.cwd && { cwd: request.cwd }),
    streamId,
  };
  // The approval lane is an Effect program; the tool-facing contract here is
  // still a Promise, so it runs on the process runtime at this boundary.
  return effectRuntime().runPromise(
    session.approvals.bash.enqueue(streamId, {
      prompt: () =>
        session.interactions.requestBashApproval({
          ...hostRequest,
          permission: prepareBashApprovalPrompt(hostRequest, session),
        }),
      bypassed: () => ({ action: 'approve' }),
    }),
  );
}

export function buildBashApprovalRejectedResult(
  command: string,
  rejection: Extract<BashSettlement, { action: 'reject' }>,
): ToolResult {
  const preview = truncateWithEllipsis(command, 60);
  const classification = classifyRejection(rejection);
  let message: string;
  let guidance: string | undefined;
  let feedback: string | undefined;
  switch (classification.kind) {
    case 'policy':
      message = `Command denied: ${preview}`;
      guidance = classification.reason.trim();
      break;
    case 'cancelled':
      message = `Command approval cancelled: ${preview}`;
      guidance = classification.cause?.trim();
      break;
    case 'feedback':
      message = `User rejected command: ${preview}`;
      guidance = DEFAULT_BASH_REJECTION_GUIDANCE;
      feedback = classification.feedback?.trim();
      break;
  }
  const error = feedback || !guidance ? message : `${message}\n\n${guidance}`;
  return errorResult(error, {
    summary: message,
    ...(feedback && { userInstruction: feedback }),
  });
}
