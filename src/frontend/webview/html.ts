// VS Code imports
import * as vscode from 'vscode';
import { nanoid } from 'nanoid';

// Local imports
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
  const nonce = nanoid(32);

  let result = htmlContent
    .replaceAll('${nonce}', nonce)
    .replaceAll('${cspSource}', webview.cspSource);

  for (const [key, value] of Object.entries(replacements)) {
    const replaced =
      value instanceof vscode.Uri
        ? webview.asWebviewUri(value).toString()
        : value;
    result = result.replaceAll(new RegExp(`\\$\\{${key}\\}`, 'g'), replaced);
  }

  return result;
}
