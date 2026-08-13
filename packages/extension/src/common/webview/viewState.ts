// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { createLog } from '@logger/logUtils';

const log = createLog('extension');
const TEXRA_ACTIVE_VIEW_CONTEXT_KEY = 'texra.activeView';

export const SIDEBAR_VIEWS = {
  MAIN: 'main',
  PROGRESS: 'progress',
} as const;

export type SidebarView = (typeof SIDEBAR_VIEWS)[keyof typeof SIDEBAR_VIEWS];

let activeSidebarView: SidebarView = SIDEBAR_VIEWS.MAIN;

export function getActiveSidebarView(): SidebarView {
  return activeSidebarView;
}

/**
 * Sole writer of "which surface the sidebar shows". The `texra.activeView`
 * context key is a projection of this value, pushed without awaiting so a
 * caller commits its content swap in the same tick it claims the surface.
 * That leaves no window for a second switch to interleave.
 */
export function setActiveSidebarView(view: SidebarView): void {
  activeSidebarView = view;
  void vscode.commands
    .executeCommand('setContext', TEXRA_ACTIVE_VIEW_CONTEXT_KEY, view)
    .then(undefined, (error: unknown) => {
      log.error(
        `Failed to publish the ${TEXRA_ACTIVE_VIEW_CONTEXT_KEY} context key`,
        { data: error },
      );
    });
}
