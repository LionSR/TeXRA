import { Effect } from 'effect';

import { defaultSession } from '@agent/runtime';
import { warn as logWarning } from '@logger/logUtils';
import { getExhaustionReason } from '@shared/schemas';
import type { RequestDecision, RetryPermission, RunId } from '@shared/schemas';
import {
  quotaFallbackRouteForExhaustion,
  type QuotaFallbackRoute,
} from '@shared/quotaFallbackRoutes';
import { isKimiCodeExclusiveRetryModel } from '@shared/model/kimiCodeRetryGate';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { type PerKeyLane, withPerKeyLane } from '@utils/core/perKeyQueue';

import { type CliContext, type CliPromptRequest } from '../cliContext';
import { askCliQuestion, writeTextStderr } from '../logSinks';
import { safeTerminalText } from '../terminalText';

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
/** Runs already warned per context; `undefined` stands for a runless caller
 *  (no run id, or a payload's runless `''`). */
const warnedApprovalRuns = new WeakMap<CliContext, Set<RunId | undefined>>();

function onCliPromptLane(context: CliContext) {
  return withPerKeyLane(cliPromptLanes, context);
}

/**
 * Tell the operator, once per run, that the policy closed a gate. Keyed by
 * `runId` within one context, so concurrent runs sharing the chat TUI's
 * session context each warn once; a runless caller warns once per context. The model
 * already receives the denial as tool feedback and routes around it, so this
 * is diagnostics only — a denied gate never changes the process exit code.
 *
 * Match settleApprovals: TUI `/approval` updates SessionHandle only, so the
 * frozen CliContext.approvalPolicy can be stale. Operator-facing warnings go
 * to stderr (not `@logger/logUtils`).
 */
export function warnApprovalDenied(
  context: CliContext,
  gate?: string,
  runId?: RunId | '',
): void {
  let warned = warnedApprovalRuns.get(context);
  if (!warned) warnedApprovalRuns.set(context, (warned = new Set()));
  const key = runId || undefined;
  if (warned.has(key)) return;
  warned.add(key);
  const policy = defaultSession().approvalPolicy;
  writeTextStderr(
    `[warn] [cli-approval] ${gate?.trim() || 'Approval gate'} denied under policy "${policy}".`,
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
  return yield* Effect.tryPromise({
    try: async () =>
      context.approvalPrompt
        ? context.approvalPrompt(request)
        : askCliQuestion(
            request.summary
              ? `${request.summary}\n${request.prompt}`
              : request.prompt,
          ),
    catch: (cause) => cause as Error,
  });
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
        catch: (cause) => cause,
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
          catch: (cause) => cause,
        });
      }

      const parsed = yield* Effect.try({
        try: () => parseApprovalAnswer(answer),
        catch: (cause) => cause,
      });
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
    Effect.catch((error) =>
      Effect.sync(() => {
        logWarning(
          'cli.approval',
          `The CLI approval prompt failed: ${toErrorMessage(error)}`,
        );
        // A prompt that never reached a person closes the request rather
        // than speaking for one: the cause says so.
        const failed: RequestDecision = {
          action: 'cancel',
          cause: 'CLI approval prompt failed.',
        };
        return failed;
      }),
    ),
  );
});
