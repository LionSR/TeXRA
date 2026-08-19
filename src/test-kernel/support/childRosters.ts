// Test-only builder for the CLI TUI's `ChildRosters` map
// (`packages/cli/src/chat/tui/state/childExecutions.ts`). Selector-level
// suites (ChildControls, ResumeHint, SubagentListDisplay,
// ConversationTranscript) build an already-settled per-parent roster directly
// here instead of driving facts through the shared `SessionFactApplier` —
// transition/ordering coverage belongs to the substrate suites and the
// adapter-driven matrix in TuiStateAndFocus.vitest.ts.

import type { ChildRosters } from '@cli/chat/tui/state/childExecutions';
import type { ActiveChildInfo, StreamTabId } from '@shared/schemas';

/**
 * Build a one-parent `ChildRosters` map. Rows are stored verbatim in the
 * order given; membership is decided by `finishedAt` presence (unset = live,
 * set = finished row retained for display), never by `status`. A parent with
 * no rows yields an empty map, matching the production computed, which omits
 * parents whose roster is empty. Parent edges are not represented here —
 * selectors that need them take a separate `parentStream` map the caller
 * hand-builds. Merge maps from multiple calls with `new Map([...a, ...b])`
 * for multi-parent fixtures.
 */
export function buildChildRosters(init: {
  readonly parentStreamId: StreamTabId;
  readonly rows?: readonly ActiveChildInfo[];
}): ChildRosters {
  const { parentStreamId, rows = [] } = init;
  if (rows.length === 0) return new Map();
  return new Map([[parentStreamId, rows]]);
}
