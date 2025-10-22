// Third-party imports
import * as vscode from 'vscode';

// Local imports - common
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

  constructor(
    protected readonly context: vscode.ExtensionContext,
    protected readonly viewName: string,
  ) {
    this.logger = logger;
    this.channel = `${viewName}ContentProvider`;
    logger.initialize(this.channel);
  }

  /**
   * Subclasses must provide the relative path to their view directory
   */
  protected abstract getViewPath(): string;

  /**
   * Subclasses must provide their specific module URIs
   */
  protected abstract getModuleUris(
    webview: vscode.Webview,
  ): Record<string, vscode.Uri>;

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
    descriptors: ModuleDescriptor[],
  ): Record<string, vscode.Uri> {
    return descriptors.reduce<Record<string, vscode.Uri>>((acc, d) => {
      acc[d.key] = this.getWebviewUri(webview, d.path);
      return acc;
    }, {});
  }

  /** URIs shared by all views */
  private getSharedModuleUris(
    webview: vscode.Webview,
  ): Record<string, vscode.Uri> {
    return this.buildUriRecord(webview, this.sharedModuleDescriptors);
  }

  /**
   * Standard implementation that subclasses can override if needed
   */
  public getHtmlContent(webview: vscode.Webview): string {
    try {
      const htmlPath = this.getWebviewPath('index.html');
      const commonUris = this.getCommonModuleUris(webview);
      const sharedUris = this.getSharedModuleUris(webview);
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
        `Error generating HTML content: ${err instanceof Error ? err.message : String(err)}`,
      );
      return '<html><body>Error loading content</body></html>';
    }
  }

  /**
   * Common URIs used by all views
   */
  private getCommonModuleUris(
    webview: vscode.Webview,
  ): Record<string, vscode.Uri> {
    return {
      commonStyleUri: this.getCommonUri(webview, 'styles/common.css'),
      vscodeElementsBundleUri: this.getNodeModulesUri(
        webview,
        '@vscode-elements/elements/dist/bundled.js',
      ),
      webviewStateUri: this.getCommonUri(webview, 'modules/webviewState.js'),
      webviewContextUri: this.getCommonUri(
        webview,
        'modules/webviewContext.js',
      ),
      commandsUri: this.getCommonUri(webview, 'webview/commands.js'),
      webviewThemeHandlersUri: this.getCommonUri(
        webview,
        'webview/themeHandlers.js',
      ),
      templateUtilsUri: this.getCommonUri(webview, 'modules/templateUtils.js'),
      recordingButtonManagerUri: this.getCommonUri(
        webview,
        'modules/RecordingButtonManager.js',
      ),
      textareaUtilsUri: this.getCommonUri(webview, 'modules/textareaUtils.js'),
      htmlEncodingUri: this.getCommonUri(webview, 'modules/htmlEncoding.js'),
      iconConstantsUri: this.getCommonUri(webview, 'modules/iconConstants.js'),
      baseWebviewMessageHandlerUri: this.getCommonUri(
        webview,
        'modules/BaseWebviewMessageHandler.js',
      ),
      domUtilsUri: this.getCommonUri(webview, 'modules/domUtils.js'),
      baseDomHandlerUri: this.getCommonUri(
        webview,
        'modules/BaseDomHandler.js',
      ),
      stringUtilsUri: this.getCommonUri(webview, 'modules/stringUtils.js'),
      pathUtilsUri: this.getCommonUri(webview, 'modules/pathUtils.js'),
      codiconUri: this.getNodeModulesUri(
        webview,
        '@vscode/codicons/dist/codicon.css',
      ),
      codiconsFontUri: this.getNodeModulesUri(
        webview,
        '@vscode/codicons/dist/codicon.ttf',
      ),
    };
  }
}
