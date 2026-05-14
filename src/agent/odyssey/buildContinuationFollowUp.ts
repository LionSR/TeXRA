import type { Odyssey } from '@tools/odyssey';

import {
  getContinuationTemplate,
  getObjectiveUpdatedTemplate,
} from './promptLoader';

function formatTimeMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const min = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  if (hours > 0) return `${hours}h ${min}m`;
  if (min > 0) return `${min}m ${sec}s`;
  return `${sec}s`;
}

function render(template: string, vars: Record<string, string>): string {
  return template.replaceAll(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match,
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
    timeUsed: formatTimeMs(odyssey.timeUsedMs),
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
