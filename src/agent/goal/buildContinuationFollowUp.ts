import type { Goal } from '@tools/goal';
import { formatGoalTime, goalElapsedMs } from '@tools/goal/goalMeta';

import {
  getContinuationTemplate,
  getObjectiveUpdatedTemplate,
} from './promptLoader';

function render(template: string, vars: Record<string, string>): string {
  return template.replaceAll(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.hasOwn(vars, key) ? vars[key] : match,
  );
}

/**
 * Render the continuation prompt for an active goal, wrapped in
 * <goal_context> tags. Used as a synthesized user message when the
 * wait-node short-circuits the wait for the autonomous loop.
 */
export async function buildContinuationFollowUp(goal: Goal): Promise<string> {
  const template = await getContinuationTemplate();
  return render(template, {
    objective: goal.objective,
    timeUsed: formatGoalTime(goalElapsedMs(goal)),
  });
}

/**
 * Render the objective-updated prompt for the user-driven edit flow.
 */
export async function buildObjectiveUpdatedFollowUp(
  goal: Goal,
): Promise<string> {
  const template = await getObjectiveUpdatedTemplate();
  return render(template, { objective: goal.objective });
}
