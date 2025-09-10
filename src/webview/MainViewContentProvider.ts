// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - webview
import {
  BaseViewContentProvider,
  ModuleDescriptor,
} from '@common/webview/BaseViewContentProvider';
import { getConfig } from '@utils/config';
import { GlobalStorageFS, AbsoluteFS } from '@utils/files';

export class MainViewContentProvider extends BaseViewContentProvider {
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
  constructor(context: vscode.ExtensionContext) {
    super(context, 'MainView');
  }

  protected getViewPath(): string {
    return 'webview';
  }

  protected getModuleUris(webview: vscode.Webview): Record<string, vscode.Uri> {
    const modules = [
      ...this.sharedModuleDescriptors,
      ...this.moduleDescriptors,
    ];
    const uris: Record<string, vscode.Uri> = {};
    for (const { key, path } of modules) {
      uris[key] = this.getWebviewUri(webview, path);
    }
    return uris;
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
