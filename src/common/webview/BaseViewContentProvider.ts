import * as vscode from 'vscode';

import { toErrorMessage } from '@common/errors';
import { buildWebviewHtml } from '@frontend/webview/html';
import * as logger from '@logger/logUtils';

export interface ModuleDescriptor {
  key: string;
  path: string;
}

export abstract class BaseViewContentProvider {
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
    logger.initialize(this.channel);
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

  private buildUri(
    webview: vscode.Webview,
    pathSegments: string[],
  ): vscode.Uri {
    return webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, ...pathSegments),
    );
  }

  private buildUriRecord(
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

  private static readonly NODE_MODULE_DESCRIPTORS: readonly ModuleDescriptor[] =
    [
      {
        key: 'vscodeElementsBundleUri',
        path: '@vscode-elements/elements/dist/bundled.js',
      },
      { key: 'codiconUri', path: '@vscode/codicons/dist/codicon.css' },
      { key: 'codiconsFontUri', path: '@vscode/codicons/dist/codicon.ttf' },
    ];

  private getCommonModuleUris(
    webview: vscode.Webview,
  ): Record<string, vscode.Uri> {
    return {
      ...this.buildUriRecord(
        webview,
        BaseViewContentProvider.COMMON_MODULE_DESCRIPTORS,
        ['src', 'common'],
      ),
      ...this.buildUriRecord(
        webview,
        BaseViewContentProvider.NODE_MODULE_DESCRIPTORS,
        ['node_modules'],
      ),
      tokensStyleUri: this.buildUri(webview, [
        'src',
        'shared',
        'styles',
        'tokens.css',
      ]),
    };
  }
}
