import { Effect } from 'effect';

import { type SessionHandle } from '@agent/runtime';
import { withLogChannel } from '@logger/effectLog';
import type { TexraRetryApprovalDecision } from '@shared/approvalPolicy';
import { getExhaustionReason } from '@shared/schemas';
import type { RequestDecision, RetryPermission, RunId } from '@shared/schemas';
import {
  quotaFallbackRouteForExhaustion,
  type QuotaFallbackRoute,
} from '@shared/quotaFallbackRoutes';
import { isKimiCodeExclusiveRetryModel } from '@shared/model/kimiCodeRetryGate';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { type PerKeyLane, withPerKeyLane } from '@utils/core/perKeyQueue';

import { type CliContext, type CliPromptRequest } from '../cliContext';
import { askCliQuestion, writeTextStderr } from '../logSinks';
import { safeTerminalText } from '../terminalText';

const CHANNEL = 'cli.approval';

export interface CliApprovalPromptHooks {
  readonly beforePrompt?: () => void;
}

export interface CliApprovalContent {
  readonly summary: string;
  /** Complete content behind a bounded summary, shown only on request. */
  readonly details?: () => string;
}

/**
 * One prompt lane per CLI context: a single stdin, so two prompts never read
 * from it at once. Keyed weakly by the context, whose lifetime bounds it.
 */
const cliPromptLanes = new WeakMap<CliContext, PerKeyLane>();
/** Denials already warned per context, keyed by run and denial kind;
 *  a runless caller (no run id, or a payload's runless `''`) keys as `''`. */
const warnedApprovalRuns = new WeakMap<CliContext, Set<string>>();

function onCliPromptLane(context: CliContext) {
  return withPerKeyLane(cliPromptLanes, context);
}

/** What the policy closed, as the operator warning names it. */
type CliApprovalDenial =
  /** A Bash command or tool edit settled as denied. */
  | { readonly kind: 'executable' }
  /** Approval-gated tools withheld from the model when the run started. */
  | { readonly kind: 'withheldTools'; readonly tools: readonly string[] }
  /** The human retry permit after a model error. */
  | {
      readonly kind: 'retry';
      readonly deny: Exclude<TexraRetryApprovalDecision, 'present'>['deny'];
    }
  /** A question the model asked the user. */
  | { readonly kind: 'humanInput' };

/** Why no prompt could answer, from the live policy and this run's mode. */
function promptUnavailableReason(
  policy: SessionHandle['approvalPolicy'],
  context: CliContext,
): string {
  if (policy === 'never') return 'the approval policy is "never"';
  if (policy === 'ask' && context.mode === 'headless') {
    return 'no interactive prompt is available (approval policy "ask", headless run)';
  }
  return `the approval policy is "${policy}"`;
}

function retryDenialReason(
  deny: Extract<CliApprovalDenial, { kind: 'retry' }>['deny'],
  reason: string,
): string {
  switch (deny) {
    case 'credential':
      return 'the credential is exhausted or unauthorized';
    case 'yolo-retry':
      return 'automatic retries are exhausted, and the yolo policy does not approve a retry past them';
    case 'policy':
    case 'unpresentable':
      return `${reason}; a retry past the automatic attempts needs an interactive approval`;
  }
}

function approvalDenialMessage(
  denial: CliApprovalDenial,
  policy: SessionHandle['approvalPolicy'],
  context: CliContext,
): string {
  const reason = promptUnavailableReason(policy, context);
  const allow =
    context.mode === 'headless'
      ? 'Use --approval-policy yolo to allow'
      : 'Change the policy with /approval to allow';
  switch (denial.kind) {
    case 'executable':
      return `Command or edit denied: ${reason}. ${allow} it.`;
    case 'withheldTools':
      return `Not offering ${denial.tools.join(', ')} to the model: they need approval, and ${reason}. ${allow} them.`;
    case 'retry':
      return `Model error retry not attempted: ${retryDenialReason(denial.deny, reason)}.`;
    case 'humanInput':
      return `Question for the user not asked: ${reason}.`;
  }
}

/**
 * Tell the operator, once per run and denial kind (for withheld tools, once
 * per distinct tool list), that the policy closed a gate, what it closed, and
 * why. Keyed by `runId` within one context, so
 * concurrent runs sharing the chat TUI's session context each warn once; a
 * runless caller warns once per context. The model already receives the
 * denial as tool feedback and routes around it, so this is diagnostics only —
 * a denied gate never changes the process exit code.
 *
 * Match settleApprovals: TUI `/approval` updates SessionHandle only, so the
 * frozen CliContext.approvalPolicy can be stale — the warning names the live
 * policy read off the threaded `session`. Operator-facing warnings go
 * to stderr (not the diagnostic log).
 */
export function warnApprovalDenied(
  session: SessionHandle,
  context: CliContext,
  denial: CliApprovalDenial,
  runId?: RunId | '',
): void {
  let warned = warnedApprovalRuns.get(context);
  if (!warned) warnedApprovalRuns.set(context, (warned = new Set()));
  // Withheld tools key by their names too: a delegated child reports through
  // its parent's callback, and the tools it adds are a new denial.
  const detail = denial.kind === 'withheldTools' ? denial.tools.join(',') : '';
  const key = `${runId ?? ''}\0${denial.kind}\0${detail}`;
  if (warned.has(key)) return;
  warned.add(key);
  writeTextStderr(
    `[warn] [cli-approval] ${approvalDenialMessage(denial, session.approvalPolicy, context)}`,
  );
}

/**
 * The quota-fallback route a failed retry would switch off, decided once in
 * one place, or `undefined` when the retry offers no API-key switch. Consumers
 * (the retry modal's switch decision, the retry request message, and the
 * auto-switch) read this instead of re-deriving precedence from overlapping
 * predicates.
 */
export function cliRetryQuotaRoute(
  payload: RetryPermission,
): QuotaFallbackRoute | undefined {
  const details = payload.errorDetails;
  const route = quotaFallbackRouteForExhaustion(getExhaustionReason(details));
  if (!route) return undefined;
  // Kimi Code-exclusive models are served only by the coding endpoint, so
  // turning the plan off cannot reroute them to a Moonshot fallback. They
  // keep the retry modal without an API-key switch, exactly like the
  // auto-switch gate in the TUI.
  if (route.id === 'kimiCode' && isKimiCodeExclusiveRetryModel(payload.model)) {
    return undefined;
  }
  return route;
}

/** The switch hint line for a retry's quota route, or undefined when there is none. */
export function cliRetryActionHint(
  route: QuotaFallbackRoute | undefined,
): string | undefined {
  if (!route) return undefined;
  return `Press \`k\` on the retry prompt to switch from your ${route.retrySourceName} to ${route.retryFallbackName}.`;
}

/** Whether a retry could be re-run against a personal API key. */
export function isCliApiSwitchableRetry(payload: RetryPermission): boolean {
  return cliRetryQuotaRoute(payload) !== undefined;
}

const askCliApprovalQuestion = Effect.fn(
  'approvalPrompts.askCliApprovalQuestion',
)(function* (context: CliContext, request: CliPromptRequest) {
  // The injected prompt is a Promise port the tests supply; the terminal
  // prompt is already an Effect, so only the former needs a lift.
  const injected = context.approvalPrompt;
  return injected
    ? yield* Effect.tryPromise({
        try: () => injected(request),
        catch: (cause) => cause as Error,
      })
    : yield* askCliQuestion(
        request.summary
          ? `${request.summary}\n${request.prompt}`
          : request.prompt,
      );
});

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

function isViewDetailsAnswer(answer: string): boolean {
  return /^v(?:iew)?$/i.test(answer.trim());
}

/**
 * Run a CLI prompt on the context's serial prompt lane. Exposed so the
 * user-question handler can interleave its own per-question prompts with
 * approval prompts without overlapping reads from a single stdin.
 */
export function queueCliApprovalQuestion(
  context: CliContext,
  request: CliPromptRequest,
) {
  return onCliPromptLane(context)(askCliApprovalQuestion(context, request));
}

export const askApproval = Effect.fn('approvalPrompts.askApproval')(function* (
  context: CliContext,
  content: CliApprovalContent,
  hooks: CliApprovalPromptHooks = {},
) {
  return yield* onCliPromptLane(context)(
    Effect.gen(function* () {
      const prompt = content.details
        ? 'Approve? [y/N, v view full, or n <feedback>] '
        : 'Approve? [y/N, or n <feedback>] ';
      let answer: string;
      // The hook prepares the terminal and `content.details()` renders
      // caller-supplied content, so either can throw. Left as bare calls
      // inside the gen their throw is a defect, which the `Effect.catch`
      // below does not see: the rejection decision it settles would be
      // skipped and `runPromise` would abort the tool and the session, where
      // the outer try/catch this replaced settled it. `Effect.try` puts them
      // back in the failure channel, and unlike catching the whole cause it
      // leaves interruption free to propagate.
      const beforePrompt = Effect.try({
        try: () => hooks.beforePrompt?.(),
        catch: ensureError,
      });
      while (true) {
        yield* beforePrompt;
        answer = yield* askCliApprovalQuestion(context, {
          kind: 'approval',
          summary: content.summary,
          prompt,
        });
        const details = content.details;
        if (details == null || !isViewDetailsAnswer(answer)) {
          break;
        }
        yield* Effect.try({
          try: () => writeTextStderr(safeTerminalText(details())),
          catch: ensureError,
        });
      }

      const parsed = parseApprovalAnswer(answer);
      let feedback = parsed.feedback;
      if (!parsed.accepted && parsed.shouldPromptForFeedback) {
        yield* beforePrompt;
        const feedbackAnswer = yield* askCliApprovalQuestion(context, {
          kind: 'approval',
          summary: '',
          prompt: 'Rejection feedback (optional, Enter to skip): ',
        });
        feedback = feedbackAnswer.trim() || undefined;
      }

      const decision: RequestDecision = parsed.accepted
        ? { action: 'approve' }
        : { action: 'reject', feedback: feedback ?? null };
      return decision;
    }),
  ).pipe(
    Effect.catch((error) => {
      // A prompt that never reached a person closes the request rather
      // than speaking for one: the cause says so.
      const failed: RequestDecision = {
        action: 'cancel',
        cause: 'CLI approval prompt failed.',
      };
      return Effect.logWarning(
        `The CLI approval prompt failed: ${toErrorMessage(error)}`,
      ).pipe(withLogChannel(CHANNEL), Effect.as(failed));
    }),
  );
});
