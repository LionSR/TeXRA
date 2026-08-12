/**
 * Document slice: file selection/list/edit operations (FileManager) and the
 * diff/commit surface (DiffManager).
 */

import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type { MainViewInboundHandlerRegistry } from '@shared/schemas';

import type { MainViewInboundHost } from '../mainViewInboundContext';

export function createDocumentHandlers(host: MainViewInboundHost) {
  return {
    [MAIN_VIEW_COMMANDS.SELECT_MULTIPLE_FILES]: (m) =>
      host.fileManager.handleSelectMultipleFiles(m),

    [MAIN_VIEW_COMMANDS.REQUEST_EDITED_FILE]: (m) =>
      host.fileManager.handleRequestEditedFile(m),
    [MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE]: (m) =>
      host.fileManager.handleRequestBaseFile(m),

    [MAIN_VIEW_COMMANDS.GET_CURRENT_FILE]: (m) =>
      host.fileManager.handleGetCurrentFile(m),
    [MAIN_VIEW_COMMANDS.REFRESH_ALL_FILES]: () =>
      host.fileManager.handleRefreshAllFiles(),
    [MAIN_VIEW_COMMANDS.ADD_OPENED_FILES]: (m) =>
      host.fileManager.handleAddOpenedFiles(m.fileType),
    [MAIN_VIEW_COMMANDS.ATTACH_DROPPED_FILES]: (m) =>
      host.fileManager.handleAttachDroppedFiles(m),

    [MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS]: (m) =>
      host.diffManager.postRecentCommits(m.notifyWhenEmpty ?? undefined),
    [MAIN_VIEW_COMMANDS.REFRESH_COMMITS]: () =>
      host.diffManager.postRecentCommits(),
    [MAIN_VIEW_COMMANDS.LATEXDIFF]: (m) => host.diffManager.handleLatexdiff(m),
    [MAIN_VIEW_COMMANDS.LATEXDIFFVC]: (m) =>
      host.diffManager.handleLatexdiffvc(m),
    [MAIN_VIEW_COMMANDS.PACK_LATEXDIFFVC]: (m) =>
      host.diffManager.handleLatexdiffvcOperation(m),
    [MAIN_VIEW_COMMANDS.CLEAN_LATEXDIFFVC]: (m) =>
      host.diffManager.handleLatexdiffvcOperation(m),
  } satisfies Partial<MainViewInboundHandlerRegistry>;
}
