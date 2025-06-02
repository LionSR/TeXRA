// Standard library imports
import * as fs from 'fs';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';
import { generateNonce } from '../utils/nonceUtils';

const CHANNEL = 'Webview';
logger.initialize(CHANNEL);

export class ProgressViewContentProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getHtmlContent(webview: vscode.Webview): string {
    try {
      const getWebviewPath = (filePath: string) =>
        vscode.Uri.joinPath(
          this.context.extensionUri,
          'src',
          'progressView',
          filePath,
        );
      const getCommonPath = (path: string) =>
        vscode.Uri.joinPath(this.context.extensionUri, 'src', 'common', path);
      const getNodeModulesPath = (path: string) =>
        vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', path);

      const htmlPath = getWebviewPath('index.html');
      const cssPath = getWebviewPath('styles/index.css');
      const commonCssPath = getCommonPath('styles/common.css');
      const scriptPath = getWebviewPath('script.js');
      const splitJsPath = getNodeModulesPath('split.js/dist/split.es.js');
      const webviewStatePath = getCommonPath('modules/webviewState.js');

      // Module paths
      const vscodeApiPath = getCommonPath('modules/vscodeApi.js');
      const stateManagerPath = getWebviewPath('modules/stateManager.js');
      const messageHandlersPath = getWebviewPath('modules/messageHandlers.js');
      const domHandlersPath = getWebviewPath('modules/domHandlers.js');
      const constantsPath = getWebviewPath('modules/constants.js');
      const logFormattersPath = getWebviewPath('modules/logFormatters.js');
      const templateUtilsPath = getCommonPath('modules/templateUtils.js');

      const codiconPath = getNodeModulesPath(
        '@vscode/codicons/dist/codicon.css',
      );
      const codiconsFontPath = getNodeModulesPath(
        '@vscode/codicons/dist/codicon.ttf',
      );
      const htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf-8');
      const nonce = generateNonce();
      const styleUri = webview.asWebviewUri(cssPath);
      const commonStyleUri = webview.asWebviewUri(commonCssPath);
      const scriptUri = webview.asWebviewUri(scriptPath);
      const splitJsUri = webview.asWebviewUri(splitJsPath);
      const codiconUri = webview.asWebviewUri(codiconPath);
      const codiconsFontUri = webview.asWebviewUri(codiconsFontPath);
      const templateUtilsUri = webview.asWebviewUri(templateUtilsPath);

      // Module URIs
      const vscodeApiUri = webview.asWebviewUri(vscodeApiPath);
      const webviewStateUri = webview.asWebviewUri(webviewStatePath);
      const stateManagerUri = webview.asWebviewUri(stateManagerPath);
      const messageHandlersUri = webview.asWebviewUri(messageHandlersPath);
      const domHandlersUri = webview.asWebviewUri(domHandlersPath);
      const constantsUri = webview.asWebviewUri(constantsPath);
      const logFormattersUri = webview.asWebviewUri(logFormattersPath);

      // Replace placeholders in HTML with actual content
      logger.debug(CHANNEL, 'Generated HTML content for ProgressView');
      return htmlContent
        .replace('${commonStyleUri}', commonStyleUri.toString())
        .replace('${styleUri}', styleUri.toString())
        .replace('${scriptUri}', scriptUri.toString())
        .replace('${splitJsUri}', splitJsUri.toString())
        .replace('${codiconUri}', codiconUri.toString())
        .replace('${codiconsFontUri}', codiconsFontUri.toString())
        .replace('${vscodeApiUri}', vscodeApiUri.toString())
        .replace('${webviewStateUri}', webviewStateUri.toString())
        .replace('${stateManagerUri}', stateManagerUri.toString())
        .replace('${messageHandlersUri}', messageHandlersUri.toString())
        .replace('${domHandlersUri}', domHandlersUri.toString())
        .replace('${templateUtilsUri}', templateUtilsUri.toString())
        .replace('${constantsUri}', constantsUri.toString())
        .replace('${logFormattersUri}', logFormattersUri.toString())
        .replace(/\${nonce}/g, nonce)
        .replace(/\${cspSource}/g, webview.cspSource);
    } catch (err) {
      logger.error(
        CHANNEL,
        `Error generating HTML content: ${err instanceof Error ? err.message : String(err)}`,
      );
      return '<html><body>Error loading content</body></html>';
    }
  }
}
