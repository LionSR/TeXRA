import { z } from 'zod';

import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { tryUseRunContext } from '@agent/runtime/RunContext';
import { StreamTabIdSchema, type StreamTabId } from '@shared/schemas';
import { BASH_APPROVAL_CONFIG_KEY } from '@shared/schemas/agentCliSettings';
import { type ToolResult } from '@shared/schemas/toolResult';
import {
  getRunContextStreamId,
  requireRuntimeHost,
} from '@tools/contextHelpers';
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
  /** Distinguishes a host-side interaction timeout from an explicit reject. */
  timedOut: z.boolean().optional(),
});
export type BashApprovalResult = z.infer<typeof BashApprovalResultSchema>;

const DEFAULT_BASH_REJECTION_INSTRUCTION =
  'Do not retry this rejected command or another approval-gated shell command for the same check. ' +
  'Continue without running it, use a non-shell method, or explain what approval would be needed.';

const DEFAULT_BASH_TIMEOUT_INSTRUCTION =
  'The approval request was not answered in time — this is not an explicit ' +
  'rejection. You may retry the command later if it is still needed, use a ' +
  'non-shell method, or continue without it.';

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
  const streamId = request.streamId ?? getRunContextStreamId(context);

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

  const interaction = runtimeHost.interactions?.requestBashApproval?.({
    command: request.command,
    ...(request.cwd ? { cwd: request.cwd } : {}),
    streamId,
  });
  if (!interaction) {
    throw new Error('HostInteractions.requestBashApproval is required');
  }
  return interaction;
}

export function buildBashApprovalRejectedResult(
  command: string,
  userMessage?: string,
  timedOut?: boolean,
): ToolResult {
  const preview = truncateWithEllipsis(command, 60);
  const message = timedOut
    ? `Bash command approval timed out: ${preview}`
    : `User rejected bash command: ${preview}`;
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
