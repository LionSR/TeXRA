import * as vscode from 'vscode';

// The welcome view is a tree view declared in package.json with `viewsWelcome`
// content. It becomes visible when `texra.activated` is unset (no-folder or
// multi-root). Registering an empty data provider satisfies VS Code's tree
// view contract; the actual copy and command links come from the
// `contributes.viewsWelcome` block. When the workspace becomes single-folder,
// reload the window so the full activation path runs.
export function registerWelcomeView(context: vscode.ExtensionContext): void {
  const emptyProvider: vscode.TreeDataProvider<never> = {
    getTreeItem: () => {
      throw new Error('texra.welcomeView has no tree items');
    },
    getChildren: () => [],
  };

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('texra.welcomeView', emptyProvider),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (vscode.workspace.workspaceFolders?.length === 1) {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    }),
  );
}
