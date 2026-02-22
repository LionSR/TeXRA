// Third-party imports
import * as vscode from 'vscode';

export const TEXRA_ACTIVE_VIEW_CONTEXT_KEY = 'texra.activeView';
export const TEXRA_VIEW_CONTAINER_ID = 'texra';
export const TEXRA_VIEW_CONTAINER_COMMAND_ID = 'workbench.view.extension.texra';
export const TEXRA_VIEW_IDS = ['texra.mainView', 'texra.progressView'] as const;

export const SIDEBAR_VIEWS = {
  MAIN: 'main',
  PROGRESS: 'progress',
} as const;

export type SidebarView = (typeof SIDEBAR_VIEWS)[keyof typeof SIDEBAR_VIEWS];

let activeSidebarView: SidebarView = SIDEBAR_VIEWS.MAIN;

export function getActiveSidebarView(): SidebarView {
  return activeSidebarView;
}

export async function setActiveSidebarView(view: SidebarView): Promise<void> {
  activeSidebarView = view;
  await vscode.commands.executeCommand(
    'setContext',
    TEXRA_ACTIVE_VIEW_CONTEXT_KEY,
    view,
  );
}

/**
 * Ensure Launcher and Progress stay in the same TeXRA container.
 *
 * VS Code persists per-view locations, so older layouts can split the two views
 * across different containers. Our context-key swap logic assumes co-location.
 */
export async function ensureTeXRAViewsCoLocated(): Promise<void> {
  for (const destinationId of [
    TEXRA_VIEW_CONTAINER_COMMAND_ID,
    TEXRA_VIEW_CONTAINER_ID,
  ]) {
    try {
      await vscode.commands.executeCommand('vscode.moveViews', {
        viewIds: [...TEXRA_VIEW_IDS],
        destinationId,
      });
      return;
    } catch {
      // Try the next destination id variant.
    }
  }
}
