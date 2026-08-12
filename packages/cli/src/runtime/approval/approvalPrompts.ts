import PQueue from 'p-queue';

import { defaultSession } from '@agent/runtime/SessionHandle';
import { isRelayMonthlyLimitMessage } from '@common/errors/sdkError/relayDetection';
import {
  isChatGptSubscriptionLimitError,
  isCredentialExhausted,
  type AgentProposalPermission,
  type ExhaustionReason,
  type PlanApprovalPermission,
  type RetryPermission,
  type ApprovalDecision,
} from '@shared/schemas';
import {
  codingPlanForExhaustionReason,
  codingPlanForId,
  type CodingPlanSubscriptionId,
} from '@shared/codingPlanSubscriptions';

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

const CLI_PERSONAL_API_RETRY_HINT =
  'Use `/api personal` in the chat TUI, or press `k` on the retry prompt, to switch to your own API keys.';

const CLI_CHATGPT_SUBSCRIPTION_RETRY_HINT =
  'Use `/api personal` in the chat TUI, or press `k` on the retry prompt, to switch from your ChatGPT subscription to your own API keys.';

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

/**
 * The canonical action for a failed retry, decided once in one place. Every
 * `RetryPermission` maps to exactly one action; consumers (the retry modal's
 * switch decision, the retry request message, and the auto-switch) switch on
 * this instead of re-deriving precedence from overlapping predicates.
 * Precedence: a ChatGPT-subscription limit wins over a coding-plan
 * exhaustion, which wins over relay exhaustion.
 */
export type CliRetryAction =
  | 'disable-chatgpt'
  | `disable-coding-plan:${CodingPlanSubscriptionId}`
  | 'switch-to-personal'
  | 'none';

export function classifyCliRetryAction(
  payload: RetryPermission,
): CliRetryAction {
  const details = payload.errorDetails;
  if (isChatGptSubscriptionLimitError(details)) return 'disable-chatgpt';
  const codingPlan = codingPlanForExhaustionReason(details?.exhaustionReason);
  if (codingPlan) return `disable-coding-plan:${codingPlan.id}`;
  if (
    details != null &&
    isCredentialExhausted(details) &&
    (details.isRelayError === true ||
      isRelayMonthlyLimitMessage(payload.errorMessage))
  ) {
    return 'switch-to-personal';
  }
  return 'none';
}

/** The switch hint line for a retry action, or undefined for 'none'. */
export function cliRetryActionHint(action: CliRetryAction): string | undefined {
  if (action.startsWith('disable-coding-plan:')) {
    const id = action.slice(
      'disable-coding-plan:'.length,
    ) as CodingPlanSubscriptionId;
    const plan = codingPlanForId(id);
    return `Use \`/api personal\` in the chat TUI, or press \`k\` on the retry prompt, to switch from your ${plan.retrySourceName} to ${plan.retryFallbackName}.`;
  }
  if (action === 'disable-chatgpt') {
    return CLI_CHATGPT_SUBSCRIPTION_RETRY_HINT;
  }
  return action === 'switch-to-personal'
    ? CLI_PERSONAL_API_RETRY_HINT
    : undefined;
}

/** Whether a retry could be re-run against a personal API key. */
export function isCliApiSwitchableRetry(payload: RetryPermission): boolean {
  return classifyCliRetryAction(payload) !== 'none';
}

/**
 * The decision the retry modal's "use your own API key" action settles with.
 * Structurally the CLI's TUI `ApprovalDecision` (approvalQueue.ts) narrowed to
 * this action; declared here so the runtime approval layer does not import the
 * TUI state module. Not exported: consumers use the structural type through
 * {@link cliRetryApiSwitchDecision}'s return.
 */
interface CliRetryApiSwitchDecision {
  readonly accepted: true;
  readonly apiMode: 'personal';
  readonly disableChatGptSubscription?: boolean;
  readonly disableCodingPlan?: CodingPlanSubscriptionId;
}

/**
 * Map a failed retry to the subscription/plan toggle it disables. Every
 * switch flips API mode to personal keys; a subscription or coding-plan retry
 * additionally turns off the preference that routed onto the exhausted
 * credential. Drives off {@link classifyCliRetryAction} so the modal cannot
 * drift from the classifier.
 */
export function cliRetryApiSwitchDecision(
  payload: RetryPermission,
): CliRetryApiSwitchDecision {
  const action = classifyCliRetryAction(payload);
  if (action.startsWith('disable-coding-plan:')) {
    return {
      accepted: true,
      disableCodingPlan: action.slice(
        'disable-coding-plan:'.length,
      ) as CodingPlanSubscriptionId,
      apiMode: 'personal',
    };
  }
  if (action === 'disable-chatgpt') {
    return {
      accepted: true,
      disableChatGptSubscription: true,
      apiMode: 'personal',
    };
  }
  // A relay or ineligible retry has no subscription/plan toggle to turn off;
  // the switch only re-routes the retry onto personal keys.
  return { accepted: true, apiMode: 'personal' };
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
