import { z } from 'zod';

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
import type { SessionHostInteractions } from '@agent/runtime/HostInteractions';
import { StreamTabIdSchema, type StreamTabId } from '@shared/schemas';
import { BASH_APPROVAL_CONFIG_KEY } from '@shared/schemas/agentCliSettings';
import { type ToolResult } from '@shared/schemas/toolResult';
import { requireInteractions } from '@tools/contextHelpers';
import { getConfig } from '@utils/config/configUtils';
import { truncateWithEllipsis } from '@utils/text/stringUtils';

const BashApprovalRequestSchema = z.object({
  command: z.string(),
  cwd: z.string().nullish(),
  streamId: StreamTabIdSchema.nullish(),
});
type BashApprovalRequest = z.infer<typeof BashApprovalRequestSchema>;

const BashApprovalResultSchema = z.object({
  accepted: z.boolean(),
  userMessage: z.string().optional(),
});
type BashApprovalResult = z.infer<typeof BashApprovalResultSchema>;

const DEFAULT_BASH_REJECTION_INSTRUCTION =
  'Do not retry this rejected command or another approval-gated shell command for the same check. ' +
  'Continue without running it, use a non-shell method, or explain what approval would be needed.';

export function setBashApprovalSessionBypass(
  streamId: StreamTabId,
  enabled: boolean,
  interactions: SessionHostInteractions,
  options?: { silent?: boolean; session?: SessionHandle },
): void {
  (options?.session ?? currentSession()).approvals.bash.bypass.setBypass(
    streamId,
    enabled,
    options,
  );
}

export function isBashApprovalBypassedForStream(
  streamId: StreamTabId,
  session: SessionHandle = currentSession(),
): boolean {
  return session.approvals.bash.bypass.isBypassed(streamId);
}

export async function requestBashApproval(
  request: BashApprovalRequest,
): Promise<BashApprovalResult> {
  const approvalsEnabled = getConfig<boolean>(BASH_APPROVAL_CONFIG_KEY, true);

  const context = tryUseRunContext();
  const session = getRunContextSession(context) ?? defaultSession();
  const streamId = request.streamId ?? getRunContextStreamId(context);

  if (
    !approvalsEnabled ||
    (streamId && session.approvals.bash.bypass.isBypassed(streamId))
  ) {
    return { accepted: true };
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
): Promise<BashApprovalResult> {
  if (streamId && session.approvals.bash.bypass.isBypassed(streamId)) {
    return { accepted: true };
  }

  return session.interactions.requestBashApproval({
    command: request.command,
    ...(request.cwd ? { cwd: request.cwd } : {}),
    streamId,
  });
}

export function buildBashApprovalRejectedResult(
  command: string,
  userMessage?: string,
): ToolResult {
  const preview = truncateWithEllipsis(command, 60);
  const message = `User rejected command: ${preview}`;
  const feedback = userMessage?.trim();
  return {
    status: 'error',
    summary: message,
    error: message,
    userInstruction: feedback || DEFAULT_BASH_REJECTION_INSTRUCTION,
  };
}
