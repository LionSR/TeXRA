// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent utilities
import { computeAgentOptionsSync } from '@agent/computeAgentOptions';

// Internal imports
import { BaseViewContentProvider, ModuleDescriptor } from '@common/webview';
import { getConfig } from '@utils/config';

export class MainViewContentProvider extends BaseViewContentProvider {
  constructor(context: vscode.ExtensionContext) {
    super(context, 'MainView');
  }

  protected getViewPath(): string {
    return 'webview';
  }

  private readonly moduleDescriptors: ModuleDescriptor[] = [
    { key: 'webviewStateModuleUri', path: 'modules/mainViewState.js' },
    { key: 'themeHandlersUri', path: 'modules/handlers/themeHandlers.js' },
    { key: 'fileMessageHandlersUri', path: 'modules/handlers/fileHandlers.js' },
    {
      key: 'recordingHandlersUri',
      path: 'modules/handlers/recordingHandlers.js',
    },
    { key: 'eventBusUri', path: 'modules/eventBus.js' },
    { key: 'fileListUri', path: 'modules/uiManagers/FileList.js' },
    { key: 'fileSelectUri', path: 'modules/uiManagers/FileSelect.js' },
    { key: 'baseUIManagerUri', path: 'modules/uiManagers/BaseUIManager.js' },
    {
      key: 'fileInputManagerUri',
      path: 'modules/uiManagers/FileInputManager.js',
    },
    {
      key: 'actionButtonManagerUri',
      path: 'modules/uiManagers/ActionButtonManager.js',
    },
    {
      key: 'settingsButtonManagerUri',
      path: 'modules/uiManagers/SettingsButtonManager.js',
    },
    {
      key: 'bannerManagerUri',
      path: 'modules/uiManagers/BannerManager.js',
    },
    {
      key: 'recordingManagerUri',
      path: 'modules/uiManagers/RecordingManager.js',
    },
    {
      key: 'instructionManagerUri',
      path: 'modules/uiManagers/InstructionManager.js',
    },
    {
      key: 'outputFilesManagerUri',
      path: 'modules/uiManagers/OutputFilesManager.js',
    },
    {
      key: 'latexdiffManagerUri',
      path: 'modules/uiManagers/LatexdiffManager.js',
    },
  ];

  protected getModuleUris(webview: vscode.Webview): Record<string, vscode.Uri> {
    return this.buildUriRecord(webview, this.moduleDescriptors);
  }

  protected getTemplateVariables(): Record<string, any> {
    // Use the cached agent index for fast, synchronous template generation.
    // If the index isn't initialized yet, this returns placeholder options
    // that will be replaced by the async computeAgentOptions call in handleWebviewReady.
    const agentOptions = computeAgentOptionsSync();

    const models = getConfig<string[]>('texra.models', []);
    const modelOptions = models
      .map(
        (model) => `<vscode-option value="${model}">${model}</vscode-option>`,
      )
      .join('\n');

    return {
      workflowAgentOptions: agentOptions.workflow,
      toolUseAgentOptions: agentOptions.toolUse,
      modelOptions,
    };
  }
}
