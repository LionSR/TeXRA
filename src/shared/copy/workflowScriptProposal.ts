import type { WorkflowCallIdentity } from '@shared/schemas';

interface WorkflowScriptPlan {
  readonly phases: readonly { readonly title: string }[];
  readonly tasks: readonly WorkflowCallIdentity[];
}

/**
 * Copy for the multi-agent workflow proposal, shared by every host so the
 * card never presents `meta.tasks` as resolved calls: those are plan labels,
 * and the calls the script actually issues appear only when it issues them.
 */
export const WORKFLOW_SCRIPT_PROPOSAL_COPY = {
  costWarning: 'Calls may run concurrently and incur high model cost.',
  declaredItemsNote:
    'Declared items are plan labels from the script; the actual calls appear when the script issues them.',
  dynamicCallsNote:
    'This script issues its calls at runtime; they appear when the script issues them.',
  filesHeading: 'Files available to the script',
  defaults: (agent: string, model: string): string =>
    `Defaults: ${agent} (${model}) — each call may name its own agent and model.`,
} as const;

/** Approve-menu items and CLI keys for reviewing a workflow's issued calls. */
export const WORKFLOW_CALL_REVIEW_COPY = {
  phase: 'Approve, review the first call of each phase',
  call: 'Approve, review each call',
  /** Footer-strip forms of `phase`/`call`, same role as
   *  `DELEGATION_APPROVAL_COPY.cliCompactAction`: the full copy never fits a
   *  key-hint row beside the approve/reject/always trio, and without a compact
   *  form the CLI footer drops these keys entirely. */
  phaseCompact: 'review/phase',
  callCompact: 'review/call',
  /** The body sentence that carries the full meaning of those two keys, since
   *  a narrow terminal still drops them from the footer. */
  cliReviewExplanation:
    'Press p to review the first call of each phase, or c to review every call.',
  callCardNote: (workflowName: string, phase: string | undefined): string =>
    phase === undefined
      ? `Issued by workflow ${workflowName}`
      : `Issued by workflow ${workflowName} · phase ${phase}`,
  phaseAdmitsNote: 'Approving admits every later call this phase issues.',
} as const;

/**
 * The context line for one issued call under review: which workflow and phase
 * issued it, then — when approving it admits the rest of its phase — what that
 * approval covers. Two independent sentences, so they are joined by a dash
 * rather than run together by a bare space.
 */
export function workflowCallCardLine(call: {
  readonly workflowName: string;
  readonly phase?: string;
  readonly admitsPhase?: true;
}): string {
  const note = WORKFLOW_CALL_REVIEW_COPY.callCardNote(
    call.workflowName,
    call.phase,
  );
  return call.admitsPhase
    ? `${note} — ${WORKFLOW_CALL_REVIEW_COPY.phaseAdmitsNote}`
    : note;
}

/**
 * `2 phases · 3 declared items`, `2 phases · calls issued at runtime`, or the
 * bare tail when the script declares no phases. Never a fake `0 tasks`.
 */
export function workflowScriptPlanSummary(plan: WorkflowScriptPlan): string {
  const items =
    plan.tasks.length > 0
      ? `${plan.tasks.length} declared ${plan.tasks.length === 1 ? 'item' : 'items'}`
      : 'calls issued at runtime';
  if (plan.phases.length === 0) return items;
  return `${plan.phases.length} ${plan.phases.length === 1 ? 'phase' : 'phases'} · ${items}`;
}
