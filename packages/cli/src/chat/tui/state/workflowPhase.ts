// Current workflow-script phase for orientation chrome (header, status bar).

import {
  AgentCategory,
  type StreamStage,
  type StreamTabId,
} from '@shared/schemas';
import { formatPhaseStageLabel } from '@shared/streams/streamStatusDisplay';

/**
 * The open phase of one workflow-script stream, named the way every host names
 * it: from the shared `StreamExecutionState.stage` the session applier writes,
 * not from a transcript row this host happens to hold. `stage` is ephemeral —
 * a reloaded session has none until the run opens its next phase — which is
 * exactly the gap the progress view's header already lives with.
 *
 * Callers pass the stream's shared facts (`streamStateFor(id)?.stage`,
 * `streamMetadataFor(id)?.agentCategory`) so this selector stays pure.
 */
function currentWorkflowPhaseLabel(
  stage: StreamStage | undefined | null,
  category: AgentCategory | undefined,
): string | undefined {
  if (category !== AgentCategory.Workflow || stage?.kind !== 'phase') {
    return undefined;
  }
  return formatPhaseStageLabel(stage);
}

/** Nearest workflow-script ancestor's current phase, walking parent links. */
export function ancestorWorkflowPhaseLabel(init: {
  readonly categoryOf: (streamId: StreamTabId) => AgentCategory | undefined;
  readonly stageOf: (streamId: StreamTabId) => StreamStage | undefined;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streamId: StreamTabId;
}): string | undefined {
  let id: StreamTabId | undefined = init.streamId;
  const seen = new Set<StreamTabId>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const label = currentWorkflowPhaseLabel(
      init.stageOf(id),
      init.categoryOf(id),
    );
    if (label) return label;
    id = init.parentStream.get(id);
  }
  return undefined;
}
