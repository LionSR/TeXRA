import { randomBytes } from 'node:crypto';

import { Effect, FileSystem, Schema } from 'effect';
import * as vscode from 'vscode';

import {
  toErrorMessage,
  escapeAttr,
  escapeText,
} from '@texra-ai/harness/schemas';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import { announce, reportingFailure } from '@frontend/ui/errorHandlingUtils';
import { HOST_BRIDGE_API_KEY } from '@texra/shared/hostBridgeTypes';

const RETRY_ACTION = 'Retry';

/** The page a view shows when its own could not be built. It runs no script,
 *  so the Retry action is on the notice shown with it. */
function loadFailurePage(message: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'" />
  </head>
  <body>
    <h3>This view could not load</h3>
    <p>${escapeText(message)}</p>
    <p>
      Choose ${RETRY_ACTION} in the notification, or reload the window. The
      TeXRA output channel (View &rsaquo; Output) has the details.
    </p>
  </body>
</html>`;
}

/** A view's HTML template has no `<body>` to install the host bridge into. */
class WebviewTemplateMissingBody extends Schema.TaggedError<WebviewTemplateMissingBody>()(
  'WebviewTemplateMissingBody',
  {
    htmlPath: Schema.String,
  },
) {
  override get message(): string {
    return `Webview template is missing a <body> tag: ${this.htmlPath}`;
  }
}

/**
 * Installs the host bridge at `HOST_BRIDGE_API_KEY` before the webview
 * bundle loads, mirroring `installElectronHostBridge` (desktop) and
 * `installTraceHostBridge` (trace viewer): every host pre-populates the
 * global itself, so `@texra/shared/hostBridge` never needs to know a
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
  const htmlContent = (yield* fs.readFileString(htmlPath.fsPath)).replaceAll(
    '\r\n',
    '\n',
  );
  // 32 URL-safe base64 characters, 192 random bits.
  const nonce = randomBytes(24).toString('base64url');

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
  private readonly context: vscode.ExtensionContext;
  /** The view's title as its tab shows it; a load failure names it. */
  private readonly viewName: string;
  /**
   * The one folder name a view owns: `src/<viewFolder>/index.html` holds its
   * template and `dist/<viewFolder>/` its Vite output (see `vite.config.mts`,
   * which builds both paths from the same list).
   */
  private readonly viewFolder: string;
  constructor(
    context: vscode.ExtensionContext,
    viewName: string,
    viewFolder: string,
  ) {
    this.context = context;
    this.viewName = viewName;
    this.viewFolder = viewFolder;
  }

  /** The folders the view's page may load from: its own and the shared
   *  stylesheet's. */
  public get localResourceRoots(): vscode.Uri[] {
    return [
      this.buildUri(['src', this.viewFolder]),
      this.buildUri(['dist', this.viewFolder]),
      this.buildUri(['src', 'common', 'styles']),
    ];
  }

  /**
   * Builds the view's page and hands it to `paint`, logged on the caller's
   * channel. `paint` decides whether its webview still takes a page.
   *
   * A page that cannot be built is reported once per attempt: the cause is
   * logged, painted in place of the view, and shown in a notice whose Retry
   * builds the page again. The effect ends when a page is painted or that
   * notice is dismissed.
   *
   * `attributes` are the view's own HTML tokens, escaped for an attribute
   * value: the progress view carries its session key as
   * `<progress-app data-session>`, which is how the bundle knows which
   * session to subscribe to before any frame arrives.
   */
  public render(
    webview: vscode.Webview,
    paint: (html: string) => void,
    attributes: Record<string, string> = {},
  ): Effect.Effect<void, never, FileSystem.FileSystem> {
    const htmlPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      'src',
      this.viewFolder,
      'index.html',
    );
    const attempt: Effect.Effect<void, never, FileSystem.FileSystem> =
      buildWebviewHtml(
        webview,
        htmlPath,
        {
          commonStyleUri: this.buildUri(['src', 'common', 'styles/common.css']),
          bundleUri: this.buildUri(['dist', this.viewFolder, 'bundle.js']),
          styleUri: this.buildUri(['dist', this.viewFolder, 'index.css']),
        },
        attributes,
      ).pipe(
        Effect.tap((html) =>
          Effect.logDebug(`Generated HTML content for ${this.viewName}`).pipe(
            Effect.andThen(Effect.sync(() => paint(html))),
          ),
        ),
        Effect.asVoid,
        reportingFailure((error) =>
          Effect.gen({ self: this }, function* () {
            const message = `Could not load ${this.viewName}: ${toErrorMessage(error)}`;
            paint(loadFailurePage(message));
            yield* Effect.logError(message);
            const choice = yield* announce(
              vscodeUi.ask('error', message, { items: [RETRY_ACTION] }),
              undefined,
            );
            if (choice === RETRY_ACTION) yield* attempt;
          }),
        ),
      );
    return attempt;
  }

  private buildUri(pathSegments: string[]): vscode.Uri {
    return vscode.Uri.joinPath(this.context.extensionUri, ...pathSegments);
  }
}
