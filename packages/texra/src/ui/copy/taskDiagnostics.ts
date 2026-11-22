import { Predicate } from 'effect';
import { fileLocationAddressPath } from '@texra-ai/worldline/schemas';
import { documentRoundsOf } from '@texra/shared/plugins/documents';
import {
  compileFailuresOf,
  formatRoundLabel,
} from '@texra/shared/plugins/documentOutputs';
import { runNoticeText, runStatus } from '@ui/copy/runStatus';
import type { RunView } from '@texra-ai/worldline/schemas';

/**
 * The plain-text facts of a task for a bug report or a new chat: the header
 * menu's "Copy diagnostics". It is the one surface that prints the raw ids
 * (the task's and its parent's), which the rest of the copy leaves out, and
 * it states what the task was and where its files landed without asking
 * anything of whoever reads it. A revision with no rows is dropped rather than
 * printed empty.
 */
export function formatTaskDiagnostics(run: RunView): string {
  const model = run.modelLabel;
  const rounds = documentRoundsOf(run);
  const outputs = rounds.filter((round) => round.outputs.length > 0);
  const failures = rounds.filter(
    (round) => compileFailuresOf(round).length > 0,
  );

  const lines: (string | undefined)[] = [
    `Task: ${run.title}`,
    `Agent: ${model ? `${run.label} (${model})` : run.label}`,
    `Status: ${runStatus(run).word}`,
    runNoticeText(run) ?? undefined,
    `Id: ${run.id}`,
    run.parentId === null ? undefined : `Started by: ${run.parentId}`,
  ];

  if (outputs.length > 0) {
    lines.push('', 'Outputs:');
    for (const { round, outputs: files } of outputs) {
      for (const file of files) {
        const source = file.source ? ` (source: ${file.source})` : '';
        lines.push(
          `- ${formatRoundLabel(round)}: ${fileLocationAddressPath(file.location)}${source}`,
        );
      }
    }
  }

  if (failures.length > 0) {
    lines.push('', 'Compile failures:');
    for (const record of failures) {
      const { round } = record;
      for (const failure of compileFailuresOf(record)) {
        lines.push(
          `- ${formatRoundLabel(round)} ${failure.displayName}: log ${fileLocationAddressPath(failure.log)}`,
        );
      }
    }
  }

  return lines.filter(Predicate.isNotNullish).join('\n');
}
