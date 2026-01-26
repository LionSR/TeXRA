// Third-party imports
import * as vscode from 'vscode';

// Local imports - common
import { toErrorMessage } from '@common/errors';
import { buildWebviewHtml } from '@frontend/webview/html';
import * as logger from '@logger/logUtils';

/** Descriptor for a webview module resource. */
export interface ModuleDescriptor {
  key: string;
  path: string;
}

/**
 * Base class for all webview content providers.
 * Eliminates code duplication and provides consistent patterns.
 */
export abstract class BaseViewContentProvider {
  protected readonly logger: any;
  protected readonly channel: string;
  private readonly viewPath: string;

  /**
   * @param context - VS Code extension context
   * @param viewName - Name of this view (used for logging)
   * @param moduleDescriptors - Optional view-specific module descriptors.
   *   If provided, getModuleUris() will automatically build URIs from these.
   *   If not provided, subclasses must override getModuleUris().
   * @param viewPath - Optional view folder path. Defaults to camelCase of viewName.
   */
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

  /**
   * Returns the relative path to the view directory.
   */
  protected getViewPath(): string {
    return this.viewPath;
  }

  /**
   * Returns view-specific module URIs. Default implementation uses
   * moduleDescriptors passed to constructor. Subclasses can override
   * for custom URI generation.
   */
  protected getModuleUris(webview: vscode.Webview): Record<string, vscode.Uri> {
    return this.buildUriRecord(webview, this.moduleDescriptors);
  }

  /**
   * Optional: Override to provide additional template variables
   */
  protected getTemplateVariables(): Record<string, any> {
    return {};
  }

  /** Shared module descriptors available to all views */
  private readonly sharedModuleDescriptors: ModuleDescriptor[] = [
    { key: 'styleUri', path: 'styles/index.css' },
    { key: 'scriptUri', path: 'script.js' },
    { key: 'domHandlersUri', path: 'modules/domHandlers.js' },
    { key: 'constantsUri', path: 'modules/constants.js' },
    { key: 'messageHandlersUri', path: 'modules/messageHandlers.js' },
  ];

  /**
   * Common method to get webview paths
   */
  protected getWebviewPath(filePath: string): vscode.Uri {
    return vscode.Uri.joinPath(
      this.context.extensionUri,
      'src',
      this.getViewPath(),
      filePath,
    );
  }

  protected getWebviewUri(webview: vscode.Webview, path: string): vscode.Uri {
    return webview.asWebviewUri(this.getWebviewPath(path));
  }

  protected getCommonUri(webview: vscode.Webview, path: string): vscode.Uri {
    return webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'src', 'common', path),
    );
  }

  protected getNodeModulesUri(
    webview: vscode.Webview,
    path: string,
  ): vscode.Uri {
    return webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', path),
    );
  }

  /** Convert an array of descriptors into a URI record */
  protected buildUriRecord(
    webview: vscode.Webview,
    descriptors: readonly ModuleDescriptor[],
  ): Record<string, vscode.Uri> {
    return Object.fromEntries(
      descriptors.map((d) => [d.key, this.getWebviewUri(webview, d.path)]),
    );
  }

  /**
   * Standard implementation that subclasses can override if needed
   */
  public getHtmlContent(webview: vscode.Webview): string {
    try {
      const htmlPath = this.getWebviewPath('index.html');
      const commonUris = this.getCommonModuleUris(webview);
      const sharedUris = this.buildUriRecord(
        webview,
        this.sharedModuleDescriptors,
      );
      const specificUris = this.getModuleUris(webview);
      const templateVariables = this.getTemplateVariables();

      this.logger.debug(
        this.channel,
        `Generated HTML content for ${this.viewName}`,
      );

      return buildWebviewHtml(webview, htmlPath, {
        ...commonUris,
        ...sharedUris,
        ...specificUris,
        ...templateVariables,
      });
    } catch (err) {
      this.logger.error(
        this.channel,
        `Error generating HTML content: ${toErrorMessage(err)}`,
      );
      return '<html><body>Error loading content</body></html>';
    }
  }

  /** Common module descriptors from src/common */
  private static readonly COMMON_MODULE_DESCRIPTORS: readonly ModuleDescriptor[] =
    [{ key: 'commonStyleUri', path: 'styles/common.css' }];

  /** Node module descriptors from node_modules */
  private static readonly NODE_MODULE_DESCRIPTORS: readonly ModuleDescriptor[] =
    [
      {
        key: 'vscodeElementsBundleUri',
        path: '@vscode-elements/elements/dist/bundled.js',
      },
      { key: 'codiconUri', path: '@vscode/codicons/dist/codicon.css' },
      { key: 'codiconsFontUri', path: '@vscode/codicons/dist/codicon.ttf' },
    ];

  /** Build URI record using a resolver function */
  private buildUrisWithResolver(
    webview: vscode.Webview,
    descriptors: readonly ModuleDescriptor[],
    resolver: (webview: vscode.Webview, path: string) => vscode.Uri,
  ): Record<string, vscode.Uri> {
    return Object.fromEntries(
      descriptors.map(({ key, path }) => [
        key,
        resolver.call(this, webview, path),
      ]),
    );
  }

  /** Common URIs used by all views (from src/common and node_modules) */
  private getCommonModuleUris(
    webview: vscode.Webview,
  ): Record<string, vscode.Uri> {
    return {
      ...this.buildUrisWithResolver(
        webview,
        BaseViewContentProvider.COMMON_MODULE_DESCRIPTORS,
        this.getCommonUri,
      ),
      ...this.buildUrisWithResolver(
        webview,
        BaseViewContentProvider.NODE_MODULE_DESCRIPTORS,
        this.getNodeModulesUri,
      ),
      tokensStyleUri: webview.asWebviewUri(
        vscode.Uri.joinPath(
          this.context.extensionUri,
          'src',
          'shared',
          'styles',
          'tokens.css',
        ),
      ),
    };
  }
}
