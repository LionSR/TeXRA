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
  replacements: Record<string, vscode.Uri>,
): string {
  const htmlContent = AbsoluteFS.readSync(htmlPath.fsPath);
  const nonce = nanoid(32);

  let result = htmlContent
    .replaceAll('${nonce}', nonce)
    .replaceAll('${cspSource}', webview.cspSource);

  for (const [key, value] of Object.entries(replacements)) {
    result = result.replaceAll(
      `\${${key}}`,
      webview.asWebviewUri(value).toString(),
    );
  }

  return result;
}

/**
 * Content provider for views whose view-specific assets are a Vite bundle and
 * stylesheet under `dist/`. Covers the main, progress, and settings views.
 */
export class BundledViewContentProvider {
  private readonly log: ReturnType<typeof createLog>;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly viewName: string,
    /**
     * The one folder name a view owns: `src/<viewFolder>/index.html` holds its
     * template and `dist/<viewFolder>/` its Vite output (see `vite.config.mts`,
     * which builds both paths from the same list).
     */
    private readonly viewFolder: string,
  ) {
    this.log = createLog(`${viewName}ContentProvider`);
  }

  public getHtmlContent(webview: vscode.Webview): string {
    try {
      const htmlPath = vscode.Uri.joinPath(
        this.context.extensionUri,
        'src',
        this.viewFolder,
        'index.html',
      );

      this.log.debug(`Generated HTML content for ${this.viewName}`);

      return buildWebviewHtml(webview, htmlPath, {
        commonStyleUri: this.buildUri(['src', 'common', 'styles/common.css']),
        bundleUri: this.buildUri(['dist', this.viewFolder, 'bundle.js']),
        styleUri: this.buildUri(['dist', this.viewFolder, 'index.css']),
      });
    } catch (err) {
      this.log.error(`Error generating HTML content: ${toErrorMessage(err)}`);
      return '<html><body>Error loading content</body></html>';
    }
  }

  private buildUri(pathSegments: string[]): vscode.Uri {
    return vscode.Uri.joinPath(this.context.extensionUri, ...pathSegments);
  }
}
