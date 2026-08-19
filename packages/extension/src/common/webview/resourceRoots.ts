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
    vscode.Uri.joinPath(extensionUri, 'src', 'common', 'styles'),
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
  const byKey = new Map(
    viewFolders
      .flatMap((folder) => getSharedLocalResourceRoots(context, folder))
      .map((uri) => [uri.toString(), uri] as const),
  );
  return [...byKey.values()];
}
