import PQueue from 'p-queue';

import { defaultSession } from '@agent/runtime/SessionHandle';
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
import { askCliQuestion, writeTextStderr } from '../logSinks';

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
  'Use `/api personal` in the chat TUI, or press `k` on the retry prompt, to switch to your own API keys.';

export const CLI_CHATGPT_SUBSCRIPTION_RETRY_HINT =
  'Use `/api personal` in the chat TUI, or press `k` on the retry prompt, to switch from your ChatGPT subscription to your own API keys.';

/** Coding-plan exhaustion reasons whose retry hint names the regular endpoint. */
const CODING_PLAN_RETRY_HINTS: Readonly<Record<string, string>> = {
  'glm-coding-plan':
    'Use `/api personal` in the chat TUI, or press `k` on the retry prompt, to switch from your GLM Coding Plan to the regular GLM endpoint.',
  'kimi-code-subscription':
    'Use `/api personal` in the chat TUI, or press `k` on the retry prompt, to switch from your Kimi Code subscription to your own Moonshot API keys.',
};

/** Retry hint for an API-key-based coding-plan exhaustion, or undefined. */
export function codingPlanRetryHint(
  exhaustionReason: ExhaustionReason | undefined,
): string | undefined {
  return exhaustionReason
    ? CODING_PLAN_RETRY_HINTS[exhaustionReason]
    : undefined;
}

export interface CliApprovalPromptHooks {
  readonly beforePrompt?: () => void;
}

const cliPromptQueues = new WeakMap<CliContext, PQueue>();
const warnedApprovalContexts = new WeakSet<CliContext>();

/**
 * Tell the operator, once per run, that the policy closed a gate. The model
 * already receives the denial as tool feedback and routes around it, so this
 * is diagnostics only — a denied gate never changes the process exit code.
 *
 * Match settleApprovals: TUI `/approval` updates SessionHandle only, so the
 * frozen CliContext.approvalPolicy can be stale. Operator-facing warnings go
 * to stderr (not `@logger/logUtils`).
 */
export function warnApprovalDenied(context: CliContext, gate?: string): void {
  if (warnedApprovalContexts.has(context)) {
    return;
  }
  warnedApprovalContexts.add(context);
  const policy = defaultSession().approvalPolicy;
  writeTextStderr(
    `[warn] [cli-approval] ${gate?.trim() || 'Approval gate'} denied under policy "${policy}".`,
  );
}

/** Whether the failed retry was a ChatGPT-subscription (Codex) usage limit, so
 *  the switch turns off the subscription preference rather than relay access. */
export function isCliChatGptSubscriptionRetry(
  payload: RetryPermission,
): boolean {
  return isChatGptSubscriptionLimitError(payload.errorDetails);
}

/** Whether the failed retry was an API-key-based coding-plan usage limit (GLM
 *  Coding Plan, Kimi Code), so the switch turns off the plan's toggle. */
export function isCliCodingPlanRetry(payload: RetryPermission): boolean {
  return (
    codingPlanRetryHint(payload.errorDetails?.exhaustionReason) !== undefined
  );
}

export function isCliApiSwitchableRetry(payload: RetryPermission): boolean {
  const details = payload.errorDetails;
  if (!details) return false;
  if (isChatGptSubscriptionLimitError(details)) return true;
  if (isCliCodingPlanRetry(payload)) return true;
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
  let queue = cliPromptQueues.get(context);
  if (!queue) {
    queue = new PQueue({ concurrency: 1 });
    cliPromptQueues.set(context, queue);
  }
  return queue.add(() => askCliApprovalQuestion(context, request));
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

  return {
    accepted: parsed.accepted,
    userMessage: parsed.accepted
      ? undefined
      : feedback || 'Rejected from CLI approval prompt.',
  };
}
