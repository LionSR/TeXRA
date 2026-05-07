/**
 * Task handlers: UPDATE_TODOS, UPDATE_PLAN.
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
};
