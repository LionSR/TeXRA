/**
 * Task handlers: UPDATE_TODOS, UPDATE_PLAN.
 */

import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';

import { updateToolUseState } from '../stateUtils';
import type { HandlerRegistry } from '../messageHandlerTypes';

// `HandlerRegistry` is now exhaustive (every ProgressView outbound command
// needs a real handler or `unsupported(...)` — see `@shared/utils/dispatcher`).
// This slice only owns a subset, so it's typed as a `satisfies Partial<...>`
// subset rather than the full registry; `messageDispatcher.ts` spreads all
// slices together and is the actual exhaustiveness checkpoint TypeScript
// enforces.
export const taskHandlers = {
  [PROGRESS_VIEW_COMMANDS.UPDATE_TODOS]: (data, ctx) => {
    updateToolUseState(ctx, data.stream, (prev) =>
      create(prev, (draft) => {
        draft.todos = data.todos;
      }),
    );
  },
  [PROGRESS_VIEW_COMMANDS.UPDATE_PLAN]: (data, ctx) => {
    updateToolUseState(ctx, data.stream, (prev) =>
      create(prev, (draft) => {
        draft.plan = data.plan;
      }),
    );
  },
} satisfies Partial<HandlerRegistry>;
