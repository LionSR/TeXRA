// The headless CLI's `HostInteractions` implementation. Approval policy and
// summary formatting live in the focused modules under ./approval/; import
// those directly.

import type {
  HostAgentProposalRequest,
  HostApprovalBypassStateUpdate,
  HostInteractions,
  HostRetryRequest,
  HostUserQuestionRequest,
  RetryResult,
  UserQuestionSettlement,
} from '@agent/runtime/HostInteractions';
import type { RetryPermission, UserQuestionAnswers } from '@shared/schemas';

import { handleExternalInquiryAction } from '@tools/inquiry/ExternalInquiryTool';
import { prepareBashApprovalPrompt } from '@tools/approval/bashApproval';
import {
  type ToolEditApprovalRequest,
  type ToolEditApprovalResult,
} from '@tools/approval/toolEditApproval';

import { type CliContext } from './cliContext';
import { writeTextStderr } from './logSinks';

import {
  type ApprovalDecision,
  type CliApprovalPromptHooks,
  type CliDecisionApprovalEvent,
  type CliDecisionApprovalPayloads,
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
import { parseUserQuestionAnswer } from './userQuestionAnswer';

interface HeadlessCliHostInteractionHooks extends CliApprovalPromptHooks {
  readonly emit?: HostInteractions['emit'];
  readonly setApprovalBypassState?: (
    update: HostApprovalBypassStateUpdate,
  ) => void;
}

export function toToolEditResult(
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
  payload: CliDecisionApprovalPayloads[K],
  context: CliContext,
  hooks: CliApprovalPromptHooks,
  options: { writeRejectionToStderr?: boolean } = {},
): Promise<ApprovalDecision> {
  const immediate = immediateDecisionForApproval(event, payload, context);

  if (event === 'showRetryRequest') {
    const data = payload as RetryPermission;
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

/** Approve/reject settlement shared by the bash, plan, and proposal ports of
 *  both CLI hosts — none of them offers the extra actions their result unions
 *  allow, except the TUI's plan `approve_and_goal`, which the TUI overlays on
 *  the approve branch. A rejection without a user message omits `feedback`
 *  rather than sending an explicit `undefined`. */
export function toApprovalSettlement(
  decision: ApprovalDecision,
): { action: 'approve' } | { action: 'reject'; feedback?: string } {
  if (decision.accepted) return { action: 'approve' };
  return {
    action: 'reject',
    ...(decision.userMessage ? { feedback: decision.userMessage } : {}),
  };
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
): Promise<UserQuestionSettlement> {
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
      action: 'reject',
      feedback: 'CLI user question prompt failed.',
    };
  }

  if (Object.keys(answers).length === 0) {
    return { action: 'skip', feedback: 'User question skipped by user.' };
  }
  return { action: 'submit', answers };
}

export function createHeadlessCliHostInteractions(
  context: CliContext,
  hooks: HeadlessCliHostInteractionHooks = {},
): HostInteractions {
  return {
    emit: hooks.emit,
    setApprovalBypassState: hooks.setApprovalBypassState,
    requestToolEditApproval(request) {
      return decideToolEdit(request, context, hooks);
    },
    async requestBashApproval(request) {
      const decision = await decideApprovalEvent(
        'showBashPermission',
        prepareBashApprovalPrompt(request),
        context,
        hooks,
      );
      return toApprovalSettlement(decision);
    },
    async requestPlanApproval(request) {
      const decision = await decideApprovalEvent(
        'showPlanApproval',
        request,
        context,
        hooks,
      );
      return toApprovalSettlement(decision);
    },
    async requestAgentProposal(request: HostAgentProposalRequest) {
      const decision = await decideApprovalEvent(
        'showAgentProposal',
        request,
        context,
        hooks,
      );
      return toApprovalSettlement(decision);
    },
    async requestRetry(request: HostRetryRequest) {
      const payload: RetryPermission = {
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
