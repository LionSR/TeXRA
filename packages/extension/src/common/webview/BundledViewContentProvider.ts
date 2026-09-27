import { Cause, Data, Effect, FileSystem } from 'effect';
import * as vscode from 'vscode';
import { nanoid } from 'nanoid';

import { withLogChannel } from '@logger/effectLog';
import { HOST_BRIDGE_API_KEY } from '@shared/hostBridgeTypes';
import { escapeAttr } from '@shared/utils/xmlEscape';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { normalizeLineEndings } from '@utils/text/stringUtils';

/** A view's HTML template has no `<body>` to install the host bridge into. */
class WebviewTemplateMissingBody extends Data.TaggedError(
  'WebviewTemplateMissingBody',
)<{ readonly htmlPath: string }> {
  override get message(): string {
    return `Webview template is missing a <body> tag: ${this.htmlPath}`;
  }
}

/**
 * Installs the host bridge at `HOST_BRIDGE_API_KEY` before the webview
 * bundle loads, mirroring `installElectronHostBridge` (desktop) and
 * `installTraceHostBridge` (trace viewer): every host pre-populates the
 * global itself, so `@shared/hostBridge` never needs to know a
 * VS Code-specific API exists.
 */
function buildHostBridgeBootstrapScript(nonce: string): string {
  return `<script nonce="${nonce}">window.${HOST_BRIDGE_API_KEY} = acquireVsCodeApi();</script>`;
}

const buildWebviewHtml = Effect.fnUntraced(function* (
  webview: vscode.Webview,
  htmlPath: vscode.Uri,
  replacements: Record<string, vscode.Uri>,
  attributes: Record<string, string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const htmlContent = normalizeLineEndings(
    yield* fs.readFileString(htmlPath.fsPath),
  );
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
  for (const [key, value] of Object.entries(attributes)) {
    result = result.replaceAll(`\${${key}}`, escapeAttr(value));
  }

  const bodyTag = /<body\b[^>]*>/i;
  if (!bodyTag.test(result)) {
    return yield* new WebviewTemplateMissingBody({ htmlPath: htmlPath.fsPath });
  }
  return result.replace(
    bodyTag,
    (tag) => `${tag}\n    ${buildHostBridgeBootstrapScript(nonce)}`,
  );
});

/**
 * Content provider for views whose view-specific assets are a Vite bundle and
 * stylesheet under `dist/`. Covers the main, progress, and settings views.
 */
export class BundledViewContentProvider {
  private readonly channel: string;

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
    this.channel = `${viewName}ContentProvider`;
  }

  /**
   * `attributes` are the view's own HTML tokens, escaped for an attribute
   * value: the progress view carries its session key as
   * `<progress-app data-session>`, which is how the bundle knows which
   * session to subscribe to before any frame arrives.
   */
  public getHtmlContent(
    webview: vscode.Webview,
    attributes: Record<string, string> = {},
  ): Effect.Effect<string, never, FileSystem.FileSystem> {
    const htmlPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      'src',
      this.viewFolder,
      'index.html',
    );
    return buildWebviewHtml(
      webview,
      htmlPath,
      {
        commonStyleUri: this.buildUri(['src', 'common', 'styles/common.css']),
        bundleUri: this.buildUri(['dist', this.viewFolder, 'bundle.js']),
        styleUri: this.buildUri(['dist', this.viewFolder, 'index.css']),
      },
      attributes,
    ).pipe(
      Effect.tap(() =>
        Effect.logDebug(`Generated HTML content for ${this.viewName}`).pipe(
          withLogChannel(this.channel),
        ),
      ),
      // A view that cannot render its template still gets a page: the
      // failure is logged here, once, with its cause.
      Effect.catchCause((cause) =>
        Effect.logError(
          `Error generating HTML content: ${toErrorMessage(Cause.squash(cause))}`,
        ).pipe(
          withLogChannel(this.channel),
          Effect.as('<html><body>Error loading content</body></html>'),
        ),
      ),
    );
  }

  private buildUri(pathSegments: string[]): vscode.Uri {
    return vscode.Uri.joinPath(this.context.extensionUri, ...pathSegments);
  }
}
