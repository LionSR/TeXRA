/**
 * Session slice: host-pushed agent/session selection.
 */

// Local imports - shared IPC and schemas
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type { MainViewHandlerRegistry } from '@shared/schemas';

// Local imports - main view
import { SESSION_TYPES, parseSessionType } from '../constants';
import { sessionType$, toolUseAgent$, workflowAgent$ } from '../mainViewState';
import { refreshInstructionPlaceholder } from '../mainViewActions';

// `satisfies Partial<...>` (not `: MainViewHandlerRegistry`): this slice
// owns only session commands; see bannerSlice.ts for why (registry is now
// exhaustive, messageDispatcher.ts is the real coverage checkpoint).
export const sessionHandlers = {
  [MAIN_VIEW_COMMANDS.SET_SELECTED_AGENT]: (message) => {
    const sessionType = parseSessionType(message.sessionType ?? undefined);
    if (sessionType) {
      sessionType$.set(sessionType);
    }
    if (message.agentId) {
      if (sessionType$.get() === SESSION_TYPES.TOOL_USE) {
        toolUseAgent$.set(message.agentId);
      } else {
        workflowAgent$.set(message.agentId);
      }
    }
    refreshInstructionPlaceholder();
  },
} satisfies Partial<MainViewHandlerRegistry>;
