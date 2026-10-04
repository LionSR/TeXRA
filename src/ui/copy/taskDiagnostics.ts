import { fileLocationAddressPath, roundIndexedEntries } from '@shared/schemas';
import { documentsOf } from '@shared/plugins/documents';
import type { RunView } from '@shared/session/sessionView';
import { filterNotNullish } from '@utils/core';

/**
 * The plain-text facts of a task for a bug report or a new chat: the header
 * menu's "Copy diagnostics". It is the one surface that prints the raw ids
 * (the task's and its parent's), which the rest of the copy leaves out, and
 * it states what the task was and where its files landed without asking
 * anything of whoever reads it. A pass with no rows is dropped rather than
 * printed empty.
 */
export function formatTaskDiagnostics(run: RunView): string {
  const model = run.modelLabel ?? run.model;
  const documents = documentsOf(run);
  const outputs = roundIndexedEntries(documents.files).filter(
    ([, files]) => files.length > 0,
  );
  const failures = roundIndexedEntries(documents.compileFailures).filter(
    ([, rows]) => rows.length > 0,
  );

  const lines: (string | undefined)[] = [
    `Task: ${run.description || run.label}`,
    `Agent: ${model ? `${run.label} (${model})` : run.label}`,
    `Status: ${run.statusLabel}`,
    run.statusDetail ?? undefined,
    `Id: ${run.id}`,
    run.parentId === null ? undefined : `Started by: ${run.parentId}`,
  ];

  if (outputs.length > 0) {
    lines.push('', 'Outputs:');
    for (const [round, files] of outputs) {
      for (const file of files) {
        const source = file.source ? ` (source: ${file.source})` : '';
        lines.push(
          `- ${passLabel(round)}: ${fileLocationAddressPath(file.location)}${source}`,
        );
      }
    }
  }

  if (failures.length > 0) {
    lines.push('', 'Compile failures:');
    for (const [round, rows] of failures) {
      for (const failure of rows) {
        lines.push(
          `- ${passLabel(round)} ${failure.displayName}: log ${fileLocationAddressPath(failure.log)}`,
        );
      }
    }
  }

  return lines.filter(filterNotNullish).join('\n');
}

/** A workflow task's pass, one-based from a zero-based round: "Pass 2", or
 *  "Pass 2 of 3" against a planned total. The header chip and the
 *  diagnostics count passes the same way. */
export function passLabel(round: number, total?: number): string {
  return total === undefined
    ? `Pass ${round + 1}`
    : `Pass ${round + 1} of ${total}`;
}
