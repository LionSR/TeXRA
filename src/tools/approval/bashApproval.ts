import { z } from 'zod';

import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { tryUseRunContext } from '@agent/runtime/RunContext';
import { getConfig } from '@agent/core/config';
import { StreamTabIdSchema, type StreamTabId } from '@shared/schemas';
import { ToolError, type ToolResult } from '@tools/result';
import { truncateWithEllipsis } from '@utils/text/stringUtils';

import { createStreamApprovalController } from './streamApprovalQueue';
import { isApprovalBypassedForStream } from './toolEditApproval';

export const BashApprovalRequestSchema = z.object({
  command: z.string(),
  streamId: StreamTabIdSchema.optional(),
});
export type BashApprovalRequest = z.infer<typeof BashApprovalRequestSchema>;

export const BashApprovalResultSchema = z.object({
  accepted: z.boolean(),
  userMessage: z.string().optional(),
});
export type BashApprovalResult = z.infer<typeof BashApprovalResultSchema>;

export const BASH_APPROVAL_CONFIG_KEY = 'texra.toolUse.requireBashApproval';

export const BASH_APPROVAL_ACTIONS = ['approve', 'reject'] as const;

export type BashApprovalAction = (typeof BASH_APPROVAL_ACTIONS)[number];

export const bashApprovalController =
  createStreamApprovalController<BashApprovalResult>({
    rejectionResult: () => ({ accepted: false }),
  });

let approvalCounter = 0;

export async function requestBashApproval(
  request: BashApprovalRequest,
): Promise<BashApprovalResult> {
  const approvalsEnabled = getConfig<boolean>(BASH_APPROVAL_CONFIG_KEY, true);

  const context = tryUseRunContext();
  const streamId = request.streamId ?? context?.streamId;

  if (
    !approvalsEnabled ||
    (streamId && isApprovalBypassedForStream(streamId))
  ) {
    return { accepted: true };
  }

  const runtimeHost = context?.runtimeHost;
  if (!runtimeHost) {
    throw new ToolError(
      'Bash approval requires a tool runtime host when approvals are enabled.',
    );
  }

  return bashApprovalController.enqueue(() =>
    showApprovalPrompt(request, streamId, runtimeHost),
  );
}

async function showApprovalPrompt(
  request: BashApprovalRequest,
  streamId: StreamTabId | undefined,
  runtimeHost: AgentRuntimeHost,
): Promise<BashApprovalResult> {
  if (streamId && isApprovalBypassedForStream(streamId)) {
    return { accepted: true };
  }

  const requestId = `bash-${Date.now().toString(36)}-${++approvalCounter}`;

  try {
    return await new Promise<BashApprovalResult>((resolve) => {
      let settled = false;
      const settle = (result: BashApprovalResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      bashApprovalController.registerPending(requestId, {
        streamId,
        settle,
        isSettled: () => settled,
      });

      runtimeHost.emit('requestEnsureProgressView', {});

      // Activate the stream that needs approval so user sees the prompt immediately
      if (streamId) {
        runtimeHost.emit('setActiveStream', { streamId });
      }

      runtimeHost.emit('showBashPermission', {
        requestId,
        command: request.command,
        allowBypass: true,
        streamId: streamId ?? '',
      });
    });
  } finally {
    bashApprovalController.unregisterPending(requestId);
    runtimeHost.emit('resolveBashPermission', { requestId });
  }
}

export async function handleProgressViewBashApprovalAction(payload: {
  requestId: string;
  action: BashApprovalAction;
  feedback?: string;
}): Promise<void> {
  const entry = bashApprovalController.getPending(payload.requestId);
  if (!entry || entry.isSettled()) return;

  entry.settle({
    accepted: payload.action === 'approve',
    userMessage:
      payload.action === 'reject' ? payload.feedback?.trim() : undefined,
  });
}

export function buildBashApprovalRejectedResult(
  command: string,
  userMessage?: string,
): ToolResult {
  const preview = truncateWithEllipsis(command, 60);
  const message = `User rejected bash command: ${preview}`;
  const feedback = userMessage?.trim();
  const result: ToolResult = {
    output: message,
    summary: message,
    error: message,
    isError: true,
  };
  if (feedback) {
    result.userInstruction = feedback;
  }
  return result;
}
