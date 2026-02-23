import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

import type { HandlerRegistry } from '../messageDispatcher';

export const uiHandlers: HandlerRegistry = {
  [PROGRESS_VIEW_COMMANDS.SET_PLACEMENT]: (data, ctx) => {
    ctx.setPlacement(data.placement);
  },
};
