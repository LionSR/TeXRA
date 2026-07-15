/** Shared conversions for settlements whose public result shape differs. */
import type {
  BashSettlement,
  HostBashApprovalResult,
  HostUserQuestionResult,
  UserQuestionSettlement,
} from './HostInteractions';

export function toBashApprovalResult(
  decision: BashSettlement,
): HostBashApprovalResult {
  return {
    accepted: decision.action === 'approve',
    timedOut: decision.action === 'timeout' ? true : undefined,
    // Deliberate alignment choice, not an oversight: `userMessage` exists to
    // explain a rejection back to the agent (see buildBashApprovalRejectedResult),
    // so it's scoped to the reject action alone. The pre-alignment desktop
    // implementation attached it to any action with truthy feedback (e.g. an
    // approve carrying a stray note) — that was drift, not a feature; an
    // approved command has no rejection reason to report.
    userMessage:
      decision.action === 'reject' ? decision.feedback?.trim() : undefined,
  };
}

export function toUserQuestionResult(
  decision: UserQuestionSettlement,
): HostUserQuestionResult {
  return decision.action === 'submit'
    ? { submitted: true, answers: decision.answers }
    : { submitted: false, feedback: decision.feedback };
}
