// Test-only builder for the CLI TUI's `ChildStreamEntries` map
// (`packages/cli/src/chat/tui/state/childExecutions.ts`). Selector-level
// suites (ChildControls, ResumeHint, ConversationPane) build
// an already-settled map directly here instead of driving
// `projectChildRoster`/`setParentStream` through a real event sequence —
// ordering/race-transition coverage belongs to the ordered matrix in
// TuiStateAndFocus.vitest.ts.

import type {
  ChildStreamEntries,
  ChildStreamEntry,
} from '@cli/chat/tui/state/childExecutions';
import type { ActiveChildInfo, StreamTabId } from '@shared/schemas';

export interface ChildStreamEntryRow extends ActiveChildInfo {
  /** Explicit current edge, when the row needs one beyond the retained/active
   *  parent implied by its placement. `null` marks an explicit promotion. */
  readonly edgeParentStreamId?: StreamTabId | null;
  readonly removed?: boolean;
  /** Set `false` for a retained row that has left the active roster (e.g. it
   *  completed) while its retained history row remains. Defaults to `true`. */
  readonly active?: boolean;
}

type TestParentProvenance =
  | {
      readonly kind: 'explicit';
      readonly streamId: StreamTabId | null;
      readonly retained?: {
        readonly streamId: StreamTabId;
        readonly order: number;
      };
    }
  | {
      readonly kind: 'roster';
      readonly retained: {
        readonly streamId: StreamTabId;
        readonly order: number;
      };
    };

function toEntry(
  row: ChildStreamEntryRow,
  parentDefaults: {
    readonly active: boolean;
    readonly explicitParentStreamId?: StreamTabId | null;
    readonly retained?: {
      readonly streamId: StreamTabId;
      readonly order: number;
    };
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
  if (removed === true) return { kind: 'removed' };
  const retained = parentDefaults.retained;
  const explicitParent =
    edgeParentStreamId !== undefined
      ? edgeParentStreamId
      : parentDefaults.explicitParentStreamId;
  let parent: TestParentProvenance | undefined;
  if (explicitParent !== undefined) {
    parent = {
      kind: 'explicit',
      streamId: explicitParent,
      ...(retained && { retained }),
    };
  } else if (retained) {
    parent = { kind: 'roster', retained };
  }
  return {
    kind: 'live',
    summary,
    active: active ?? parentDefaults.active,
    ...(parent && { parent }),
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
        active: true,
        retained: { streamId: parentStreamId, order: index + 1 },
      }),
    );
  });
  for (const row of activeOnly) {
    map.set(
      row.childStreamId,
      toEntry(row, {
        active: true,
        explicitParentStreamId: parentStreamId,
      }),
    );
  }
  for (const childStreamId of edgeOnly) {
    map.set(childStreamId, {
      kind: 'live',
      active: false,
      parent: { kind: 'explicit', streamId: parentStreamId },
    });
  }
  return map;
}
