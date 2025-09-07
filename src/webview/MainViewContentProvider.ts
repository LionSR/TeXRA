// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - webview
import { BaseViewContentProvider } from '@common/webview/BaseViewContentProvider';
import { getConfig } from '@utils/config';
import { GlobalStorageFS, AbsoluteFS } from '@utils/files';

export class MainViewContentProvider extends BaseViewContentProvider {
  constructor(context: vscode.ExtensionContext) {
    super(context, 'MainView');
  }

  protected getViewPath(): string {
    return 'webview';
  }

  protected getModuleUris(webview: vscode.Webview): Record<string, vscode.Uri> {
    return {
      styleUri: this.getWebviewUri(webview, 'styles/index.css'),
      scriptUri: this.getWebviewUri(webview, 'script.js'),

      // Main view specific modules
      webviewStateModuleUri: this.getWebviewUri(
        webview,
        'modules/mainViewState.js',
      ),
      messageHandlersUri: this.getWebviewUri(
        webview,
        'modules/messageHandlers.js',
      ),
      themeHandlersUri: this.getWebviewUri(
        webview,
        'modules/handlers/themeHandlers.js',
      ),
      fileMessageHandlersUri: this.getWebviewUri(
        webview,
        'modules/handlers/fileHandlers.js',
      ),
      recordingHandlersUri: this.getWebviewUri(
        webview,
        'modules/handlers/recordingHandlers.js',
      ),
      domHandlersUri: this.getWebviewUri(webview, 'modules/domHandlers.js'),
      constantsUri: this.getWebviewUri(webview, 'modules/constants.js'),
      eventBusUri: this.getWebviewUri(webview, 'modules/eventBus.js'),

      // UI managers
      fileListUri: this.getWebviewUri(
        webview,
        'modules/uiManagers/FileList.js',
      ),
      fileSelectUri: this.getWebviewUri(
        webview,
        'modules/uiManagers/FileSelect.js',
      ),
      toggleManagerUri: this.getWebviewUri(
        webview,
        'modules/uiManagers/ToggleManager.js',
      ),
      baseUIManagerUri: this.getWebviewUri(
        webview,
        'modules/uiManagers/BaseUIManager.js',
      ),
      fileInputManagerUri: this.getWebviewUri(
        webview,
        'modules/uiManagers/FileInputManager.js',
      ),
      actionButtonManagerUri: this.getWebviewUri(
        webview,
        'modules/uiManagers/ActionButtonManager.js',
      ),
      settingsButtonManagerUri: this.getWebviewUri(
        webview,
        'modules/uiManagers/SettingsButtonManager.js',
      ),
      recordingManagerUri: this.getWebviewUri(
        webview,
        'modules/uiManagers/RecordingManager.js',
      ),
      instructionManagerUri: this.getWebviewUri(
        webview,
        'modules/uiManagers/InstructionManager.js',
      ),
      outputFilesManagerUri: this.getWebviewUri(
        webview,
        'modules/uiManagers/OutputFilesManager.js',
      ),
      latexdiffManagerUri: this.getWebviewUri(
        webview,
        'modules/uiManagers/LatexdiffManager.js',
      ),
    };
  }

  protected getTemplateVariables(): Record<string, any> {
    // Note: This uses synchronous approach for template generation
    // Agent options with metadata are computed asynchronously via computeAgentOptions
    const agents = getConfig<string[]>('agents', []);
    const includeToolUse = getConfig<boolean>('includeToolUseAgents', false);
    const toolUseDir = GlobalStorageFS.fullPath('tool_use_agents');
    let extraAgents: string[] = [];
    if (includeToolUse) {
      try {
        const files = AbsoluteFS.readDirSync(toolUseDir);
        extraAgents = files
          .filter((f) => f.endsWith('.yaml'))
          .map((f) => path.basename(f, '.yaml'));
      } catch {
        extraAgents = [];
      }
    }
    const allAgents = Array.from(new Set([...agents, ...extraAgents]));
    const agentOptions = allAgents
      .map((agent) => `<option value="${agent}">${agent}</option>`)
      .join('\n');

    const models = getConfig<string[]>('models', []);
    const modelOptions = models
      .map((model) => `<option value="${model}">${model}</option>`)
      .join('\n');

    return {
      agentOptions,
      modelOptions,
    };
  }
}
