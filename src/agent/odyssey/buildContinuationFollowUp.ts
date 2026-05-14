import type { Odyssey } from '@tools/odyssey';

import { formatOdysseyTime } from './formatOdysseyTime';
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
 * Render the continuation prompt for an active odyssey, wrapped in
 * <odyssey_context> tags. Used as a synthesized user message when the
 * wait-node short-circuits the wait for the autonomous loop.
 */
export async function buildContinuationFollowUp(
  odyssey: Odyssey,
): Promise<string> {
  const template = await getContinuationTemplate();
  return render(template, {
    objective: odyssey.objective,
    timeUsed: formatOdysseyTime(odyssey.timeUsedMs),
  });
}

/**
 * Render the objective-updated prompt for the user-driven edit flow.
 */
export async function buildObjectiveUpdatedFollowUp(
  odyssey: Odyssey,
): Promise<string> {
  const template = await getObjectiveUpdatedTemplate();
  return render(template, { objective: odyssey.objective });
}
