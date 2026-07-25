// Phase grouping for a focused workflow-script run's child rows.
//
// Two pure derivations over one ordering rule, because they have to agree: the
// row ORDER (applied by `streamTreeEntries`, which also assigns the Alt+1..9
// shortcut numbers, so a shortcut cannot point at a different row than the one
// a user counts to) and the divider rows the list paints above each group. The
// divider pass re-applies that same rule, which is idempotent — that is what
// makes it total on any input without giving order a second owner. Same rows +
// tasks in, same groups out: no clock, no synthetic ids, no dedup.

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
 *
 * Entries carrying no phase sort ahead of every group, keeping their relative
 * order. They cannot be left between or after groups: a divider only ever
 * *opens* a group, so a phase-less entry trailing one would render directly
 * under that group's rows and read as part of it — which is exactly what an
 * `agent()` call issued outside any `phase()`, or a roster row from before the
 * field existed, is not. Ahead of the first divider they belong to the run
 * itself, which is also where the tree puts them.
 *
 * A list where nothing carries a phase sorts to itself — returned as the very
 * same array, which is the root viewport's regression guard.
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
      // Every group ranks by its first-seen index, so -1 is the phase-less
      // block: ahead of all of them, and stable within itself.
      const groupRank = phase === undefined ? undefined : firstSeen.get(phase);
      return { id, index, rank: groupRank ?? -1 };
    })
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.id);
}

/**
 * Insert a phase header above each group of rows that declare one. Rows
 * carrying no phase pass through header-less ahead of every group, so a list
 * where no row carries a phase yields exactly its own rows in order.
 *
 * Grouping is `orderChildIdsByPhase` — the same rule, and the same single
 * implementation, that `streamTreeEntries` applies when it numbers the Alt+1..9
 * shortcuts. It is idempotent, so re-applying it here to an already-ordered
 * list is a no-op and the rendered order cannot drift from the shortcut order;
 * applying it here rather than trusting the caller is what makes this pass
 * total. Because groups are contiguous by construction, no phase can open a
 * second header and no row can end up under a header it does not belong to.
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
  // The phase whose divider is the last one emitted. It only ever advances to
  // the next group's phase — a phase-less row never reopens it, because the
  // ordering above has already put every one of them ahead of the first group.
  let openPhase: string | undefined;
  for (const row of orderChildIdsByPhase(
    init.rows,
    (candidate) => candidate.workflowPhase,
  )) {
    const phase = row.workflowPhase;
    if (phase !== undefined && phase !== openPhase) {
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
      openPhase = phase;
    }
    out.push({ kind: 'row', row });
  }
  return out;
}
