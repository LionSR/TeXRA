import * as vscode from 'vscode';
import { nanoid } from 'nanoid';

import { createLog } from '@logger/logUtils';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { toErrorMessage } from '@utils/errors/errorMessage';

/**
 * Build HTML content for a webview by replacing placeholder tokens.
 */
function buildWebviewHtml(
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
    const resolved =
      value instanceof vscode.Uri
        ? webview.asWebviewUri(value).toString()
        : value;
    result = result.replaceAll(`\${${key}}`, resolved);
  }

  return result;
}

/** Where a view's Vite-built assets land and the template keys they fill. */
export interface ViewBundle {
  /** Directory under `dist/` holding the view's `bundle.js` / `index.css`. */
  dist: string;
  /** Template variable for the JS bundle URI. */
  bundleKey: string;
  /** Template variable for the stylesheet URI. */
  styleKey: string;
}

/**
 * Content provider for views whose view-specific assets are a Vite bundle and
 * stylesheet under `dist/`. Covers the main, progress, and settings views.
 */
export class BundledViewContentProvider {
  private readonly channel: string;
  private readonly viewPath: string;

  private get log() {
    return createLog(this.channel);
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly viewName: string,
    private readonly bundle: ViewBundle,
    viewPath?: string,
  ) {
    this.channel = `${viewName}ContentProvider`;
    // Default: convert 'HistoryView' to 'historyView'
    this.viewPath =
      viewPath ?? viewName.charAt(0).toLowerCase() + viewName.slice(1);
  }

  public getHtmlContent(webview: vscode.Webview): string {
    try {
      const htmlPath = vscode.Uri.joinPath(
        this.context.extensionUri,
        'src',
        this.viewPath,
        'index.html',
      );

      this.log.debug(`Generated HTML content for ${this.viewName}`);

      return buildWebviewHtml(webview, htmlPath, {
        commonStyleUri: this.buildUri(webview, [
          'src',
          'common',
          'styles/common.css',
        ]),
        [this.bundle.bundleKey]: this.buildUri(webview, [
          'dist',
          this.bundle.dist,
          'bundle.js',
        ]),
        [this.bundle.styleKey]: this.buildUri(webview, [
          'dist',
          this.bundle.dist,
          'index.css',
        ]),
      });
    } catch (err) {
      this.log.error(`Error generating HTML content: ${toErrorMessage(err)}`);
      return '<html><body>Error loading content</body></html>';
    }
  }

  private buildUri(
    webview: vscode.Webview,
    pathSegments: string[],
  ): vscode.Uri {
    return webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, ...pathSegments),
    );
  }
}
