import * as fs from 'fs';
import * as vscode from 'vscode';
import { generateNonce } from './nonceUtils';

/**
 * Build HTML content for a webview by replacing placeholder tokens.
 */
export function buildWebviewHtml(
  webview: vscode.Webview,
  htmlPath: vscode.Uri,
  replacements: Record<string, vscode.Uri | string>,
): string {
  const htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf-8');
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
