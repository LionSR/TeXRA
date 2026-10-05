import {
  DOCUMENTS_OUTPUT_KEY,
  documentRoundsOf,
} from '@shared/plugins/documents';
import type { RunView } from '@shared/session/sessionView';
import { passLabel } from '@ui/copy/taskDiagnostics';

/**
 * The run header's pass chip: "Pass 2 of 3" on a document task, naming the
 * latest pass whose documents it recorded; nothing on any other task, whose
 * conversation already shows its turns and tool calls. The total is the
 * agent's planned pass count, when the catalog knows it.
 */
export function progressBadgeLabel(
  run: Pick<RunView, 'documentTask' | 'facts'>,
  plannedPasses: number | undefined,
): string | undefined {
  if (!run.documentTask) return undefined;
  const passes = documentRoundsOf(run.facts[DOCUMENTS_OUTPUT_KEY]).length;
  return passes === 0 ? undefined : passLabel(passes - 1, plannedPasses);
}
