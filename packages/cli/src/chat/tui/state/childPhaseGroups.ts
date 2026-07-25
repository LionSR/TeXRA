// Phase grouping for a focused workflow-script run's child rows.
//
// Two pure derivations with one owner, because they have to agree: the row
// ORDER (consumed by `streamTreeEntries`, which also assigns the Alt+1..9
// shortcut numbers — grouping in the renderer instead would silently
// desynchronise a shortcut from the row it points at) and the divider rows the
// list paints above each group. Same rows + tasks in, same groups out: no
// clock, no synthetic ids, no dedup.

// Local imports - shared workflow copy
import type { WorkflowTaskProgress } from '@shared/schemas';
import {
  formatWorkflowPhaseHeading,
  workflowPhaseTaskProgress,
  type WorkflowPhaseHeading,
} from '@shared/copy/workflowTask';

// Local imports - TUI presentation
import { STATUS_DIAMOND } from '../ui/glyphs';

/** Phase divider heading one contiguous group of child rows. */
export interface ChildPhaseHeader {
  /** Phase title, and the group's identity. */
  readonly phase: string;
  /** `◆ Reduce (2/3)` — the transcript divider's copy, same owner. */
  readonly label: string;
  /** `1/3` task completion; absent when the phase declares no tasks. */
  readonly progress?: string;
}

export type ChildPhaseGroupRow<T> =
  | { readonly kind: 'header'; readonly header: ChildPhaseHeader }
  | { readonly kind: 'row'; readonly row: T };

/**
 * Stable group-by: entries carrying the same phase become contiguous, ordered
 * by each phase's first-seen position, with within-group order untouched.
 * Entries with no phase keep their own position as their rank, so a list where
 * nothing carries a phase sorts to itself — returned as the very same array,
 * which is the root viewport's regression guard.
 */
export function orderChildIdsByPhase<T>(
  ids: readonly T[],
  phaseOf: (id: T) => string | undefined,
): readonly T[] {
  const firstSeen = new Map<string, number>();
  for (const [index, id] of ids.entries()) {
    const phase = phaseOf(id);
    if (phase === undefined || firstSeen.has(phase)) continue;
    firstSeen.set(phase, index);
  }
  if (firstSeen.size === 0) return ids;
  return ids
    .map((id, index) => {
      const phase = phaseOf(id);
      const rank =
        phase === undefined ? index : (firstSeen.get(phase) ?? index);
      return { id, index, rank };
    })
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.id);
}

/**
 * Insert a phase header above each contiguous group of rows that declare one.
 * Rows without a phase pass through ungrouped and header-less, so a list where
 * no row carries a phase yields exactly its own rows in order.
 *
 * `done/total` per header is the shared `workflowPhaseTaskProgress` fold over
 * the run's task cards for that phase — one per logical `agent()` call. A
 * durable retry registers a *new* child stream, so a retried call can leave two
 * rows under a header whose count moves by one. That is the intended reading:
 * headers count tasks, rows count attempts.
 */
export function childPhaseGroupRows<
  T extends { readonly workflowPhase?: string },
>(init: {
  readonly rows: readonly T[];
  readonly phases?: readonly WorkflowPhaseHeading[];
  readonly tasks?: readonly WorkflowTaskProgress[];
}): readonly ChildPhaseGroupRow<T>[] {
  const headingByPhase = new Map<string, string>();
  for (const phase of init.phases ?? []) {
    headingByPhase.set(phase.phaseLabel, formatWorkflowPhaseHeading(phase));
  }
  const tasksByPhase = new Map<string, WorkflowTaskProgress[]>();
  for (const task of init.tasks ?? []) {
    if (task.phase === undefined) continue;
    const bucket = tasksByPhase.get(task.phase);
    if (bucket) bucket.push(task);
    else tasksByPhase.set(task.phase, [task]);
  }

  const out: ChildPhaseGroupRow<T>[] = [];
  let currentPhase: string | undefined;
  for (const row of init.rows) {
    const phase = row.workflowPhase;
    if (phase !== undefined && phase !== currentPhase) {
      const { done, total } = workflowPhaseTaskProgress(
        tasksByPhase.get(phase) ?? [],
      );
      out.push({
        kind: 'header',
        header: {
          phase,
          label: `${STATUS_DIAMOND} ${headingByPhase.get(phase) ?? phase}`,
          ...(total > 0 ? { progress: `${done}/${total}` } : {}),
        },
      });
    }
    currentPhase = phase;
    out.push({ kind: 'row', row });
  }
  return out;
}
