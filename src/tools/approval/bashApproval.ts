// Third-party imports
import * as vscode from 'vscode';

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

interface PendingBashApprovalEntry {
  request: BashApprovalRequest;
  streamId?: StreamTabId;
  settle: (result: BashApprovalResult) => void;
  isSettled: () => boolean;
}

/** All valid approval actions for bash prompts */
export const BASH_APPROVAL_ACTIONS = ['approve', 'reject'] as const;

export type BashApprovalAction = (typeof BASH_APPROVAL_ACTIONS)[number];

interface BashApprovalActionPayload {
  requestId: string;
  action: BashApprovalAction;
  feedback?: string;
}

let queue: Promise<void> = Promise.resolve();
let initialized = false;
let customHandler:
  | ((request: BashApprovalRequest) => Promise<BashApprovalResult>)
  | undefined;
let approvalCounter = 0;
const pendingApprovals = new Map<string, PendingBashApprovalEntry>();

export function initializeBashApproval(): void {
  if (initialized) {
    return;
  }
  initialized = true;
}

export function setBashApprovalHandler(
  handler?: (request: BashApprovalRequest) => Promise<BashApprovalResult>,
): void {
  customHandler = handler;
}

async function showProgressViewApprovalPrompt(
  requestId: string,
  request: BashApprovalRequest,
): Promise<void> {
  await safeExecuteCommand('texra.showProgressView');
  const streamId = request.streamId;
  // Use shared YOLO state from toolEditApproval
  const isBypassed = streamId && isApprovalBypassedForStream(streamId);
  bus.emit('showBashApprovalPrompt', {
    requestId,
    command: request.command,
    allowBypass: !isBypassed,
    streamId: streamId ?? '',
  });
}

function resolveProgressViewApprovalPrompt(requestId: string): void {
  bus.emit('resolveBashApprovalPrompt', { requestId });
}

async function nativeRequestApproval(
  request: BashApprovalRequest,
): Promise<BashApprovalResult> {
  const { command, streamId } = request;

  approvalCounter += 1;
  const requestId = `bash-approval-${Date.now().toString(36)}-${approvalCounter}`;

  let result: BashApprovalResult = { accepted: false };
  try {
    result = await new Promise<BashApprovalResult>((resolve) => {
      let settled = false;

      const settle = (value: BashApprovalResult) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };

      const entry: PendingBashApprovalEntry = {
        request,
        streamId,
        isSettled: () => settled,
        settle,
      };

      pendingApprovals.set(requestId, entry);
      void showProgressViewApprovalPrompt(requestId, request);
    });

    return result;
  } finally {
    pendingApprovals.delete(requestId);
    resolveProgressViewApprovalPrompt(requestId);
  }
}

async function enqueueApproval(
  request: BashApprovalRequest,
): Promise<BashApprovalResult> {
  const run = async () =>
    customHandler ? customHandler(request) : nativeRequestApproval(request);

  const operation = queue.then(run);
  queue = operation.then(
    () => {},
    () => {},
  );
  return operation;
}

export async function requestBashApproval(
  request: BashApprovalRequest,
): Promise<BashApprovalResult> {
  const approvalsEnabled = getConfig<boolean>(BASH_APPROVAL_CONFIG_KEY, true);

  const context = getCurrentToolFileInteractionContext();
  const preparedRequest =
    request.streamId || !context?.streamId
      ? request
      : { ...request, streamId: context.streamId };

  // Check global config and shared YOLO mode (same as tool edits)
  const streamId = preparedRequest.streamId;
  const isStreamBypassed = streamId && isApprovalBypassedForStream(streamId);
  if (!approvalsEnabled || isStreamBypassed) {
    return { accepted: true };
  }

  return enqueueApproval(preparedRequest);
}

export async function handleProgressViewBashApprovalAction(
  payload: BashApprovalActionPayload,
): Promise<void> {
  const entry = pendingApprovals.get(payload.requestId);
  if (!entry || entry.isSettled()) {
    return;
  }

  switch (payload.action) {
    case 'approve': {
      entry.settle({ accepted: true });
      break;
    }

    case 'reject': {
      const userMessage = payload.feedback?.trim();
      entry.settle({
        accepted: false,
        userMessage: userMessage || undefined,
      });
      break;
    }
  }
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
  const commandPreview =
    command.length > 60 ? `${command.slice(0, 57)}…` : command;
  const baseMessage = `User rejected bash command: ${commandPreview}`;
  const feedback = userMessage?.trim();
  return {
    output: baseMessage,
    summary: baseMessage,
    error: baseMessage,
    isError: true,
    ...(feedback ? { userInstruction: feedback } : {}),
  };
}
