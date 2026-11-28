import {
  formatCount,
  isEmptyUsage,
  type RunId,
  type TokenUsageStats,
} from '@texra-ai/worldline/schemas';
import { usageCostLabel } from '@ui/copy/modelAccess';
import { TASK_ACTIONS } from '@ui/copy/nestedRuns';
import { visibleTokenStats } from '@ui/copy/tokenUsage';

import {
  formatResumeCommand,
  type ResumeCommandOptions,
} from '../../../runtime/resumeCommand';
import { runViewOf } from './sessionView';
import type { SessionView } from '@texra-ai/worldline/schemas';

/** The task's metered usage: the root run and every descendant. */
export function collectResumeUsage(
  view: SessionView,
  rootRunId: RunId | undefined,
): TokenUsageStats | undefined {
  const total = runViewOf(view, rootRunId)?.treeUsage;
  return total === undefined || isEmptyUsage(total) ? undefined : total;
}

function formatResumeUsage(
  usage: TokenUsageStats | undefined,
): string | undefined {
  if (!usage || isEmptyUsage(usage)) return undefined;
  // The counters the progress view's usage strip shows, exact.
  const tokens = visibleTokenStats(usage)
    .map(({ label, value }) => `${formatCount(value)} ${label.toLowerCase()}`)
    .join(', ');
  // A task that never reached a model has no cost to state.
  const costLine =
    usage.cost > 0 || usage.usageRoute !== undefined
      ? usageCostLabel(usage)
      : undefined;
  return costLine
    ? `Token usage: ${tokens}\nTask cost: ${costLine}`
    : `Token usage: ${tokens}`;
}

/** The exit hint: the task's usage, then the one command that resumes its
 *  root run (a child resumes through its parent). */
export function formatResumeHint(
  runId: RunId,
  usage: TokenUsageStats | undefined,
  commandName: string,
  commandOptions?: ResumeCommandOptions,
): string {
  return [
    formatResumeUsage(usage),
    TASK_ACTIONS.resumeHint,
    `  ${formatResumeCommand(commandName, runId, commandOptions)}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}
