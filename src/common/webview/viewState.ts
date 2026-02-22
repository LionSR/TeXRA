// Third-party imports
import * as vscode from 'vscode';

export const TEXRA_ACTIVE_VIEW_CONTEXT_KEY = 'texra.activeView';

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
