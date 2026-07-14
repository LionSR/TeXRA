// Test-only builder for the CLI TUI's `ChildStreamEntries` map
// (`packages/cli/src/chat/tui/state/childExecutions.ts`). Selector-level
// suites (ChildControls, ResumeHint, ConversationPane) build
// an already-settled map directly here instead of driving
// `applySubagentRoster`/`setParentStream` through a real event sequence —
// ordering/race-transition coverage belongs to the ordered matrix in
// TuiStateAndFocus.vitest.mts.

import type {
  ChildStreamEntries,
  ChildStreamEntry,
} from '@cli/chat/tui/state/childExecutions';
import type { StreamTabId, SubagentChildInfo } from '@shared/schemas';

export interface ChildStreamEntryRow extends SubagentChildInfo {
  /** Explicit current edge, when the row needs one beyond the retained/active
   *  parent implied by its placement. `null` marks an explicit promotion. */
  readonly edgeParentStreamId?: StreamTabId | null;
  readonly removed?: boolean;
  /** Set `false` for a retained row that has left the active roster (e.g. it
   *  completed) while its retained history row remains. Defaults to `true`. */
  readonly active?: boolean;
}

function toEntry(
  row: ChildStreamEntryRow,
  parentDefaults: {
    readonly activeParentStreamId?: StreamTabId;
    readonly edgeParentStreamId?: StreamTabId | null;
    readonly retainedParentStreamId?: StreamTabId;
    readonly retainedOrder?: number;
  },
): ChildStreamEntry {
  const {
    childStreamId: _childStreamId,
    status: _status,
    edgeParentStreamId,
    removed,
    active,
    ...summary
  } = row;
  return {
    summary,
    activeParentStreamId:
      active === false ? undefined : parentDefaults.activeParentStreamId,
    retainedParentStreamId: parentDefaults.retainedParentStreamId,
    retainedOrder: parentDefaults.retainedOrder,
    edgeParentStreamId: edgeParentStreamId ?? parentDefaults.edgeParentStreamId,
    removed: removed ?? false,
  };
}

/**
 * Build a `ChildStreamEntries` map for one parent: `retained` rows (in
 * order) get both retained and active membership; `activeOnly` rows get an
 * explicit edge plus active membership without a retained association under
 * this parent (the cross-parent-reattachment / partial-state shape
 * `visibleSubagentRows` falls back over — effective parent still resolves to
 * `parentStreamId` via the edge, matching what a real `setParentStream` +
 * roster-without-first-retention sequence produces). Merge maps from
 * multiple calls with `new Map([...a, ...b])` for multi-parent fixtures.
 */
export function buildChildStreamEntries(init: {
  readonly parentStreamId: StreamTabId;
  readonly retained?: readonly ChildStreamEntryRow[];
  readonly activeOnly?: readonly ChildStreamEntryRow[];
  /** Explicit `setParentStream` edge with no roster ever having supplied
   *  display metadata — the "edge arrived, no summary yet" shape. */
  readonly edgeOnly?: readonly StreamTabId[];
}): ChildStreamEntries {
  const {
    parentStreamId,
    retained = [],
    activeOnly = [],
    edgeOnly = [],
  } = init;
  const map = new Map<StreamTabId, ChildStreamEntry>();
  retained.forEach((row, index) => {
    map.set(
      row.childStreamId,
      toEntry(row, {
        activeParentStreamId: parentStreamId,
        retainedParentStreamId: parentStreamId,
        retainedOrder: index + 1,
      }),
    );
  });
  for (const row of activeOnly) {
    map.set(
      row.childStreamId,
      toEntry(row, {
        activeParentStreamId: parentStreamId,
        edgeParentStreamId: parentStreamId,
      }),
    );
  }
  for (const childStreamId of edgeOnly) {
    map.set(childStreamId, {
      edgeParentStreamId: parentStreamId,
      removed: false,
    });
  }
  return map;
}
