/**
 * Task handlers: UPDATE_TODOS (unified todo + plan tracking).
 */

import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

import { updateToolUseState } from '../stateUtils';
import type { HandlerRegistry } from '../messageDispatcher';

export const taskHandlers: HandlerRegistry = {
  [PROGRESS_VIEW_COMMANDS.UPDATE_TODOS]: (data, ctx) => {
    updateToolUseState(ctx, data.stream, (prev) =>
      create(prev, (draft) => {
        draft.todos = data.todos;
        if (data.summary !== undefined) {
          draft.todoSummary = data.summary;
        }
      }),
    );
  },
  // Keep UPDATE_PLAN handler for backward compatibility during migration
  [PROGRESS_VIEW_COMMANDS.UPDATE_PLAN]: (data, ctx) => {
    updateToolUseState(ctx, data.stream, (prev) =>
      create(prev, (draft) => {
        draft.plan = data.plan;
      }),
    );
  },
};
