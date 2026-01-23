// Local imports - agent types
import type { StreamTabId } from '@agent/types/IdentifierTypes';

// Local imports - utils
import { getCurrentToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import { getConfig } from '@utils/config';
import { bus } from '@eventBus/ProgressEventBus';

// Local file imports - use shared YOLO state
import { isApprovalBypassedForStream } from './toolEditApproval';

export interface BashApprovalRequest {
  command: string;
  streamId?: StreamTabId;
}

export interface BashApprovalResult {
  accepted: boolean;
  userMessage?: string;
}

export const BASH_APPROVAL_CONFIG_KEY = 'texra.toolUse.requireBashApproval';

/** All valid approval actions for bash prompts */
export const BASH_APPROVAL_ACTIONS = ['approve', 'reject'] as const;

export type BashApprovalAction = (typeof BASH_APPROVAL_ACTIONS)[number];

// Approval queue state
let queue: Promise<void> = Promise.resolve();
let approvalCounter = 0;
const pendingApprovals = new Map<
  string,
  { settle: (result: BashApprovalResult) => void; isSettled: () => boolean }
>();

export async function requestBashApproval(
  request: BashApprovalRequest,
): Promise<BashApprovalResult> {
  const approvalsEnabled = getConfig<boolean>(BASH_APPROVAL_CONFIG_KEY, true);

  // Resolve streamId from context if not provided
  const context = getCurrentToolFileInteractionContext();
  const streamId = request.streamId ?? context?.streamId;

  // Skip if globally disabled or YOLO mode active
  if (!approvalsEnabled || (streamId && isApprovalBypassedForStream(streamId))) {
    return { accepted: true };
  }

  // Enqueue to serialize approval prompts
  const operation = queue.then(() => showApprovalPrompt(request, streamId));
  queue = operation.then(() => {}, () => {});
  return operation;
}

async function showApprovalPrompt(
  request: BashApprovalRequest,
  streamId?: StreamTabId,
): Promise<BashApprovalResult> {
  const requestId = `bash-${Date.now().toString(36)}-${++approvalCounter}`;

  try {
    return await new Promise<BashApprovalResult>((resolve) => {
      let settled = false;
      pendingApprovals.set(requestId, {
        settle: (result) => { if (!settled) { settled = true; resolve(result); } },
        isSettled: () => settled,
      });

      void safeExecuteCommand('texra.showProgressView');
      bus.emit('showBashApprovalPrompt', {
        requestId,
        command: request.command,
        allowBypass: !(streamId && isApprovalBypassedForStream(streamId)),
        streamId: streamId ?? '',
      });
    });
  } finally {
    pendingApprovals.delete(requestId);
    bus.emit('resolveBashApprovalPrompt', { requestId });
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
    userMessage: payload.action === 'reject' ? payload.feedback?.trim() : undefined,
  });
}

export function buildBashApprovalRejectedResult(
  command: string,
  userMessage?: string,
): {
  output: string;
  summary: string;
  error: string;
  isError: true;
  userInstruction?: string;
} {
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
