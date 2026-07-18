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
  sumUsageStats,
  type ProgressViewOutboundHandlerRegistry,
} from '@shared/schemas';

import { isToolUseState, isWorkflowState } from '../store';
import { setStreamStateForId } from '../progressState';
import { updateWorkflowState, updateRounds } from '../stateUtils';

// The composed registry is exhaustive (every ProgressView outbound command
// needs a real handler or `unsupported(...)` — see `@shared/utils/dispatcher`).
// This slice only owns a subset, so it's typed as a `satisfies Partial<...>`
// subset rather than the full registry; `messageDispatcher.ts` spreads all
// slices together and is the actual exhaustiveness checkpoint TypeScript
// enforces.
export const runTrackingHandlers = {
  [PROGRESS_VIEW_COMMANDS.UPDATE_FILES]: (data) => {
    const { stream, rounds, reset } = data;
    updateWorkflowState(stream, (prev) =>
      create(prev, (draft) => {
        draft.files = updateRounds(prev.files, { rounds, reset });
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_MISSING_OUTPUTS]: (data) => {
    const { stream, rounds, reset } = data;
    updateWorkflowState(stream, (prev) =>
      create(prev, (draft) => {
        draft.missingOutputs = updateRounds(prev.missingOutputs, {
          rounds,
          reset,
        });
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_COMPILE_FAILURES]: (data) => {
    const { stream, rounds, reset } = data;
    updateWorkflowState(stream, (prev) =>
      create(prev, (draft) => {
        draft.compileFailures = updateRounds(prev.compileFailures, {
          rounds,
          reset,
        });
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_RUN_USAGE]: (data) => {
    const { stream, runId, usage } = data;
    setStreamStateForId(stream, (prev) => {
      if (isToolUseState(prev) || isWorkflowState(prev)) {
        return create(prev, (draft) => {
          draft.runUsage[runId] = usage;
          draft.sessionUsage = sumUsageStats(Object.values(draft.runUsage));
        });
      }
      return prev;
    });
  },
} satisfies Partial<ProgressViewOutboundHandlerRegistry>;
