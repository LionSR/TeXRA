// Auto-return focus: when the child stream the user is focused on reaches a
// terminal outcome, hand the viewport back to the root session — that is
// where the child's report streams next. Decided here as a pure function so
// the subscription glue stays one line and the rule is unit-testable.
//
// Deliberate boundaries:
// - WAITING never fires: "waiting for you" is a question addressed to the
//   user, not a finished run (isTerminalOutcomePhase excludes it).
// - Only a genuine transition edge fires (previous status missing or
//   in-flight), so replayed/restored terminal statuses never yank focus
//   after the user deliberately re-focuses a stopped child.
// - `suppressViewSwitch` is not consulted: that flag guards a child stealing
//   focus on registration; this moves focus in the protected direction
//   (back to root).

import type { StreamPhase, StreamTabId } from '@shared/schemas';
import {
  isInFlightPhase,
  isTerminalOutcomePhase,
} from '@shared/streams/streamStatus';

export function autoReturnFocusTarget({
  activeStreamId,
  parentStream,
  previousStatus,
  rootStreamId,
  status,
  streamId,
}: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly previousStatus: StreamPhase | undefined;
  readonly rootStreamId: StreamTabId | undefined;
  readonly status: StreamPhase | undefined;
  readonly streamId: StreamTabId;
}): StreamTabId | undefined {
  if (rootStreamId === undefined || activeStreamId === undefined) {
    return undefined;
  }
  if (streamId !== activeStreamId || streamId === rootStreamId) {
    return undefined;
  }
  if (!parentStream.has(streamId)) return undefined;
  if (!isTerminalOutcomePhase(status)) return undefined;
  if (previousStatus !== undefined && !isInFlightPhase(previousStatus)) {
    return undefined;
  }
  return rootStreamId;
}
