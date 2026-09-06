import { Effect, Result } from 'effect';

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
import { effectRuntime } from '@platform/processRuntime';
import {
  type ApprovalDecision,
  type UserQuestionAnswers,
} from '@shared/schemas';
import { handleExternalInquiryAction } from '@tools/inquiry/inquiryActions';
import { type ToolEditApprovalResult } from '@tools/approval/toolEditApproval';
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

/**
 * Settle a policy-gated approval: take the caller's already-computed policy
 * settlement when there is one, otherwise prompt with the caller's content.
 * `prompted` distinguishes a human answer from an automatic settlement.
 */
const decideGated = Effect.fn('approvalAdapter.decideGated')(function* (
  context: CliContext,
  hooks: CliApprovalPromptHooks,
  immediate: ApprovalDecision | undefined,
  content: CliApprovalContent,
  options: { writeRejectionToStderr?: boolean } = {},
) {
  if (immediate) {
    return { decision: immediate as ApprovalDecision, prompted: false };
  }

  const decision = yield* askApproval(context, content, hooks);
  if (!decision.accepted && options.writeRejectionToStderr) {
    writeTextStderr(
      decision.userMessage
        ? `${content.summary}\n${decision.userMessage}`
        : content.summary,
    );
  }
  return { decision: decision as ApprovalDecision, prompted: true };
});

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

const askHeadlessUserQuestion = Effect.fn(
  'approvalAdapter.askHeadlessUserQuestion',
)(function* (
  payload: HostUserQuestionRequest,
  context: CliContext,
  hooks: CliApprovalPromptHooks,
) {
  const denial = settleHumanInputDenial(context);
  if (denial != null) {
    return {
      action: 'reject',
      reason: denial.reason,
    } as UserQuestionSettlement;
  }

  const answers: UserQuestionAnswers = {};
  const asked = yield* Effect.result(
    Effect.forEach(payload.questions, (question) =>
      Effect.gen(function* () {
        hooks.beforePrompt?.();
        const formatted = formatUserQuestionPrompt({
          ...payload,
          questions: [question],
        });
        const answer = yield* queueCliApprovalQuestion(context, {
          kind: 'approval',
          summary: payload.context
            ? `${payload.context}\n\n${formatted}`
            : formatted,
          prompt: 'Answer (blank to skip): ',
        });
        const parsed = parseUserQuestionAnswer(answer, question);
        if (parsed != null) answers[question.question] = parsed;
      }),
    ),
  );
  if (Result.isFailure(asked)) {
    logWarning(
      'cli.approval',
      `The CLI user-question prompt failed: ${toErrorMessage(asked.failure)}`,
    );
    return {
      action: 'reject',
      cause: 'CLI user question prompt failed.',
    } as UserQuestionSettlement;
  }

  if (Object.keys(answers).length === 0) {
    return {
      action: 'skip',
      feedback: USER_QUESTION_SKIPPED_FEEDBACK,
    } as UserQuestionSettlement;
  }
  return { action: 'submit', answers } as UserQuestionSettlement;
});

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
    async requestToolEditApproval(request) {
      // `HostInteractions` is the Promise-shaped host port; the CLI's prompt
      // programs run here, on the process runtime.
      const decision = await effectRuntime().runPromise(
        askApproval(context, buildToolEditApprovalContent(request), hooks),
      );
      return toToolEditResult(decision, request.proposedContent);
    },
    async requestBashApproval(request) {
      const decision = await effectRuntime().runPromise(
        askApproval(
          context,
          { summary: formatBashApprovalSummary(request) },
          hooks,
        ),
      );
      return toApprovalSettlement(decision);
    },
    async requestPlanApproval(request) {
      const { decision, prompted } = await effectRuntime().runPromise(
        decideGated(context, hooks, settleExecutable(context), {
          summary: `Plan approval requested:\n${JSON.stringify(request.plan, null, 2)}`,
        }),
      );
      return toPromptedApprovalSettlement(decision, prompted);
    },
    async requestAgentProposal(request: HostAgentProposalRequest) {
      const { decision, prompted } = await effectRuntime().runPromise(
        decideGated(
          context,
          hooks,
          settleExecutable(context),
          buildAgentProposalApprovalContent(request),
        ),
      );
      return toPromptedApprovalSettlement(decision, prompted);
    },
    async requestRetry(request: HostRetryRequest) {
      const immediate = settleRetry(request, context);
      // The pre-prompt hook fires here and again inside `askApproval`; that
      // double call is pre-existing retry behavior, not a bug to "fix".
      if (!immediate) hooks.beforePrompt?.();
      // The prompt surface owns the retry hint: the operator must see the
      // `/api personal` / coding-plan switch guidance in the prompt they
      // actually answer, not only in the pre-prompt stderr line.
      // `formatRetryRequestMessage` is the single retry formatter.
      const summary = formatRetryRequestMessage(request);
      writeTextStderr(summary);
      const { decision, prompted } = await effectRuntime().runPromise(
        decideGated(
          context,
          hooks,
          immediate,
          { summary },
          { writeRejectionToStderr: true },
        ),
      );
      return toRetryResult(decision, prompted);
    },
    askUserQuestion(request) {
      return effectRuntime().runPromise(
        askHeadlessUserQuestion(request, context, hooks),
      );
    },
    async openExternalInquiry(request) {
      await handleExternalInquiryAction({
        action: 'drop',
        threadId: request.threadId,
        turnIndex: request.transcript?.at(-1)?.turnIndex ?? 1,
        cause:
          'External inquiry is not available in non-TUI CLI runs: inquiry answers are delivered as asynchronous continuations, and this process cannot resume them after the run finalizes. Use texra chat for the inquiry panel, or ask_user_question for synchronous CLI input.',
      });
    },
    // Headless requests decide inline (policy or prompt hooks) — there is no
    // pending registry to cancel into.
    cancel: () => {},
  };
}
