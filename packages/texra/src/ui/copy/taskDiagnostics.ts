import { Predicate } from 'effect';
import { runNoticeText, runStatus } from '@ui/copy/runStatus';
import type { RunView } from '@texra-ai/worldline/schemas';

/**
 * The plain-text facts of a task for a bug report or a new chat: the header
 * menu's "Copy diagnostics". It is the one surface that prints the raw ids
 * (the task's and its parent's), which the rest of the copy leaves out, and
 * it states what the task was without asking anything of whoever reads it.
 */
export function formatTaskDiagnostics(run: RunView): string {
  const model = run.modelLabel;
  const lines: (string | undefined)[] = [
    `Task: ${run.title}`,
    `Agent: ${model ? `${run.label} (${model})` : run.label}`,
    `Status: ${runStatus(run).word}`,
    runNoticeText(run) ?? undefined,
    `Id: ${run.id}`,
    run.parentId === null ? undefined : `Started by: ${run.parentId}`,
  ];

  return lines.filter(Predicate.isNotNullish).join('\n');
}
