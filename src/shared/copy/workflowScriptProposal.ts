import type { WorkflowDeclaredPlan } from '@shared/schemas';

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

/**
 * `2 phases · 3 declared items`, `2 phases · calls issued at runtime`, or the
 * bare tail when the script declares no phases. Never a fake `0 tasks`.
 */
export function workflowScriptPlanSummary(plan: WorkflowDeclaredPlan): string {
  const items =
    plan.tasks.length > 0
      ? `${plan.tasks.length} declared ${plan.tasks.length === 1 ? 'item' : 'items'}`
      : 'calls issued at runtime';
  if (plan.phases.length === 0) return items;
  return `${plan.phases.length} ${plan.phases.length === 1 ? 'phase' : 'phases'} · ${items}`;
}
