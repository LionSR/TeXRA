/**
 * Session slice: execution, file-operation, housekeeping, and history
 * commands routed through the shared executionHandlers module.
 */

import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type { MainViewInboundHandlerRegistry } from '@shared/schemas';

import * as executionHandlers from '../managers/executionHandlers';
import type { MainViewInboundHost } from '../mainViewInboundContext';

export function createSessionHandlers(host: MainViewInboundHost) {
  return {
    [MAIN_VIEW_COMMANDS.EXECUTE]: (m) => executionHandlers.handleExecute(m),
    [MAIN_VIEW_COMMANDS.MERGE]: (m) => executionHandlers.handleFileOperation(m),
    [MAIN_VIEW_COMMANDS.COMPARE]: (m) =>
      executionHandlers.handleFileOperation(m),
    [MAIN_VIEW_COMMANDS.ACCEPT_EDITED]: (m) =>
      executionHandlers.handleFileOperation(m),

    [MAIN_VIEW_COMMANDS.PACK_SINGLE]: (m) =>
      executionHandlers.handleSingleOperation(m),
    [MAIN_VIEW_COMMANDS.CLEAN_SINGLE]: (m) =>
      executionHandlers.handleSingleOperation(m),
    [MAIN_VIEW_COMMANDS.PACK_MULTIPLE]: (m) =>
      executionHandlers.handleMultipleOperation(m),
    [MAIN_VIEW_COMMANDS.CLEAN_MULTIPLE]: (m) =>
      executionHandlers.handleMultipleOperation(m),
  } satisfies Partial<MainViewInboundHandlerRegistry>;
}
