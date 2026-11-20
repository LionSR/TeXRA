import {
  documentRoundsOf,
  isDocumentTaskRun,
} from '@texra/shared/plugins/documents';
import { formatRoundLabel } from '@texra/shared/plugins/documentOutputs';
import type { RunView } from '@texra-ai/harness/schemas';

/**
 * The run header's revision chip: "Revision 2 of 3" on a document task,
 * naming the latest revision whose documents it recorded; nothing on any
 * other task, whose conversation already shows its turns and tool calls.
 * The total is the agent's planned revision count, when the catalog knows it.
 */
export function progressBadgeLabel(
  run: Pick<RunView, 'program' | 'facts'>,
  plannedRevisions: number | undefined,
): string | undefined {
  if (!isDocumentTaskRun(run)) return undefined;
  const rounds = documentRoundsOf(run).length;
  return rounds === 0
    ? undefined
    : formatRoundLabel(rounds - 1, plannedRevisions);
}
