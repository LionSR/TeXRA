import { z } from 'zod';

import type {
  BashSettlement,
  HostBashApprovalRequest,
} from '@agent/runtime/HostInteractions';
import {
  currentSession,
  defaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import {
  getRunContextSession,
  getRunContextStreamId,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import {
  StreamTabIdSchema,
  type BashPermission,
  type StreamTabId,
} from '@shared/schemas';
import {
  decideTexraApproval,
  isTexraApprovalDenied,
  texraApprovalDenialMessage,
} from '@shared/approvalPolicy';
import { type ToolResult } from '@shared/schemas';
import { BASH_APPROVAL_CONFIG_KEY } from '@shared/schemas/agentCliSettings';
import { requireInteractions } from '@tools/contextHelpers';
import { errorResult } from '@tools/core/result';
import { generateShortId } from '@utils/core';
import { getConfig } from '@utils/config/configUtils';
import { truncateWithEllipsis } from '@utils/text/stringUtils';

const BashApprovalRequestSchema = z.object({
  command: z.string(),
  cwd: z.string().nullish(),
  streamId: StreamTabIdSchema.nullish(),
});
type BashApprovalRequest = z.infer<typeof BashApprovalRequestSchema>;

const DEFAULT_BASH_REJECTION_INSTRUCTION =
  'Do not retry this rejected command or another approval-gated shell command for the same check. ' +
  'Continue without running it, use a non-shell method, or explain what approval would be needed.';

export function setBashApprovalSessionBypass(
  streamId: StreamTabId,
  enabled: boolean,
  options?: { silent?: boolean; session?: SessionHandle },
): void {
  (options?.session ?? currentSession()).approvals.bash.bypass.setBypass(
    streamId,
    enabled,
    { silent: options?.silent },
  );
}

export function isBashApprovalBypassedForStream(
  streamId: StreamTabId,
  session: SessionHandle = currentSession(),
): boolean {
  return session.approvals.bash.bypass.isBypassed(streamId);
}

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
export function prepareBashApprovalPrompt(
  request: HostBashApprovalRequest,
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
  request: BashApprovalRequest,
): Promise<BashSettlement> {
  const approvalsEnabled = getConfig<boolean>(BASH_APPROVAL_CONFIG_KEY, true);

  const context = tryUseRunContext();
  const session = getRunContextSession(context) ?? defaultSession();
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
      feedback: texraApprovalDenialMessage(decision),
    };
  }

  requireInteractions('bash approval', context);

  return session.approvals.bash.enqueue(streamId, {
    prompt: () =>
      session.interactions.requestBashApproval({
        command: request.command,
        ...(request.cwd && { cwd: request.cwd }),
        streamId,
      }),
    bypassed: () => ({ action: 'approve' }),
  });
}

export function buildBashApprovalRejectedResult(
  command: string,
  rejectionFeedback?: string,
): ToolResult {
  const preview = truncateWithEllipsis(command, 60);
  const message = `User rejected command: ${preview}`;
  const feedback = rejectionFeedback?.trim();
  return errorResult(message, {
    summary: message,
    userInstruction: feedback || DEFAULT_BASH_REJECTION_INSTRUCTION,
  });
}
