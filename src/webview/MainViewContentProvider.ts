// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent utilities
import { buildGroupedAgentOptions } from '@agent/utils/agentOptionMetadata';
import { loadAgentOptionInputsSync } from '@agent/utils/agentOptionSources';

// Local imports - webview
import {
  BaseViewContentProvider,
  ModuleDescriptor,
} from '@common/webview/BaseViewContentProvider';
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
    { key: 'toggleManagerUri', path: 'modules/uiManagers/ToggleManager.js' },
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
    const { agentNames, directories } = loadAgentOptionInputsSync(this.context);
    const agentOptions = buildGroupedAgentOptions(agentNames, directories);

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
