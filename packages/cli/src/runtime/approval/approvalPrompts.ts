import { Effect } from 'effect';

import { defaultSession } from '@agent/runtime';
import { warn as logWarning } from '@logger/logUtils';
import { getExhaustionReason } from '@shared/schemas';
import type { RetryPermission, ApprovalDecision } from '@shared/schemas';
import {
  quotaFallbackRouteForExhaustion,
  type QuotaFallbackRoute,
  type QuotaFallbackRouteId,
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

/** CLI-local extension that keeps host failures separate from user text. */
export type CliApprovalDecision = ApprovalDecision & {
  readonly rejectionCause?: string;
};

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
const warnedApprovalContexts = new WeakSet<CliContext>();

function onCliPromptLane(context: CliContext) {
  return withPerKeyLane(cliPromptLanes, context);
}

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

/**
 * The decision the retry modal's "use your own API key" action settles with.
 * Structurally the CLI's TUI `ApprovalDecision` (approvalQueue.ts) narrowed to
 * this action; declared here so the runtime approval layer does not import the
 * TUI state module. Not exported: consumers use the structural type through
 * {@link cliRetryApiSwitchDecision}'s return.
 */
interface CliRetryApiSwitchDecision {
  readonly accepted: true;
  readonly disableQuotaRoute?: QuotaFallbackRouteId;
}

/**
 * Map a failed retry to the quota-fallback route it disables: a catalogued
 * route turns off the preference that routed onto the exhausted credential
 * so the retry rebuilds onto the stored fallback key. Drives off
 * {@link cliRetryQuotaRoute} so the modal cannot drift from the classifier.
 */
export function cliRetryApiSwitchDecision(
  payload: RetryPermission,
): CliRetryApiSwitchDecision {
  const route = cliRetryQuotaRoute(payload);
  return {
    accepted: true,
    ...(route ? { disableQuotaRoute: route.id } : {}),
  };
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
      while (true) {
        hooks.beforePrompt?.();
        answer = yield* askCliApprovalQuestion(context, {
          kind: 'approval',
          summary: content.summary,
          prompt,
        });
        if (content.details == null || !isViewDetailsAnswer(answer)) {
          break;
        }
        writeTextStderr(safeTerminalText(content.details()));
      }

      const parsed = parseApprovalAnswer(answer);
      let feedback = parsed.feedback;
      if (!parsed.accepted && parsed.shouldPromptForFeedback) {
        hooks.beforePrompt?.();
        const feedbackAnswer = yield* askCliApprovalQuestion(context, {
          kind: 'approval',
          summary: '',
          prompt: 'Rejection feedback (optional, Enter to skip): ',
        });
        feedback = feedbackAnswer.trim() || undefined;
      }

      const decision: CliApprovalDecision = {
        accepted: parsed.accepted,
        userMessage: parsed.accepted ? undefined : feedback,
      };
      return decision;
    }),
  ).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logWarning(
          'cli.approval',
          `The CLI approval prompt failed: ${toErrorMessage(error)}`,
        );
        const failed: CliApprovalDecision = {
          accepted: false,
          rejectionCause: 'CLI approval prompt failed.',
        };
        return failed;
      }),
    ),
  );
});
