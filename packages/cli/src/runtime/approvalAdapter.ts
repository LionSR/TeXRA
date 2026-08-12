import { defaultSession } from '@agent/runtime/SessionHandle';
import type {
  HostAgentProposalRequest,
  HostApprovalBypassStateUpdate,
  HostInteractions,
  HostRetryRequest,
  HostUserQuestionRequest,
  RetryResult,
  UserQuestionSettlement,
} from '@agent/runtime/HostInteractions';
import {
  type AgentProposalPermission,
  type ApprovalDecision,
  type PlanApprovalPermission,
  type RetryPermission,
  type UserQuestionAnswers,
} from '@shared/schemas';
import { handleExternalInquiryAction } from '@tools/inquiry/inquiryActions';
import {
  type ToolEditApprovalRequest,
  type ToolEditApprovalResult,
} from '@tools/approval/toolEditApproval';
import {
  settleExecutable,
  settleHumanInputDenial,
  settleRetry,
} from './approval/settleApprovals';
import {
  type CliApprovalPromptHooks,
  type CliDecisionApprovalEvent,
  type CliDecisionApprovalPayloads,
  askApproval,
  queueCliApprovalQuestion,
} from './approval/approvalPrompts';
import {
  formatAgentProposalApprovalSummary,
  formatBashApprovalSummary,
  formatRetryRequestMessage,
  formatToolEditApprovalSummary,
  formatUserQuestionPrompt,
} from './approval/approvalSummaries';
import {
  parseUserQuestionAnswer,
  USER_QUESTION_SKIPPED_FEEDBACK,
} from './userQuestionAnswer';
import { type CliContext } from './cliContext';
import { writeTextStderr } from './logSinks';

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
  const decision = await askApproval(
    context,
    formatToolEditApprovalSummary(request),
    hooks,
  );
  return toToolEditResult(decision, request.proposedContent);
}

function summarizeApprovalEvent<K extends CliDecisionApprovalEvent>(
  event: K,
  payload: CliDecisionApprovalPayloads[K],
): string {
  switch (event) {
    case 'showPlanApproval': {
      const data = payload as PlanApprovalPermission;
      return `Plan approval requested:\n${JSON.stringify(data.plan, null, 2)}`;
    }
    case 'showAgentProposal': {
      const data = payload as AgentProposalPermission;
      return formatAgentProposalApprovalSummary(data);
    }
    case 'showRetryRequest': {
      // The prompt surface owns the retry hint: the operator must see the
      // `/api personal` / coding-plan switch guidance in the prompt they
      // actually answer, not only in the pre-prompt stderr line.
      // `formatRetryRequestMessage` is the single retry formatter.
      return formatRetryRequestMessage(payload as RetryPermission);
    }
    default: {
      const never: never = event;
      return String(never);
    }
  }
}

async function decideApprovalEvent<K extends CliDecisionApprovalEvent>(
  event: K,
  payload: CliDecisionApprovalPayloads[K],
  context: CliContext,
  hooks: CliApprovalPromptHooks,
  options: { writeRejectionToStderr?: boolean } = {},
): Promise<{ decision: ApprovalDecision; prompted: boolean }> {
  const immediate =
    event === 'showRetryRequest'
      ? settleRetry(payload as RetryPermission, context)
      : settleExecutable(context);

  if (event === 'showRetryRequest') {
    const data = payload as RetryPermission;
    if (!immediate) hooks.beforePrompt?.();
    writeTextStderr(formatRetryRequestMessage(data));
  }

  if (immediate) return { decision: immediate, prompted: false };

  const summary = summarizeApprovalEvent(event, payload);
  const decision = await askApproval(context, summary, hooks);
  if (!decision.accepted && options.writeRejectionToStderr) {
    writeTextStderr(
      decision.userMessage ? `${summary}\n${decision.userMessage}` : summary,
    );
  }
  return { decision, prompted: true };
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
  const denial = settleHumanInputDenial(context);
  if (denial != null) {
    return { action: 'reject', feedback: denial.userMessage };
  }

  const answers: UserQuestionAnswers = {};
  try {
    for (const question of payload.questions) {
      hooks.beforePrompt?.();
      const formatted = formatUserQuestionPrompt({
        ...payload,
        questions: [question],
      });
      const answer = await queueCliApprovalQuestion(context, {
        kind: 'approval',
        summary: payload.context
          ? `${payload.context}\n\n${formatted}`
          : formatted,
        prompt: 'Answer (blank to skip): ',
      });
      const parsed = parseUserQuestionAnswer(answer, question);
      if (parsed != null) answers[question.question] = parsed;
    }
  } catch {
    return {
      action: 'reject',
      feedback: 'CLI user question prompt failed.',
    };
  }

  if (Object.keys(answers).length === 0) {
    return { action: 'skip', feedback: USER_QUESTION_SKIPPED_FEEDBACK };
  }
  return { action: 'submit', answers };
}

export function createHeadlessCliHostInteractions(
  context: CliContext,
  hooks: HeadlessCliHostInteractionHooks = {},
): HostInteractions {
  // Headless composition seeds the session before attaching; tests often attach
  // without that step, so mirror the seed here. TUI uses a different adapter
  // and keeps the live session value from `/approval`.
  defaultSession().setApprovalPolicy(context.approvalPolicy);
  return {
    emit: hooks.emit,
    setApprovalBypassState: hooks.setApprovalBypassState,
    requestToolEditApproval(request) {
      return decideToolEdit(request, context, hooks);
    },
    async requestBashApproval(request) {
      const decision = await askApproval(
        context,
        formatBashApprovalSummary(request),
        hooks,
      );
      return toApprovalSettlement(decision);
    },
    async requestPlanApproval(request) {
      const { decision } = await decideApprovalEvent(
        'showPlanApproval',
        request,
        context,
        hooks,
      );
      return toApprovalSettlement(decision);
    },
    async requestAgentProposal(request: HostAgentProposalRequest) {
      const { decision } = await decideApprovalEvent(
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
      const { decision, prompted } = await decideApprovalEvent(
        'showRetryRequest',
        payload,
        context,
        hooks,
        { writeRejectionToStderr: true },
      );
      return toRetryResult(decision, prompted);
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
