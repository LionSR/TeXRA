import { type Plan, type TodoItem } from '@shared/schemas';

function taskKey(value: string): string {
  return value.trim().replaceAll(/\s+/g, ' ').toLowerCase();
}

export function formatWorkPlanGranularityWarning(
  todos: readonly TodoItem[],
  plan: Plan | null,
): string | undefined {
  if (!plan || todos.length === 0) return undefined;

  const todoKeys = new Set(todos.map((todo) => taskKey(todo.content)));
  const overlaps = plan.steps.flatMap((step, index) => {
    if (!todoKeys.has(taskKey(step.title))) return [];
    return [`${index + 1}. ${step.title}`];
  });

  if (overlaps.length === 0) return undefined;

  return [
    'Warning: todo_write and plan use the same labels for work at different levels.',
    ...overlaps.map((overlap) => `- ${overlap}`),
    'Use plan for long-running goal/odyssey milestones and todo_write for microscopic execution steps. Make plan items more macroscopic, or make todos more granular, instead of duplicating the same checklist item in both tools.',
  ].join('\n');
}

export function appendWorkPlanGranularityWarning(
  output: string,
  warning: string | undefined,
): string {
  return warning ? `${output}\n\n${warning}` : output;
}
