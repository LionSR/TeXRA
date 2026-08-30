/**
 * Session slice: host-pushed agent/session selection.
 */

// Local imports - shared IPC and schemas
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type { MainViewHandlerRegistry } from '@shared/schemas';

// Local imports - main view
import { agent$, sessionType$ } from '../mainViewState';

// `satisfies Partial<...>` subset — owns only session commands; see
// bannerSlice.ts for the rationale.
export const sessionHandlers = {
  [MAIN_VIEW_COMMANDS.SET_SELECTED_AGENT]: (message) => {
    const sessionType = message.sessionType;
    if (sessionType) {
      sessionType$.set(sessionType);
    }
    if (message.agentId) {
      agent$.set({ ...agent$.get(), [sessionType$.get()]: message.agentId });
    }
  },
} satisfies Partial<MainViewHandlerRegistry>;
