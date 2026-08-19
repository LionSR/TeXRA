import {
  defaultSession,
  type BashSettlement,
  type HostAgentProposalRequest,
  type HostApprovalBypassStateUpdate,
  type HostInteractions,
  type HostRetryRequest,
  type HostUserQuestionRequest,
  type RetryResult,
  type UserQuestionSettlement,
} from '@agent/runtime';
import { warn as logWarning } from '@logger/logUtils';
import {
  type ApprovalDecision,
  type UserQuestionAnswers,
} from '@shared/schemas';
import { handleExternalInquiryAction } from '@tools/inquiry/inquiryActions';
import {
  type ToolEditApprovalRequest,
  type ToolEditApprovalResult,
} from '@tools/approval/toolEditApproval';
import { assertNever } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  settleExecutable,
  settleHumanInputDenial,
  settleRetry,
} from './approval/settleApprovals';
import {
  type CliApprovalContent,
  type CliApprovalDecision,
  type CliApprovalPromptHooks,
  type CliDecisionApprovalRequest,
  askApproval,
  queueCliApprovalQuestion,
} from './approval/approvalPrompts';
import {
  buildAgentProposalApprovalContent,
  buildToolEditApprovalContent,
  formatBashApprovalSummary,
  formatRetryRequestMessage,
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
  decision: CliApprovalDecision,
  proposedContent: string,
): ToolEditApprovalResult {
  const settled = toApprovalSettlement(decision);
  return settled.action === 'approve'
    ? { action: 'apply', appliedContent: proposedContent }
    : settled;
}

async function decideToolEdit(
  request: ToolEditApprovalRequest,
  context: CliContext,
  hooks: CliApprovalPromptHooks,
): Promise<ToolEditApprovalResult> {
  const decision = await askApproval(
    context,
    buildToolEditApprovalContent(request),
    hooks,
  );
  return toToolEditResult(decision, request.proposedContent);
}

function summarizeApprovalEvent(
  request: CliDecisionApprovalRequest,
): CliApprovalContent {
  switch (request.type) {
    case 'showPlanApproval':
      return {
        summary: `Plan approval requested:\n${JSON.stringify(request.payload.plan, null, 2)}`,
      };
    case 'showAgentProposal':
      return buildAgentProposalApprovalContent(request.payload);
    case 'showRetryRequest':
      // The prompt surface owns the retry hint: the operator must see the
      // `/api personal` / coding-plan switch guidance in the prompt they
      // actually answer, not only in the pre-prompt stderr line.
      // `formatRetryRequestMessage` is the single retry formatter.
      return { summary: formatRetryRequestMessage(request.payload) };
    default:
      return assertNever(request, 'Unhandled CLI approval request kind');
  }
}

async function decideApprovalEvent(
  request: CliDecisionApprovalRequest,
  context: CliContext,
  hooks: CliApprovalPromptHooks,
  options: { writeRejectionToStderr?: boolean } = {},
): Promise<{ decision: ApprovalDecision; prompted: boolean }> {
  const isRetry = request.type === 'showRetryRequest';
  const immediate = isRetry
    ? settleRetry(request.payload, context)
    : settleExecutable(context);

  if (isRetry) {
    if (!immediate) hooks.beforePrompt?.();
    writeTextStderr(formatRetryRequestMessage(request.payload));
  }

  if (immediate) return { decision: immediate, prompted: false };

  const content = summarizeApprovalEvent(request);
  const decision = await askApproval(context, content, hooks);
  if (!decision.accepted && options.writeRejectionToStderr) {
    writeTextStderr(
      decision.userMessage
        ? `${content.summary}\n${decision.userMessage}`
        : content.summary,
    );
  }
  return { decision, prompted: true };
}

/** Approve/reject settlement shared by the bash, plan, proposal, and tool-edit
 *  ports of both CLI hosts — none of them offers the extra actions their result
 *  unions allow, except the TUI's plan `approve_and_goal`, which the TUI
 *  overlays on the approve branch. `BashSettlement` is the narrowest of those
 *  unions (`approve` plus a `RejectionProvenance` reject), so it is assignable
 *  to every one of them and the CLI does not re-declare the provenance channels
 *  that `RejectionProvenance` already owns. A rejection without a user message
 *  omits `feedback` rather than sending an explicit `undefined`. */
export function toApprovalSettlement(
  decision: ApprovalDecision & {
    readonly rejectionCause?: string;
    readonly rejectionReason?: string;
  },
): BashSettlement {
  if (decision.accepted) return { action: 'approve' };
  if (decision.rejectionCause !== undefined) {
    return { action: 'reject', cause: decision.rejectionCause };
  }
  if (decision.rejectionReason !== undefined) {
    return { action: 'reject', reason: decision.rejectionReason };
  }
  return {
    action: 'reject',
    ...(decision.userMessage && { feedback: decision.userMessage }),
  };
}

function toPromptedApprovalSettlement(
  decision: ApprovalDecision & { readonly rejectionCause?: string },
  prompted: boolean,
): BashSettlement {
  if (prompted || decision.accepted) return toApprovalSettlement(decision);
  return toApprovalSettlement({
    ...decision,
    rejectionReason: decision.userMessage ?? '',
    userMessage: undefined,
  });
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
    return { action: 'reject', reason: denial.reason };
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
  } catch (error) {
    logWarning(
      'cli.approval',
      `The CLI user-question prompt failed: ${toErrorMessage(error)}`,
    );
    return {
      action: 'reject',
      cause: 'CLI user question prompt failed.',
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
        { summary: formatBashApprovalSummary(request) },
        hooks,
      );
      return toApprovalSettlement(decision);
    },
    async requestPlanApproval(request) {
      const { decision, prompted } = await decideApprovalEvent(
        { type: 'showPlanApproval', payload: request },
        context,
        hooks,
      );
      return toPromptedApprovalSettlement(decision, prompted);
    },
    async requestAgentProposal(request: HostAgentProposalRequest) {
      const { decision, prompted } = await decideApprovalEvent(
        { type: 'showAgentProposal', payload: request },
        context,
        hooks,
      );
      return toPromptedApprovalSettlement(decision, prompted);
    },
    async requestRetry(request: HostRetryRequest) {
      const { decision, prompted } = await decideApprovalEvent(
        { type: 'showRetryRequest', payload: request },
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
        cause:
          'External inquiry is not available in non-TUI CLI runs: inquiry answers are delivered as asynchronous continuations, and this process cannot resume them after the run finalizes. Use texra chat for the inquiry panel, or ask_user_question for synchronous CLI input.',
      });
      return { threadId: request.threadId };
    },
    // Headless requests decide inline (policy or prompt hooks) — there is no
    // pending registry to cancel into.
    cancel: () => {},
  };
}
