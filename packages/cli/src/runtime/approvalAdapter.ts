// Public entry point for the CLI approval adapter. Internal CLI callers may
// import the focused modules under ./approval/ directly; this barrel keeps the
// stable surface for command modules, the TUI, and tests.

import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

import {
  setToolEditApprovalHandler,
  type ToolEditApprovalRequest,
  type ToolEditApprovalResult,
} from '@tools/approval/toolEditApproval';

import { isCliDecisionApprovalEvent } from './approvalEvents';
import { type CliContext } from './cliContext';
import { writeTextStderr } from './logSinks';

import {
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
  denyMessage,
  hasCliApprovalDenied,
  immediateDecision,
  immediateDecisionForApproval,
  isCliApiSwitchableRetry,
  markApprovalDenied,
} from './approval/approvalPolicy';
export {
  formatAgentProposalApprovalSummary,
  formatRetryRequestMessage,
  formatToolEditApprovalSummary,
} from './approval/approvalSummaries';

async function decideToolEdit(
  request: ToolEditApprovalRequest,
  context: CliContext,
): Promise<ToolEditApprovalResult> {
  const immediate = immediateDecision(context);
  if (immediate) {
    return immediate.accepted
      ? { accepted: true, appliedContent: request.proposedContent }
      : { accepted: false, userMessage: immediate.userMessage };
  }

  const decision = await askApproval(
    context,
    formatToolEditApprovalSummary(request),
  );
  return decision.accepted
    ? { accepted: true, appliedContent: request.proposedContent }
    : { accepted: false, userMessage: decision.userMessage };
}

export function installCliApprovalHandlers(context: CliContext): void {
  setToolEditApprovalHandler((request) => decideToolEdit(request, context));
}

export function handleCliApprovalEvent<K extends keyof ProgressEventPayloads>(
  event: K,
  payload: ProgressEventPayloads[K],
  context: CliContext,
): boolean {
  if (event === 'showExternalInquiry') {
    handleExternalInquiry(
      payload as ProgressEventPayloads['showExternalInquiry'],
      context,
    );
    return true;
  }

  if (event === 'showUserQuestion') {
    handleUserQuestion(
      payload as ProgressEventPayloads['showUserQuestion'],
      context,
    );
    return true;
  }

  if (!isCliDecisionApprovalEvent(event)) return false;

  const approvalPayload = payload as ProgressEventPayloads[typeof event];

  // Surface the upstream cause of every retry request before any auto-decision.
  // Without this, non-interactive runs (--print + never/yolo) lose the only
  // place the relay/provider error appears, leaving users with an opaque
  // "Node exceeded maximum manual retry limit" after the budget runs out.
  if (event === 'showRetryRequest') {
    const data = approvalPayload as ProgressEventPayloads['showRetryRequest'];
    writeTextStderr(formatRetryRequestMessage(data));
  }

  const immediate = immediateDecisionForApproval(
    event,
    approvalPayload,
    context,
  );
  if (immediate) {
    dispatchApprovalDecision(event, approvalPayload, immediate);
    return true;
  }

  void (async () => {
    const decision = await askApproval(
      context,
      summarizeApprovalEvent(event, approvalPayload),
    );
    dispatchApprovalDecision(event, approvalPayload, decision, {
      writeRejectionToStderr: true,
    });
  })();
  return true;
}
