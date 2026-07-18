/**
 * Task handlers: UPDATE_TODOS, UPDATE_PLAN.
 */

import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { ProgressViewOutboundHandlerRegistry } from '@shared/schemas';

import { updateToolUseState } from '../stateUtils';

// The composed registry is exhaustive (every ProgressView outbound command
// needs a real handler or `unsupported(...)` — see `@shared/utils/dispatcher`).
// This slice only owns a subset, so it's typed as a `satisfies Partial<...>`
// subset rather than the full registry; `messageDispatcher.ts` spreads all
// slices together and is the actual exhaustiveness checkpoint TypeScript
// enforces.
export const taskHandlers = {
  [PROGRESS_VIEW_COMMANDS.UPDATE_TODOS]: (data) => {
    updateToolUseState(data.stream, (prev) =>
      create(prev, (draft) => {
        draft.todos = data.todos;
      }),
    );
  },
  [PROGRESS_VIEW_COMMANDS.UPDATE_PLAN]: (data) => {
    updateToolUseState(data.stream, (prev) =>
      create(prev, (draft) => {
        draft.plan = data.plan;
      }),
    );
  },
} satisfies Partial<ProgressViewOutboundHandlerRegistry>;
