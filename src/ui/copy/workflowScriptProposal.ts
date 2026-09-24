import type { WorkflowDeclaredPlan } from '@shared/schemas';

/**
 * Copy for the multi-agent workflow proposal, shared by every host so the
 * card never presents `meta.tasks` as resolved calls: those are plan labels,
 * and the calls the script actually issues appear only when it issues them.
 */
export const WORKFLOW_SCRIPT_PROPOSAL_COPY = {
  costWarning:
    'Agents may run in parallel, which can cost more than a single run.',
  filesHeading: 'Files available to the script',
  defaults: (agent: string, model: string): string =>
    `Defaults: ${agent} (${model}) — each call may name its own agent and model.`,
} as const;

/** `3 steps`, or `steps decided as it runs` for none. Never a fake `0`. */
export function workflowScriptStepCount(count: number): string {
  if (count === 0) return 'steps decided as it runs';
  return `${count} ${count === 1 ? 'step' : 'steps'}`;
}

/**
 * `2 phases · 3 steps`, `2 phases · steps decided as it runs`, or the bare
 * tail when the script declares no phases.
 */
export function workflowScriptPlanSummary(plan: WorkflowDeclaredPlan): string {
  const steps = workflowScriptStepCount(plan.tasks.length);
  if (plan.phases.length === 0) return steps;
  return `${plan.phases.length} ${plan.phases.length === 1 ? 'phase' : 'phases'} · ${steps}`;
}
