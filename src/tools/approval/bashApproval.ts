import { z } from 'zod';

import type { BashSettlement } from '@agent/runtime/HostInteractions';
import {
  defaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import {
  getRunContextSession,
  getRunContextStreamId,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import { StreamTabIdSchema, type StreamTabId } from '@shared/schemas';
import { BASH_APPROVAL_CONFIG_KEY } from '@shared/schemas/agentCliSettings';
import { type ToolResult } from '@shared/schemas/toolResult';
import { requireInteractions } from '@tools/contextHelpers';
import { createSessionBypassAccessors } from '@tools/approval/sessionBypassAccessors';
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

const {
  setSessionBypass: setBashApprovalSessionBypass,
  isBypassedForStream: isBashApprovalBypassedForStream,
} = createSessionBypassAccessors((session) => session.approvals.bash.bypass);
export { setBashApprovalSessionBypass, isBashApprovalBypassedForStream };

export async function requestBashApproval(
  request: BashApprovalRequest,
): Promise<BashSettlement> {
  const approvalsEnabled = getConfig<boolean>(BASH_APPROVAL_CONFIG_KEY, true);

  const context = tryUseRunContext();
  const session = getRunContextSession(context) ?? defaultSession();
  const streamId = request.streamId ?? getRunContextStreamId(context);

  if (
    !approvalsEnabled ||
    (streamId && session.approvals.bash.bypass.isBypassed(streamId))
  ) {
    return { action: 'approve' };
  }

  requireInteractions('bash approval', context);

  return session.approvals.bash.enqueue(streamId, () =>
    showApprovalPrompt(request, streamId, session),
  );
}

async function showApprovalPrompt(
  request: BashApprovalRequest,
  streamId: StreamTabId | undefined,
  session: SessionHandle,
): Promise<BashSettlement> {
  if (streamId && session.approvals.bash.bypass.isBypassed(streamId)) {
    return { action: 'approve' };
  }

  return session.interactions.requestBashApproval({
    command: request.command,
    ...(request.cwd ? { cwd: request.cwd } : {}),
    streamId,
  });
}

export function buildBashApprovalRejectedResult(
  command: string,
  rejectionFeedback?: string,
): ToolResult {
  const preview = truncateWithEllipsis(command, 60);
  const message = `User rejected command: ${preview}`;
  const feedback = rejectionFeedback?.trim();
  return {
    status: 'error',
    summary: message,
    error: message,
    userInstruction: feedback || DEFAULT_BASH_REJECTION_INSTRUCTION,
  };
}
