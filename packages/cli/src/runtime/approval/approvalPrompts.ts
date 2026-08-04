import PQueue from 'p-queue';

import { isRelayMonthlyLimitMessage } from '@common/errors/sdkErrorUtils';
import {
  isChatGptSubscriptionLimitError,
  isCredentialExhausted,
  type AgentProposalPermission,
  type ExhaustionReason,
  type PlanApprovalPermission,
  type RetryPermission,
  type ApprovalDecision,
} from '@shared/schemas';

import { type CliContext, type CliPromptRequest } from '../cliContext';
import { askCliQuestion } from '../logSinks';

/**
 * Approval requests the CLI can settle by policy (auto-approve / auto-deny)
 * or by prompting, as opposed to the human-input requests (user questions,
 * external inquiry) that always need a person. Both the headless adapter and
 * the TUI discriminate on this set.
 *
 * CLI-owned, not a runtime event vocabulary: nothing emits these names over
 * the runtime host. They are the discriminator for the CLI's own approval
 * prompts, and the payloads are the plain `@shared/schemas` permission shapes
 * the live `HostInteractions` requests already carry.
 */
export interface CliDecisionApprovalPayloads {
  showPlanApproval: PlanApprovalPermission;
  showAgentProposal: AgentProposalPermission;
  showRetryRequest: RetryPermission;
}

export type CliDecisionApprovalEvent = keyof CliDecisionApprovalPayloads;

export const CLI_PERSONAL_API_RETRY_HINT =
  'Use `/api personal` in the chat TUI, or press `k` on the retry prompt, to switch to personal API keys.';

export const CLI_CHATGPT_SUBSCRIPTION_RETRY_HINT =
  'Use `/api personal` in the chat TUI, or press `k` on the retry prompt, to switch from your ChatGPT subscription to personal API keys.';

export interface CliApprovalPromptHooks {
  readonly beforePrompt?: () => void;
}

const cliPromptQueues = new WeakMap<CliContext, PQueue>();

export function markApprovalDenied(context: CliContext): void {
  context.approvalDenied = true;
}

export function hasCliApprovalDenied(context: CliContext): boolean {
  return context.approvalDenied === true;
}

/** Whether the failed retry was a ChatGPT-subscription (Codex) usage limit, so
 *  the switch turns off the subscription preference rather than relay access. */
export function isCliChatGptSubscriptionRetry(
  payload: RetryPermission,
): boolean {
  return isChatGptSubscriptionLimitError(payload.errorDetails);
}

export function isCliApiSwitchableRetry(payload: RetryPermission): boolean {
  const details = payload.errorDetails;
  if (!details) return false;
  if (isChatGptSubscriptionLimitError(details)) return true;
  return (
    isCredentialExhausted(details) &&
    (details.isRelayError === true ||
      isRelayMonthlyLimitMessage(payload.errorMessage))
  );
}

export function appendCliApiSwitchHint(
  text: string,
  exhaustionReason?: ExhaustionReason,
): string {
  if (exhaustionReason !== 'relay-limit' && !isRelayMonthlyLimitMessage(text)) {
    return text;
  }
  if (text.includes('/api personal')) return text;
  return [text, CLI_PERSONAL_API_RETRY_HINT].join('\n');
}

function enqueueCliPrompt<T>(
  context: CliContext,
  prompt: () => Promise<T>,
): Promise<T> {
  let queue = cliPromptQueues.get(context);
  if (!queue) {
    queue = new PQueue({ concurrency: 1 });
    cliPromptQueues.set(context, queue);
  }
  return queue.add(prompt);
}

async function askCliApprovalQuestion(
  context: CliContext,
  request: CliPromptRequest,
): Promise<string> {
  if (context.approvalPrompt) {
    return context.approvalPrompt(request);
  }
  return askCliQuestion(
    request.summary ? `${request.summary}\n${request.prompt}` : request.prompt,
  );
}

interface ParsedApprovalAnswer {
  readonly accepted: boolean;
  readonly feedback?: string;
  readonly shouldPromptForFeedback: boolean;
}

function parseApprovalAnswer(answer: string): ParsedApprovalAnswer {
  const trimmed = answer.trim();
  const normalized = trimmed.toLowerCase();
  if (normalized === 'y' || normalized === 'yes') {
    return { accepted: true, shouldPromptForFeedback: false };
  }

  if (normalized === '') {
    return { accepted: false, shouldPromptForFeedback: false };
  }

  const rejectMatch = /^(?:n|no)(?:\s+(.+))?$/i.exec(trimmed);
  if (rejectMatch) {
    const feedback = rejectMatch[1]?.trim();
    return {
      accepted: false,
      ...(feedback ? { feedback } : {}),
      shouldPromptForFeedback: feedback == null,
    };
  }

  return {
    accepted: false,
    feedback: trimmed,
    shouldPromptForFeedback: false,
  };
}

/**
 * Queue a CLI prompt against the context's serial prompt queue. Exposed so the
 * user-question handler can interleave its own per-question prompts with
 * approval prompts without overlapping reads from a single stdin.
 */
export function queueCliApprovalQuestion(
  context: CliContext,
  request: CliPromptRequest,
): Promise<string> {
  return enqueueCliPrompt(context, () =>
    askCliApprovalQuestion(context, request),
  );
}

export async function askApproval(
  context: CliContext,
  summary: string,
  hooks: CliApprovalPromptHooks = {},
): Promise<ApprovalDecision> {
  let answer: string;
  try {
    hooks.beforePrompt?.();
    answer = await queueCliApprovalQuestion(context, {
      kind: 'approval',
      summary,
      prompt: 'Approve? [y/N, or n <feedback>] ',
    });
  } catch {
    markApprovalDenied(context);
    return { accepted: false, userMessage: 'CLI approval prompt failed.' };
  }

  const parsed = parseApprovalAnswer(answer);
  let feedback = parsed.feedback;
  if (!parsed.accepted && parsed.shouldPromptForFeedback) {
    try {
      hooks.beforePrompt?.();
      const feedbackAnswer = await queueCliApprovalQuestion(context, {
        kind: 'approval',
        summary: '',
        prompt: 'Rejection feedback (optional, Enter to skip): ',
      });
      feedback = feedbackAnswer.trim() || undefined;
    } catch {
      feedback = undefined;
    }
  }

  if (!parsed.accepted) markApprovalDenied(context);
  return {
    accepted: parsed.accepted,
    userMessage: parsed.accepted
      ? undefined
      : feedback || 'Rejected from CLI approval prompt.',
  };
}
