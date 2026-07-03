// Public entry point for the CLI approval adapter. Internal CLI callers may
// import the focused modules under ./approval/ directly; this barrel keeps the
// stable surface for command modules, the TUI, and tests.

import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

import {
  type ToolEditApprovalRequest,
  type ToolEditApprovalResult,
} from '@tools/approval/toolEditApproval';
import { setActiveCliToolEditApprovalHandler } from './initPlatform';

import { isCliDecisionApprovalEvent } from './approvalEvents';
import { type CliContext } from './cliContext';
import { writeTextStderr } from './logSinks';

import {
  type ApprovalDecision,
  type CliApprovalPromptHooks,
  askApproval,
  immediateDecision,
  immediateDecisionForApproval,
} from './approval/approvalPolicy';
import {
  formatRetryRequestMessage,
  formatToolEditApprovalSummary,
} from './approval/approvalSummaries';
import {
  dispatchApprovalDecision,
  summarizeApprovalEvent,
} from './approval/eventDispatch';
import {
  handleExternalInquiry,
  handleUserQuestion,
} from './approval/humanInputHandlers';

export {
  type ApprovalDecision,
  appendCliApiSwitchHint,
  approvalPromptAllowed,
  CLI_CHATGPT_SUBSCRIPTION_RETRY_HINT,
  denyMessage,
  hasCliApprovalDenied,
  humanInputDenialFeedback,
  immediateDecision,
  immediateDecisionForApproval,
  isCliApiSwitchableRetry,
  isCliChatGptSubscriptionRetry,
  markApprovalDenied,
} from './approval/approvalPolicy';
export {
  formatAgentProposalApprovalSummary,
  formatRetryRequestMessage,
  formatToolEditApprovalSummary,
} from './approval/approvalSummaries';

function toToolEditResult(
  decision: ApprovalDecision,
  proposedContent: string,
): ToolEditApprovalResult {
  return decision.accepted
    ? { accepted: true, appliedContent: proposedContent }
    : { accepted: false, userMessage: decision.userMessage };
}

async function decideToolEdit(
  request: ToolEditApprovalRequest,
  context: CliContext,
  hooks: CliApprovalPromptHooks,
): Promise<ToolEditApprovalResult> {
  const immediate = immediateDecision(context);
  if (immediate) return toToolEditResult(immediate, request.proposedContent);

  const decision = await askApproval(
    context,
    formatToolEditApprovalSummary(request),
    hooks,
  );
  return toToolEditResult(decision, request.proposedContent);
}

export function installCliApprovalHandlers(
  context: CliContext,
  hooks: CliApprovalPromptHooks = {},
): () => void {
  setActiveCliToolEditApprovalHandler((request) =>
    decideToolEdit(request, context, hooks),
  );
  return () => {
    setActiveCliToolEditApprovalHandler(undefined);
  };
}

export function handleCliApprovalEvent<K extends keyof ProgressEventPayloads>(
  event: K,
  payload: ProgressEventPayloads[K],
  context: CliContext,
  hooks: CliApprovalPromptHooks = {},
): boolean {
  if (event === 'showExternalInquiry') {
    handleExternalInquiry(
      payload as ProgressEventPayloads['showExternalInquiry'],
      context,
      hooks,
    );
    return true;
  }

  if (event === 'showUserQuestion') {
    handleUserQuestion(
      payload as ProgressEventPayloads['showUserQuestion'],
      context,
      hooks,
    );
    return true;
  }

  if (!isCliDecisionApprovalEvent(event)) return false;

  const approvalPayload = payload as ProgressEventPayloads[typeof event];

  const immediate = immediateDecisionForApproval(
    event,
    approvalPayload,
    context,
  );

  // Surface the upstream cause of every retry request before any auto-decision.
  // Without this, non-interactive runs (--print + never/yolo) lose the only
  // place the relay/provider error appears, leaving users with an opaque
  // "Node exceeded maximum manual retry limit" after the budget runs out.
  if (event === 'showRetryRequest') {
    const data = approvalPayload as ProgressEventPayloads['showRetryRequest'];
    if (!immediate) hooks.beforePrompt?.();
    writeTextStderr(formatRetryRequestMessage(data));
  }

  if (immediate) {
    dispatchApprovalDecision(event, approvalPayload, immediate);
    return true;
  }

  void (async () => {
    const decision = await askApproval(
      context,
      summarizeApprovalEvent(event, approvalPayload),
      hooks,
    );
    dispatchApprovalDecision(event, approvalPayload, decision, {
      writeRejectionToStderr: true,
    });
  })();
  return true;
}
