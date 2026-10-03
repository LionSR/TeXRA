import type { LoopCoordinate } from '@shared/session/sessionView';
import { passLabel } from '@ui/copy/taskDiagnostics';

/**
 * The run header's pass chip: "Pass 2 of 3" on a workflow task, which works
 * in passes; nothing on any other task, whose conversation already shows its
 * turns and tool calls. The total is the agent's planned pass count, when
 * the catalog knows it.
 */
export function progressBadgeLabel(
  position: LoopCoordinate | null,
  plannedPasses: number | undefined,
): string | undefined {
  return position?.kind === 'round'
    ? passLabel(position.index, plannedPasses)
    : undefined;
}
