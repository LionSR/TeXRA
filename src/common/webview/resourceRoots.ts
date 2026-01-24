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
    vscode.Uri.joinPath(extensionUri, 'src', 'common', 'modules'),
    vscode.Uri.joinPath(extensionUri, 'src', 'common', 'webview'),
    vscode.Uri.joinPath(extensionUri, 'src', 'common', 'constants'),
    vscode.Uri.joinPath(
      extensionUri,
      'node_modules',
      '@vscode',
      'codicons',
      'dist',
    ),
    vscode.Uri.joinPath(
      extensionUri,
      'node_modules',
      '@vscode-elements',
      'elements',
      'dist',
    ),
  ];
}
