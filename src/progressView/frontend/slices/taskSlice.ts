/**
 * Task group handlers: ADD_TASK_GROUP, UPDATE_TASK_GROUP, UPDATE_TODOS.
 */

import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

import { updateToolUseState } from '../stateUtils';
import type { HandlerRegistry } from '../messageDispatcher';

export const taskHandlers: HandlerRegistry = {
  [PROGRESS_VIEW_COMMANDS.ADD_TASK_GROUP]: (data, ctx) => {
    ctx.setStreamState(data.stream, (prev) =>
      create(prev, (draft) => {
        draft.taskGroups.push(data.group);
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_TASK_GROUP]: (data, ctx) => {
    const { streamId, id, status, endTime } = data.update;
    ctx.setStreamState(streamId, (prev) =>
      create(prev, (draft) => {
        const group = draft.taskGroups.find((g) => g.id === id);
        if (!group) return;
        if (status) group.status = status;
        if (endTime) group.endTime = endTime;
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_TODOS]: (data, ctx) => {
    updateToolUseState(ctx, data.stream, (prev) =>
      create(prev, (draft) => {
        draft.todos = data.todos;
      }),
    );
  },
};
