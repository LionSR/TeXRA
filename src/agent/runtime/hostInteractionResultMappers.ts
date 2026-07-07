/**
 * Shared mapping from the generic `HostInteractionResolution` — used both to
 * settle a live UI action and to synthesize a cancellation/dispose rejection
 * — into each interaction's own typed result.
 *
 * The extension and desktop `HostInteractions` implementations each own their
 * pending-request bookkeeping (that stays host-specific), but they must agree
 * on what a given `{ kind, action, value, feedback }` resolution *means* for
 * the agent. Both hosts call these functions instead of maintaining their own
 * copies, so the two hosts cannot silently re-diverge on that vocabulary.
 */

import type { UserQuestionAnswers } from '@shared/schemas';
import type {
  HostBashApprovalResult,
  HostInteractionResolution,
  HostUserQuestionResult,
  PlanApprovalResult,
  ProposalResult,
  RetryResult,
} from './HostInteractions';

export function toBashApprovalResult(
  result: HostInteractionResolution,
): HostBashApprovalResult {
  return {
    accepted: result.action === 'approve',
    timedOut: result.action === 'timeout' ? true : undefined,
    // Deliberate alignment choice, not an oversight: `userMessage` exists to
    // explain a rejection back to the agent (see buildBashApprovalRejectedResult),
    // so it's scoped to the reject action alone. The pre-alignment desktop
    // implementation attached it to any action with truthy feedback (e.g. an
    // approve carrying a stray note) — that was drift, not a feature; an
    // approved command has no rejection reason to report.
    userMessage:
      result.action === 'reject' ? result.feedback?.trim() : undefined,
  };
}

export function toPlanApprovalResult(
  result: HostInteractionResolution,
): PlanApprovalResult {
  if (result.action === 'approve') return { action: 'approve' };
  if (result.action === 'approve_and_goal')
    return { action: 'approve_and_goal' };
  return { action: 'reject', feedback: result.feedback };
}

const PROPOSAL_RESULT_ACTIONS: ReadonlySet<ProposalResult['action']> = new Set([
  'approve',
  'setup',
  'reject',
  'timeout',
]);

function isProposalResultValue(value: unknown): value is ProposalResult {
  if (typeof value !== 'object' || value === null) return false;
  if (!Object.hasOwn(value, 'action')) return false;
  const { action } = value as { action: unknown };
  return (
    typeof action === 'string' &&
    PROPOSAL_RESULT_ACTIONS.has(action as ProposalResult['action'])
  );
}

/**
 * `result.value` may already carry a fully-formed `ProposalResult` (e.g. from
 * `ProgressAgentProposalController.handleAction`); only trust it when its
 * `action` is one this union actually declares, otherwise fall back to
 * `result.action`/`result.feedback` like every other mapper here. A bare
 * pass-through of "any object with an `action` key" would let an unrelated
 * caller shape masquerade as a proposal result.
 */
export function toProposalResult(
  result: HostInteractionResolution,
): ProposalResult {
  if (isProposalResultValue(result.value)) return result.value;
  if (result.action === 'setup') return { action: 'setup' };
  if (result.action === 'approve') return { action: 'approve' };
  return { action: 'reject', feedback: result.feedback };
}

export function toRetryResult(result: HostInteractionResolution): RetryResult {
  return result.action === 'retry'
    ? { action: 'retry', feedback: result.feedback }
    : { action: 'cancel' };
}

export function toUserQuestionResult(
  result: HostInteractionResolution,
): HostUserQuestionResult {
  return {
    submitted: result.action === 'submit',
    // Deliberate alignment choice, not an oversight: answers only make sense
    // once submitted, and feedback is the "why did you decline" text for a
    // non-submit action — the two are mutually exclusive by what they mean,
    // not just by which action produced them. The pre-alignment desktop
    // implementation carried each field whenever its source value/feedback
    // was truthy, independent of the action, which could report answers on
    // a decline or feedback on a submission.
    answers:
      result.action === 'submit'
        ? (result.value as UserQuestionAnswers | undefined)
        : undefined,
    feedback: result.action === 'submit' ? undefined : result.feedback,
  };
}
