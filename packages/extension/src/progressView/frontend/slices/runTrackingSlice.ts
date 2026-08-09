/**
 * Run tracking handlers: UPDATE_FILES, UPDATE_MISSING_OUTPUTS,
 * UPDATE_COMPILE_FAILURES, UPDATE_RUN_USAGE.
 *
 * Workflow streams are one run per tab. Tool-use streams keep their own
 * per-run usage map (resume produces multiple runs in one tab). Instructions
 * are rendered as user messages in the log stream, not as a separate panel.
 */

import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  type ProgressViewOutboundHandlerRegistry,
  type StreamTabId,
  type WorkflowStreamState,
} from '@shared/schemas';

import { setStreamStateForId } from '../progressState';
import { updateWorkflowState, updateRounds } from '../stateUtils';

/** Workflow round-keyed record fields updated by the three handlers below. */
type RoundField = 'files' | 'missingOutputs' | 'compileFailures';

/**
 * Shared body of UPDATE_FILES / UPDATE_MISSING_OUTPUTS /
 * UPDATE_COMPILE_FAILURES: replace (`reset`) or merge a round-keyed record on
 * the workflow stream state. `field` keys both the state field and its element
 * type, so each handler collapses to a one-liner.
 */
function applyRoundUpdate<K extends RoundField>(
  data: {
    stream: StreamTabId;
    rounds?: WorkflowStreamState[K];
    reset?: boolean;
  },
  field: K,
): void {
  const { stream, rounds, reset } = data;
  updateWorkflowState(stream, (prev) =>
    create(prev, (draft) => {
      // updateRounds is generic over the element type, which TS cannot correlate
      // with a generic field key; widen to unknown[] here and cast the merged
      // record back to the field's concrete type.
      draft[field] = updateRounds<unknown>(prev[field], {
        rounds,
        reset,
      }) as WorkflowStreamState[K];
    }),
  );
}

// The composed registry is exhaustive (every ProgressView outbound command
// needs a real handler or `unsupported(...)` — see `@shared/utils/dispatcher`).
// This slice only owns a subset, so it's typed as a `satisfies Partial<...>`
// subset rather than the full registry; `messageDispatcher.ts` spreads all
// slices together and is the actual exhaustiveness checkpoint TypeScript
// enforces.
export const runTrackingHandlers = {
  [PROGRESS_VIEW_COMMANDS.UPDATE_FILES]: (data) =>
    applyRoundUpdate(data, 'files'),

  [PROGRESS_VIEW_COMMANDS.UPDATE_MISSING_OUTPUTS]: (data) =>
    applyRoundUpdate(data, 'missingOutputs'),

  [PROGRESS_VIEW_COMMANDS.UPDATE_COMPILE_FAILURES]: (data) =>
    applyRoundUpdate(data, 'compileFailures'),

  [PROGRESS_VIEW_COMMANDS.UPDATE_RUN_USAGE]: (data) => {
    const { stream, runId, usage } = data;
    // Both stream kinds carry runUsage (BaseStreamStateSchema), so no kind
    // narrowing is needed here.
    setStreamStateForId(stream, (prev) =>
      create(prev, (draft) => {
        draft.runUsage[runId] = usage;
      }),
    );
  },
} satisfies Partial<ProgressViewOutboundHandlerRegistry>;
