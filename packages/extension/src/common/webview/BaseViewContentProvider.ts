import * as vscode from 'vscode';

import * as logger from '@logger/logUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { buildWebviewHtml } from './html';

interface ModuleDescriptor {
  key: string;
  path: string;
}

abstract class BaseViewContentProvider {
  protected readonly logger: typeof logger;
  protected readonly channel: string;
  private readonly viewPath: string;

  constructor(
    protected readonly context: vscode.ExtensionContext,
    protected readonly viewName: string,
    private readonly moduleDescriptors: readonly ModuleDescriptor[] = [],
    viewPath?: string,
  ) {
    this.logger = logger;
    this.channel = `${viewName}ContentProvider`;
    // Default: convert 'HistoryView' to 'historyView'
    this.viewPath =
      viewPath ?? viewName.charAt(0).toLowerCase() + viewName.slice(1);
  }

  protected getViewPath(): string {
    return this.viewPath;
  }

  protected getModuleUris(webview: vscode.Webview): Record<string, vscode.Uri> {
    return this.buildUriRecord(webview, this.moduleDescriptors, [
      'src',
      this.getViewPath(),
    ]);
  }

  protected getTemplateVariables(): Record<string, string | vscode.Uri> {
    return {};
  }

  protected buildUri(
    webview: vscode.Webview,
    pathSegments: string[],
  ): vscode.Uri {
    return webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, ...pathSegments),
    );
  }

  protected buildUriRecord(
    webview: vscode.Webview,
    descriptors: readonly ModuleDescriptor[],
    basePath: string[],
  ): Record<string, vscode.Uri> {
    return Object.fromEntries(
      descriptors.map(({ key, path }) => [
        key,
        this.buildUri(webview, [...basePath, path]),
      ]),
    );
  }

  public getHtmlContent(webview: vscode.Webview): string {
    try {
      const htmlPath = vscode.Uri.joinPath(
        this.context.extensionUri,
        'src',
        this.getViewPath(),
        'index.html',
      );

      this.logger.debug(
        this.channel,
        `Generated HTML content for ${this.viewName}`,
      );

      return buildWebviewHtml(webview, htmlPath, {
        ...this.getCommonModuleUris(webview),
        ...this.getModuleUris(webview),
        ...this.getTemplateVariables(),
      });
    } catch (err) {
      this.logger.error(
        this.channel,
        `Error generating HTML content: ${toErrorMessage(err)}`,
      );
      return '<html><body>Error loading content</body></html>';
    }
  }

  private static readonly COMMON_MODULE_DESCRIPTORS: readonly ModuleDescriptor[] =
    [{ key: 'commonStyleUri', path: 'styles/common.css' }];

  private getCommonModuleUris(
    webview: vscode.Webview,
  ): Record<string, vscode.Uri> {
    return this.buildUriRecord(
      webview,
      BaseViewContentProvider.COMMON_MODULE_DESCRIPTORS,
      ['src', 'common'],
    );
  }
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
 * Content provider for views whose only view-specific assets are a Vite
 * bundle and stylesheet under `dist/`. Covers the main, progress, and
 * settings views; subclass {@link BaseViewContentProvider} directly only
 * when a view needs more than that.
 */
export class BundledViewContentProvider extends BaseViewContentProvider {
  constructor(
    context: vscode.ExtensionContext,
    viewName: string,
    private readonly bundle: ViewBundle,
    viewPath?: string,
  ) {
    super(context, viewName, [], viewPath);
  }

  protected override getModuleUris(
    webview: vscode.Webview,
  ): Record<string, vscode.Uri> {
    return this.buildUriRecord(
      webview,
      [
        { key: this.bundle.bundleKey, path: 'bundle.js' },
        { key: this.bundle.styleKey, path: 'index.css' },
      ],
      ['dist', this.bundle.dist],
    );
  }
}
