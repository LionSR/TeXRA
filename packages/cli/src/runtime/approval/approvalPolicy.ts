import type { HostUserQuestionResult } from '@agent/runtime/HostInteractions';
import type { RuntimeInteractionEventPayloads } from '@agent/runtime/runtimeInteractionEvents';
import { isRelayMonthlyLimitMessage } from '@common/errors/sdkErrorUtils';
import {
  isChatGptSubscriptionLimitError,
  isCredentialExhausted,
  type ExhaustionReason,
  type ApprovalDecision as SharedApprovalDecision,
} from '@shared/schemas';

import { type CliDecisionApprovalEvent } from '../approvalEvents';
import { type CliContext, type CliPromptRequest } from '../cliContext';
import { askCliQuestion } from '../logSinks';

// The headless adapter only ever sets accepted + userMessage, but reusing the
// host-neutral shape (which also carries optional userQuestionAnswers) keeps a
// single source of truth for the decision vocabulary across hosts. See
// docs/proposals/2026-05-31-tui-extension-sharing.md (Rung 1).
export type ApprovalDecision = SharedApprovalDecision;

export const CLI_PERSONAL_API_RETRY_HINT =
  'Use `/api personal` in the chat TUI, or press `k` on the retry prompt, to switch to personal API keys.';

export const CLI_CHATGPT_SUBSCRIPTION_RETRY_HINT =
  'Use `/api personal` in the chat TUI, or press `k` on the retry prompt, to switch from your ChatGPT subscription to personal API keys.';

export interface CliApprovalPromptHooks {
  readonly beforePrompt?: () => void;
}

const deniedApprovalContexts = new WeakSet<CliContext>();
const cliPromptQueues = new WeakMap<CliContext, Promise<unknown>>();

function denyMessage(policy: CliContext['approvalPolicy']): string {
  return policy === 'ask'
    ? 'Interactive approval requires a TTY; this CLI run is headless.'
    : 'Denied by CLI approval policy.';
}

export function markApprovalDenied(context: CliContext): void {
  deniedApprovalContexts.add(context);
}

export function hasCliApprovalDenied(context: CliContext): boolean {
  return deniedApprovalContexts.has(context);
}

/** Whether the failed retry was a ChatGPT-subscription (Codex) usage limit, so
 *  the switch turns off the subscription preference rather than relay access. */
export function isCliChatGptSubscriptionRetry(
  payload: RuntimeInteractionEventPayloads['showRetryRequest'],
): boolean {
  return isChatGptSubscriptionLimitError(payload.errorDetails);
}

export function isCliApiSwitchableRetry(
  payload: RuntimeInteractionEventPayloads['showRetryRequest'],
): boolean {
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

export function approvalPromptAllowed(context: CliContext): boolean {
  return context.approvalPolicy === 'ask' && context.mode === 'interactive';
}

function enqueueCliPrompt<T>(
  context: CliContext,
  prompt: () => Promise<T>,
): Promise<T> {
  const previous = cliPromptQueues.get(context) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(prompt);
  cliPromptQueues.set(
    context,
    next.catch(() => undefined),
  );
  return next;
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
 * inquiry/user-question handlers can interleave their own multi-step prompts
 * with approval prompts without overlapping reads from a single stdin.
 */
export function queueCliApprovalQuestion(
  context: CliContext,
  request: CliPromptRequest,
): Promise<string> {
  return enqueueCliPrompt(context, () =>
    askCliApprovalQuestion(context, request),
  );
}

export function immediateDecision(
  context: CliContext,
): ApprovalDecision | undefined {
  if (context.approvalPolicy === 'yolo') return { accepted: true };
  if (approvalPromptAllowed(context)) return undefined;
  markApprovalDenied(context);
  return { accepted: false, userMessage: denyMessage(context.approvalPolicy) };
}

/** Retry requests caused by exhausted credentials or auth failures need user
 *  action (key swap, top-up, re-login). Interactive runs must still surface the
 *  retry panel so the user can switch to personal API keys; non-interactive
 *  and auto-approval modes should not burn the retry budget. */
function isUnretryableRetryRequest(
  event: CliDecisionApprovalEvent,
  payload: RuntimeInteractionEventPayloads[CliDecisionApprovalEvent],
): boolean {
  if (event !== 'showRetryRequest') return false;
  const details = (
    payload as RuntimeInteractionEventPayloads['showRetryRequest']
  ).errorDetails;
  if (!details) return false;
  if (isCredentialExhausted(details)) return true;
  if (details.statusCode === 401 || details.statusCode === 403) return true;
  return false;
}

export function immediateDecisionForApproval(
  event: CliDecisionApprovalEvent,
  payload: RuntimeInteractionEventPayloads[CliDecisionApprovalEvent],
  context: CliContext,
): ApprovalDecision | undefined {
  if (isUnretryableRetryRequest(event, payload)) {
    if (approvalPromptAllowed(context)) return undefined;
    markApprovalDenied(context);
    return {
      accepted: false,
      userMessage: 'Retry skipped: credential exhausted or unauthorized.',
    };
  }
  return immediateDecision(context);
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

export function humanInputDenialFeedback(
  context: CliContext,
  yoloMessage: string,
): string {
  if (context.approvalPolicy === 'yolo') return yoloMessage;
  markApprovalDenied(context);
  return denyMessage(context.approvalPolicy);
}

/**
 * Shared "no human input available" guard for user-question requests, used
 * by both the headless adapter and the TUI approval queue. Returns the
 * unsubmitted result to hand straight back to the caller, or `undefined`
 * when a prompt is allowed and the caller should proceed.
 */
export function askUserQuestionDenial(
  context: CliContext,
): HostUserQuestionResult | undefined {
  if (approvalPromptAllowed(context)) return undefined;
  return {
    submitted: false,
    feedback: humanInputDenialFeedback(
      context,
      'User question requires human input; yolo mode cannot synthesize an answer.',
    ),
  };
}
