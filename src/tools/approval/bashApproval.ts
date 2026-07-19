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
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { StreamTabIdSchema, type StreamTabId } from '@shared/schemas';
import { BASH_APPROVAL_CONFIG_KEY } from '@shared/schemas/agentCliSettings';
import { type ToolResult } from '@shared/schemas/toolResult';
import { requireRuntimeHost } from '@tools/contextHelpers';
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
  /** Distinguishes a host-side interaction timeout from an explicit reject. */
  timedOut: z.boolean().optional(),
});
type BashApprovalResult = z.infer<typeof BashApprovalResultSchema>;

const DEFAULT_BASH_REJECTION_INSTRUCTION =
  'Do not retry this rejected command or another approval-gated shell command for the same check. ' +
  'Continue without running it, use a non-shell method, or explain what approval would be needed.';

const DEFAULT_BASH_TIMEOUT_INSTRUCTION =
  'The approval request was not answered in time — this is not an explicit ' +
  'rejection. You may retry the command later if it is still needed, use a ' +
  'non-shell method, or continue without it.';

export function setBashApprovalSessionBypass(
  streamId: StreamTabId,
  enabled: boolean,
  runtimeHost: AgentRuntimeHost,
  options?: { silent?: boolean; session?: SessionHandle },
): void {
  (options?.session ?? currentSession()).approvals.bash.bypass.setBypass(
    streamId,
    enabled,
    runtimeHost,
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

  requireRuntimeHost('bash approval', context);

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
  timedOut?: boolean,
): ToolResult {
  const preview = truncateWithEllipsis(command, 60);
  const message = timedOut
    ? `Command approval timed out: ${preview}`
    : `User rejected command: ${preview}`;
  const feedback = userMessage?.trim();
  return {
    status: 'error',
    summary: message,
    error: message,
    userInstruction:
      feedback ||
      (timedOut
        ? DEFAULT_BASH_TIMEOUT_INSTRUCTION
        : DEFAULT_BASH_REJECTION_INSTRUCTION),
  };
}
