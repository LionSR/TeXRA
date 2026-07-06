import { nanoid } from 'nanoid';
import { z } from 'zod';

import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { tryUseRunContext } from '@agent/runtime/RunContext';
import { StreamTabIdSchema, type StreamTabId } from '@shared/schemas';
import { BASH_APPROVAL_CONFIG_KEY } from '@shared/schemas/agentCliSettings';
import type { BashApprovalAction } from '@shared/schemas/prompts';
import { type ToolResult } from '@shared/schemas/toolResult';
import { requireRuntimeHost } from '@tools/contextHelpers';
import { getConfig } from '@utils/config/configUtils';
import { truncateWithEllipsis } from '@utils/text/stringUtils';

import { createStreamApprovalController } from './streamApprovalQueue';

const BashApprovalRequestSchema = z.object({
  command: z.string(),
  cwd: z.string().nullish(),
  streamId: StreamTabIdSchema.nullish(),
});
export type BashApprovalRequest = z.infer<typeof BashApprovalRequestSchema>;

const BashApprovalResultSchema = z.object({
  accepted: z.boolean(),
  userMessage: z.string().optional(),
});
export type BashApprovalResult = z.infer<typeof BashApprovalResultSchema>;

const DEFAULT_BASH_REJECTION_INSTRUCTION =
  'Do not retry this rejected command or another approval-gated shell command for the same check. ' +
  'Continue without running it, use a non-shell method, or explain what approval would be needed.';

export const bashApprovalController =
  createStreamApprovalController<BashApprovalResult>({
    rejectionResult: () => ({ accepted: false }),
    bypassEvent: 'updateBashApprovalBypassState',
  });

export function setBashApprovalSessionBypass(
  streamId: StreamTabId,
  enabled: boolean,
  runtimeHost: AgentRuntimeHost,
  options?: { silent?: boolean },
): void {
  bashApprovalController.bypass.setBypass(
    streamId,
    enabled,
    runtimeHost,
    options,
  );
}

export function toggleBashApprovalSessionBypass(
  streamId: StreamTabId,
  runtimeHost: AgentRuntimeHost,
): boolean {
  return bashApprovalController.bypass.toggleBypass(streamId, runtimeHost);
}

export function isBashApprovalBypassedForStream(
  streamId: StreamTabId,
): boolean {
  return bashApprovalController.bypass.isBypassed(streamId);
}

export async function requestBashApproval(
  request: BashApprovalRequest,
): Promise<BashApprovalResult> {
  const approvalsEnabled = getConfig<boolean>(BASH_APPROVAL_CONFIG_KEY, true);

  const context = tryUseRunContext();
  const streamId = request.streamId ?? context?.streamId;

  if (
    !approvalsEnabled ||
    (streamId && isBashApprovalBypassedForStream(streamId))
  ) {
    return { accepted: true };
  }

  const runtimeHost = requireRuntimeHost('bash approval', context);

  return bashApprovalController.enqueue(() =>
    showApprovalPrompt(request, streamId, runtimeHost),
  );
}

async function showApprovalPrompt(
  request: BashApprovalRequest,
  streamId: StreamTabId | undefined,
  runtimeHost: AgentRuntimeHost,
): Promise<BashApprovalResult> {
  if (streamId && isBashApprovalBypassedForStream(streamId)) {
    return { accepted: true };
  }

  const requestId = `bash-${nanoid()}`;

  const interaction = runtimeHost.interactions?.requestBashApproval?.({
    command: request.command,
    ...(request.cwd ? { cwd: request.cwd } : {}),
    streamId,
  });
  if (interaction) return interaction;

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
        runtimeHost,
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
        ...(request.cwd ? { cwd: request.cwd } : {}),
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
  return {
    status: 'error',
    summary: message,
    error: message,
    userInstruction: feedback || DEFAULT_BASH_REJECTION_INSTRUCTION,
  };
}
