// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent utilities
import { computeAgentOptionsSync } from '@agent/index';

// Internal imports
import { BaseViewContentProvider } from '@common/webview';
import { getConfig } from '@utils/config';

/** View-specific module descriptors for MainView */
const MAIN_VIEW_MODULES = [
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
  { key: 'bannerManagerUri', path: 'modules/uiManagers/BannerManager.js' },
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
] as const;

export class MainViewContentProvider extends BaseViewContentProvider {
  constructor(context: vscode.ExtensionContext) {
    super(context, 'MainView', [...MAIN_VIEW_MODULES]);
  }

  protected getViewPath(): string {
    return 'webview';
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
