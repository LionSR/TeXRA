import { getCurrentToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import type { ToolResult } from '@tools/result';
import { getConfig } from '@utils/config';
import { bus } from '@eventBus/ProgressEventBus';

import { isApprovalBypassedForStream } from './toolEditApproval';
import type { StreamTabId } from '@shared/schemas';

export interface BashApprovalRequest {
  command: string;
  streamId?: StreamTabId;
}

export interface BashApprovalResult {
  accepted: boolean;
  userMessage?: string;
}

export const BASH_APPROVAL_CONFIG_KEY = 'texra.toolUse.requireBashApproval';

export const BASH_APPROVAL_ACTIONS = ['approve', 'reject'] as const;

export type BashApprovalAction = (typeof BASH_APPROVAL_ACTIONS)[number];

export interface RejectablePendingEntry {
  streamId?: StreamTabId;
  isSettled: () => boolean;
  settle: (result: { accepted: false }) => void;
}

export function rejectPendingEntries<T extends RejectablePendingEntry>(
  entries: Iterable<T>,
  streamId?: StreamTabId,
): void {
  for (const entry of entries) {
    const matches = streamId === undefined || entry.streamId === streamId;
    if (matches && !entry.isSettled()) {
      entry.settle({ accepted: false });
    }
  }
}

let queue: Promise<void> = Promise.resolve();
let approvalCounter = 0;
const pendingApprovals = new Map<
  string,
  {
    streamId?: StreamTabId;
    settle: (result: BashApprovalResult) => void;
    isSettled: () => boolean;
  }
>();

export async function requestBashApproval(
  request: BashApprovalRequest,
): Promise<BashApprovalResult> {
  const approvalsEnabled = getConfig<boolean>(BASH_APPROVAL_CONFIG_KEY, true);

  // Resolve streamId from context if not provided
  const context = getCurrentToolFileInteractionContext();
  const streamId = request.streamId ?? context?.streamId;

  if (
    !approvalsEnabled ||
    (streamId && isApprovalBypassedForStream(streamId))
  ) {
    return { accepted: true };
  }

  const operation = queue.then(() => showApprovalPrompt(request, streamId));
  queue = operation.then(
    () => {},
    () => {},
  );
  return operation;
}

async function showApprovalPrompt(
  request: BashApprovalRequest,
  streamId?: StreamTabId,
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

      pendingApprovals.set(requestId, {
        streamId,
        settle,
        isSettled: () => settled,
      });

      void safeExecuteCommand('texra.showProgressView');
      bus.emit('showBashPermission', {
        requestId,
        command: request.command,
        allowBypass: true,
        streamId: streamId ?? '',
      });
    });
  } finally {
    pendingApprovals.delete(requestId);
    bus.emit('resolveBashPermission', { requestId });
  }
}

export async function handleProgressViewBashApprovalAction(payload: {
  requestId: string;
  action: BashApprovalAction;
  feedback?: string;
}): Promise<void> {
  const entry = pendingApprovals.get(payload.requestId);
  if (!entry || entry.isSettled()) return;

  entry.settle({
    accepted: payload.action === 'approve',
    userMessage:
      payload.action === 'reject' ? payload.feedback?.trim() : undefined,
  });
}

/** @internal Called by unified cleanup in toolEditApproval.ts */
export function _rejectPendingBashApprovalsForStream(
  streamId: StreamTabId,
): void {
  rejectPendingEntries(pendingApprovals.values(), streamId);
}

/** @internal Called by unified cleanup in toolEditApproval.ts */
export function _rejectAllPendingBashApprovals(): void {
  rejectPendingEntries(pendingApprovals.values());
}

export function buildBashApprovalRejectedResult(
  command: string,
  userMessage?: string,
): ToolResult {
  const preview = command.length > 60 ? `${command.slice(0, 57)}…` : command;
  const message = `User rejected bash command: ${preview}`;
  return {
    output: message,
    summary: message,
    error: message,
    isError: true,
    ...(userMessage?.trim() ? { userInstruction: userMessage.trim() } : {}),
  };
}
