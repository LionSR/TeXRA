// Public entry point for the CLI approval adapter. Internal CLI callers may
// import the focused modules under ./approval/ directly; this barrel keeps the
// stable surface for command modules, the TUI, and tests.

import type {
  HostAgentProposalRequest,
  HostBashApprovalResult,
  HostInteractions,
  HostRetryRequest,
  HostUserQuestionRequest,
  HostUserQuestionResult,
  PlanApprovalResult,
  ProposalResult,
  RetryResult,
} from '@agent/runtime/HostInteractions';
import type { RuntimeInteractionEventPayloads } from '@agent/runtime/runtimeInteractionEvents';
import type { UserQuestionAnswers } from '@shared/schemas';

import { handleExternalInquiryAction } from '@tools/inquiry/ExternalInquiryTool';
import {
  type ToolEditApprovalRequest,
  type ToolEditApprovalResult,
} from '@tools/approval/toolEditApproval';

import { type CliDecisionApprovalEvent } from './approvalEvents';
import { type CliContext } from './cliContext';
import { writeTextStderr } from './logSinks';

import {
  type ApprovalDecision,
  type CliApprovalPromptHooks,
  askApproval,
  askUserQuestionDenial,
  approvalPromptAllowed,
  immediateDecision,
  immediateDecisionForApproval,
  markApprovalDenied,
  queueCliApprovalQuestion,
} from './approval/approvalPolicy';
import {
  formatUserQuestionPrompt,
  formatRetryRequestMessage,
  formatToolEditApprovalSummary,
} from './approval/approvalSummaries';
import { summarizeApprovalEvent } from './approval/eventDispatch';
import { handleExternalInquiry } from './approval/humanInputHandlers';
import { parseUserQuestionAnswer } from './userQuestionAnswer';

export {
  appendCliApiSwitchHint,
  approvalPromptAllowed,
  askUserQuestionDenial,
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

async function decideApprovalEvent<K extends CliDecisionApprovalEvent>(
  event: K,
  payload: RuntimeInteractionEventPayloads[K],
  context: CliContext,
  hooks: CliApprovalPromptHooks,
  options: { writeRejectionToStderr?: boolean } = {},
): Promise<ApprovalDecision> {
  const immediate = immediateDecisionForApproval(event, payload, context);

  if (event === 'showRetryRequest') {
    const data = payload as RuntimeInteractionEventPayloads['showRetryRequest'];
    if (!immediate) hooks.beforePrompt?.();
    writeTextStderr(formatRetryRequestMessage(data));
  }

  if (immediate) return immediate;

  const summary = summarizeApprovalEvent(event, payload);
  const decision = await askApproval(context, summary, hooks);
  if (!decision.accepted && options.writeRejectionToStderr) {
    writeTextStderr(
      decision.userMessage ? `${summary}\n${decision.userMessage}` : summary,
    );
  }
  return decision;
}

function toBashResult(decision: ApprovalDecision): HostBashApprovalResult {
  return decision.accepted
    ? { accepted: true }
    : { accepted: false, userMessage: decision.userMessage };
}

function toPlanResult(decision: ApprovalDecision): PlanApprovalResult {
  return decision.accepted
    ? { action: 'approve' }
    : { action: 'reject', feedback: decision.userMessage };
}

function toProposalResult(decision: ApprovalDecision): ProposalResult {
  return decision.accepted
    ? { action: 'approve' }
    : { action: 'reject', feedback: decision.userMessage };
}

function toRetryResult(
  decision: ApprovalDecision,
  humanInputAvailable: boolean,
): RetryResult {
  if (decision.accepted) {
    return { action: 'retry', feedback: decision.userMessage };
  }
  // A non-accepted retry with no human available is a policy/headless
  // auto-denial (e.g. `--approval-policy never --no-input`), not a user
  // cancel — surface it as a distinct `deny` so a run that produces zero
  // output across all retries reports FAILED, not COMPLETED. See #7331.
  return humanInputAvailable
    ? { action: 'cancel' }
    : {
        action: 'deny',
        ...(decision.userMessage ? { reason: decision.userMessage } : {}),
      };
}

async function askHeadlessUserQuestion(
  payload: HostUserQuestionRequest,
  context: CliContext,
  hooks: CliApprovalPromptHooks,
): Promise<HostUserQuestionResult> {
  const denial = askUserQuestionDenial(context);
  if (denial) return denial;

  const answers: UserQuestionAnswers = {};
  try {
    for (const question of payload.questions) {
      hooks.beforePrompt?.();
      const answer = await queueCliApprovalQuestion(context, {
        kind: 'approval',
        summary: payload.context
          ? `${payload.context}\n\n${formatUserQuestionPrompt({
              ...payload,
              questions: [question],
            })}`
          : formatUserQuestionPrompt({ ...payload, questions: [question] }),
        prompt: 'Answer (blank to skip): ',
      });
      const parsed = parseUserQuestionAnswer(answer, question);
      if (parsed != null) answers[question.question] = parsed;
    }
  } catch {
    markApprovalDenied(context);
    return {
      submitted: false,
      feedback: 'CLI user question prompt failed.',
    };
  }

  if (Object.keys(answers).length === 0) {
    return { submitted: false, feedback: 'User question skipped by user.' };
  }
  return { submitted: true, answers };
}

export function createHeadlessCliHostInteractions(
  context: CliContext,
  hooks: CliApprovalPromptHooks = {},
): HostInteractions {
  return {
    requestToolEditApproval(request) {
      return decideToolEdit(request, context, hooks);
    },
    async requestBashApproval(request) {
      const payload: RuntimeInteractionEventPayloads['showBashPermission'] = {
        requestId: 'headless-bash',
        command: request.command,
        ...(request.cwd ? { cwd: request.cwd } : {}),
        allowBypass: true,
        streamId: request.streamId ?? '',
      };
      const decision = await decideApprovalEvent(
        'showBashPermission',
        payload,
        context,
        hooks,
      );
      return toBashResult(decision);
    },
    async requestPlanApproval(request) {
      const decision = await decideApprovalEvent(
        'showPlanApproval',
        request,
        context,
        hooks,
      );
      return toPlanResult(decision);
    },
    async requestAgentProposal(request: HostAgentProposalRequest) {
      const decision = await decideApprovalEvent(
        'showAgentProposal',
        request,
        context,
        hooks,
      );
      return toProposalResult(decision);
    },
    async requestRetry(request: HostRetryRequest) {
      const payload: RuntimeInteractionEventPayloads['showRetryRequest'] = {
        requestId: request.requestId,
        streamId: request.streamId,
        operation: request.operation,
        ...(request.model ? { model: request.model } : {}),
        ...(request.errorMessage ? { errorMessage: request.errorMessage } : {}),
        ...(request.errorDetails ? { errorDetails: request.errorDetails } : {}),
      };
      const decision = await decideApprovalEvent(
        'showRetryRequest',
        payload,
        context,
        hooks,
        { writeRejectionToStderr: true },
      );
      return toRetryResult(decision, approvalPromptAllowed(context));
    },
    askUserQuestion(request) {
      return askHeadlessUserQuestion(request, context, hooks);
    },
    async openExternalInquiry(request) {
      await handleExternalInquiryAction({
        action: 'drop',
        threadId: request.threadId,
        feedback:
          'External inquiry is not available in non-TUI CLI runs: inquiry answers are delivered as asynchronous continuations, and this process cannot resume them after the run finalizes. Use texra chat for the inquiry panel, or ask_user_question for synchronous CLI input.',
      });
      return { threadId: request.threadId };
    },
    // Headless requests decide inline (policy or prompt hooks) — there is no
    // pending registry to cancel into.
    cancel: () => {},
  };
}

export function handleCliApprovalEvent<
  K extends keyof RuntimeInteractionEventPayloads,
>(
  event: K,
  payload: RuntimeInteractionEventPayloads[K],
  context: CliContext,
  hooks: CliApprovalPromptHooks = {},
): boolean {
  if (event === 'showExternalInquiry') {
    handleExternalInquiry(
      payload as RuntimeInteractionEventPayloads['showExternalInquiry'],
      context,
      hooks,
    );
    return true;
  }

  return false;
}
