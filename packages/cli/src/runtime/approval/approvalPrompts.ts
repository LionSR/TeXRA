import PQueue from 'p-queue';

import { defaultSession } from '@agent/runtime';
import { warn as logWarning } from '@logger/logUtils';
import type {
  AgentProposalPermission,
  PlanApprovalPermission,
  RetryPermission,
  ApprovalDecision,
} from '@shared/schemas';
import {
  quotaFallbackRouteById,
  quotaFallbackRouteForExhaustion,
  type QuotaFallbackRouteId,
} from '@shared/quotaFallbackRoutes';
import { isKimiCodeExclusiveRetryModel } from '@shared/model/kimiCodeRetryGate';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { type CliContext, type CliPromptRequest } from '../cliContext';
import { askCliQuestion, writeTextStderr } from '../logSinks';
import { safeTerminalText } from '../terminalText';

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
 *
 * Carrying `type` and `payload` in one discriminated union (rather than two
 * separate `(event, payload)` parameters keyed off a generic) lets a
 * `switch (request.type)` narrow `request.payload` for free — no `as`
 * casts needed at the read sites.
 */
export type CliDecisionApprovalRequest =
  | {
      readonly type: 'showPlanApproval';
      readonly payload: PlanApprovalPermission;
    }
  | {
      readonly type: 'showAgentProposal';
      readonly payload: AgentProposalPermission;
    }
  | { readonly type: 'showRetryRequest'; readonly payload: RetryPermission };

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

const cliPromptQueues = new WeakMap<CliContext, PQueue>();
const warnedApprovalContexts = new WeakSet<CliContext>();

function cliPromptQueue(context: CliContext): PQueue {
  let queue = cliPromptQueues.get(context);
  if (!queue) {
    queue = new PQueue({ concurrency: 1 });
    cliPromptQueues.set(context, queue);
  }
  return queue;
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
 * The canonical action for a failed retry, decided once in one place. Every
 * `RetryPermission` maps to exactly one action; consumers (the retry modal's
 * switch decision, the retry request message, and the auto-switch) switch on
 * this instead of re-deriving precedence from overlapping predicates.
 */
export type CliRetryAction =
  `disable-quota-route:${QuotaFallbackRouteId}` | 'none';

const DISABLE_QUOTA_ROUTE_PREFIX = 'disable-quota-route:';

function quotaRouteIdFromAction(
  action: CliRetryAction,
): QuotaFallbackRouteId | undefined {
  if (!action.startsWith(DISABLE_QUOTA_ROUTE_PREFIX)) return undefined;
  return action.slice(
    DISABLE_QUOTA_ROUTE_PREFIX.length,
  ) as QuotaFallbackRouteId;
}

export function classifyCliRetryAction(
  payload: RetryPermission,
): CliRetryAction {
  const details = payload.errorDetails;
  const route = quotaFallbackRouteForExhaustion(details?.exhaustionReason);
  if (route) {
    // Kimi Code-exclusive models are served only by the coding endpoint, so
    // turning the plan off cannot reroute them to a Moonshot fallback. They
    // keep the retry modal without an API-key switch, exactly like the
    // auto-switch gate in the TUI.
    if (
      route.id === 'kimiCode' &&
      isKimiCodeExclusiveRetryModel(payload.model)
    ) {
      return 'none';
    }
    return `${DISABLE_QUOTA_ROUTE_PREFIX}${route.id}`;
  }
  return 'none';
}

/** The switch hint line for a retry action, or undefined for 'none'. */
export function cliRetryActionHint(action: CliRetryAction): string | undefined {
  const routeId = quotaRouteIdFromAction(action);
  if (routeId !== undefined) {
    const route = quotaFallbackRouteById(routeId);
    if (!route) return undefined;
    return `Press \`k\` on the retry prompt to switch from your ${route.retrySourceName} to ${route.retryFallbackName}.`;
  }
  return undefined;
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
  readonly disableQuotaRoute?: QuotaFallbackRouteId;
}

/**
 * Map a failed retry to the quota-fallback route it disables: a catalogued
 * route turns off the preference that routed onto the exhausted credential
 * so the retry rebuilds onto the stored fallback key. Drives off
 * {@link classifyCliRetryAction} so the modal cannot drift from the classifier.
 */
export function cliRetryApiSwitchDecision(
  payload: RetryPermission,
): CliRetryApiSwitchDecision {
  const action = classifyCliRetryAction(payload);
  const routeId = quotaRouteIdFromAction(action);
  if (routeId !== undefined) {
    return {
      accepted: true,
      disableQuotaRoute: routeId,
    };
  }
  return { accepted: true };
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

function isViewDetailsAnswer(answer: string): boolean {
  return /^v(?:iew)?$/i.test(answer.trim());
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
  return cliPromptQueue(context).add(() =>
    askCliApprovalQuestion(context, request),
  );
}

export async function askApproval(
  context: CliContext,
  content: CliApprovalContent,
  hooks: CliApprovalPromptHooks = {},
): Promise<CliApprovalDecision> {
  try {
    return await cliPromptQueue(context).add(async () => {
      const prompt = content.details
        ? 'Approve? [y/N, v view full, or n <feedback>] '
        : 'Approve? [y/N, or n <feedback>] ';
      let answer: string;
      while (true) {
        hooks.beforePrompt?.();
        answer = await askCliApprovalQuestion(context, {
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
        try {
          hooks.beforePrompt?.();
          const feedbackAnswer = await askCliApprovalQuestion(context, {
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
        userMessage: parsed.accepted ? undefined : feedback,
      };
    });
  } catch (error) {
    logWarning(
      'cli.approval',
      `The CLI approval prompt failed: ${toErrorMessage(error)}`,
    );
    return {
      accepted: false,
      rejectionCause: 'CLI approval prompt failed.',
    };
  }
}
