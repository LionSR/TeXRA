// Third-party imports
import * as vscode from 'vscode';

export function getSharedLocalResourceRoots(
  context: vscode.ExtensionContext,
  viewFolder: string,
): vscode.Uri[] {
  const { extensionUri } = context;

  return [
    vscode.Uri.joinPath(extensionUri, 'src', viewFolder),
    vscode.Uri.joinPath(extensionUri, 'dist', viewFolder),
    vscode.Uri.joinPath(extensionUri, 'dist', 'shared'),
    vscode.Uri.joinPath(extensionUri, 'src', 'common', 'styles'),
    vscode.Uri.joinPath(extensionUri, 'src', 'shared', 'styles'),
    vscode.Uri.joinPath(extensionUri, 'src', 'common', 'modules'),
    vscode.Uri.joinPath(extensionUri, 'src', 'common', 'webview'),
    vscode.Uri.joinPath(extensionUri, 'src', 'common', 'constants'),
  ];
}

/**
 * Build local resource roots covering multiple view folders.
 * The per-folder src/dist entries are unique; shared roots are deduplicated.
 */
export function getCombinedLocalResourceRoots(
  context: vscode.ExtensionContext,
  viewFolders: string[],
): vscode.Uri[] {
  const seen = new Set<string>();
  const roots: vscode.Uri[] = [];
  for (const folder of viewFolders) {
    for (const uri of getSharedLocalResourceRoots(context, folder)) {
      const key = uri.toString();
      if (!seen.has(key)) {
        seen.add(key);
        roots.push(uri);
      }
    }
  }
  return roots;
}
