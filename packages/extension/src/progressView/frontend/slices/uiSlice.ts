import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';

import type { HandlerRegistry } from '../messageHandlerTypes';

export const uiHandlers: HandlerRegistry = {
  [PROGRESS_VIEW_COMMANDS.SET_PLACEMENT]: (data, ctx) => {
    ctx.setPlacement(data.placement);
  },
};
