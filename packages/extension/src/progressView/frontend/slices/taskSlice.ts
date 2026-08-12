/**
 * Task handlers: UPDATE_TODOS, UPDATE_PLAN.
 */

import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { ProgressViewOutboundHandlerRegistry } from '@shared/schemas';

import { updateToolUseState } from '../stateUtils';

// Registry contract: every outbound command needs a handler or
// `unsupported(...)`; exhaustiveness is enforced at the composed spread in
// messageDispatcher.ts. This slice only owns a subset.
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
