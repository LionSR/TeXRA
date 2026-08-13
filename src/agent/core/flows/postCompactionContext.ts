/**
 * Post-compaction execution context: formats active subagents, todos, and the
 * work plan as XML so the agent can pick up its task after context has been
 * compacted (summarized) mid-run.
 */

import type {
  ActiveChildInfo,
  TodoItem,
  WorkPlanSnapshot,
} from '@shared/schemas';
import { escapeAttr, escapeText } from '@shared/utils/xmlEscape';

/**
 * Format active execution state as context for the agent after compaction.
 * Returns null if there are no active children to report.
 *
 * This helps the agent understand what subagents are still running after
 * context was compressed, so it can:
 * - Avoid launching duplicate subagents
 * - Know which execution IDs to check on
 * - Understand that pending results may arrive as follow-up messages
 */
export function formatPostCompactionContext(
  subagents: ActiveChildInfo[],
  workPlan?: WorkPlanSnapshot | null,
): string | null {
  const hasChildren = subagents.length > 0;
  const todos = workPlan?.todos ?? [];
  const hasTodos = todos.length > 0;
  const hasPlan =
    workPlan?.plan?.objective != null || workPlan?.planSummary != null;

  if (!hasChildren && !hasTodos && !hasPlan) {
    return null;
  }

  let note =
    'Your conversation context was compacted (summarized) to free up space. The following state was preserved from before compaction.';
  if (hasChildren) {
    note +=
      ' Any active executions listed below may still be running and their results will be delivered as follow-up messages when they complete.';
  }
  note +=
    ' Continue the task from this state: do not stop, re-plan from scratch, or suggest starting a new session.';

  const lines: string[] = ['<post-compaction-context>', `<note>${note}</note>`];

  if (hasChildren) {
    lines.push(`<active-subagents count="${subagents.length}">`);
    for (const sa of subagents) {
      const statusAttr = sa.status ? ` status="${escapeAttr(sa.status)}"` : '';
      const elapsedAttr = sa.elapsed
        ? ` elapsed="${escapeAttr(sa.elapsed)}"`
        : '';
      lines.push(
        `  <subagent id="${escapeAttr(sa.executionId)}" agent="${escapeAttr(sa.agentName)}"${statusAttr}${elapsedAttr} />`,
      );
    }
    lines.push('</active-subagents>');
  }

  if (hasTodos) {
    lines.push(...formatTodoContext(todos));
  }

  if (hasPlan) {
    lines.push(...formatPlanContext(workPlan));
  }

  lines.push('</post-compaction-context>');
  return lines.join('\n');
}

/** Format todo items as XML lines for post-compaction context. */
function formatTodoContext(todos: TodoItem[]): string[] {
  const lines: string[] = [`<current-todos count="${todos.length}">`];
  for (const todo of todos) {
    lines.push(
      `  <todo status="${escapeAttr(todo.status)}" activeForm="${escapeAttr(todo.activeForm)}">${escapeText(todo.content)}</todo>`,
    );
  }
  lines.push('</current-todos>');
  return lines;
}

/** Format the plan document as XML lines for post-compaction context. */
function formatPlanContext(workPlan: WorkPlanSnapshot): string[] {
  const objective = workPlan.plan?.objective ?? workPlan.planSummary;
  if (!objective) return [];
  return ['<current-plan>', escapeText(objective), '</current-plan>'];
}
