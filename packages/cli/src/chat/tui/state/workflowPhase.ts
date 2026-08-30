// Current workflow-script phase for orientation chrome (header, status bar).

import type { StreamStage, StreamTabId } from '@shared/schemas';
import { formatPhaseStageLabel } from '@shared/streams/streamStatusDisplay';

/**
 * Nearest workflow-script ancestor's current phase, walking parent links
 * starting from the stream's parent, named from the shared
 * `StreamExecutionState.stage` the session applier writes — a `phase` stage
 * is written by the workflow-script run alone, so its kind is the whole test.
 * `stage` is ephemeral (a reloaded session has none until the run opens its
 * next phase), the gap the progress view's header already lives with.
 *
 * A stream's own stage is never its location context: the header prints once
 * into scrollback and would go stale as the workflow advanced, and the status
 * bar already has a stage slot for the displayed stream's own phase — naming
 * it here too printed `Derive (1/2) › name … Derive (1/2)` on one row.
 */
export function ancestorWorkflowPhaseLabel(init: {
  readonly stageOf: (streamId: StreamTabId) => StreamStage | undefined;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streamId: StreamTabId;
}): string | undefined {
  let id: StreamTabId | undefined = init.parentStream.get(init.streamId);
  const seen = new Set<StreamTabId>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const stage = init.stageOf(id);
    if (stage?.kind === 'phase') return formatPhaseStageLabel(stage);
    id = init.parentStream.get(id);
  }
  return undefined;
}
