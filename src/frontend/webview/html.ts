// VS Code imports
import * as vscode from 'vscode';

// Local imports
import { generateNonce } from '../nonce';
import { AbsoluteFS } from '@utils/files';

/**
 * Build HTML content for a webview by replacing placeholder tokens.
 */
export function buildWebviewHtml(
  webview: vscode.Webview,
  htmlPath: vscode.Uri,
  replacements: Record<string, vscode.Uri | string>,
): string {
  const htmlContent = AbsoluteFS.readSync(htmlPath.fsPath);
  const nonce = generateNonce();

  let result = htmlContent
    .replace(/\${nonce}/g, nonce)
    .replace(/\${cspSource}/g, webview.cspSource);

  for (const [key, value] of Object.entries(replacements)) {
    const replaced =
      value instanceof vscode.Uri
        ? webview.asWebviewUri(value).toString()
        : value;
    result = result.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), replaced);
  }

  return result;
}
