// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent utilities
import {
  buildAgentOptionsPayload,
  type AgentDirectoryMap,
} from '@agent/utils/agentOptionMetadata';
import type { AgentOptionsPayload } from '@agent/computeAgentOptions';

// Local imports - webview
import {
  BaseViewContentProvider,
  ModuleDescriptor,
} from '@common/webview/BaseViewContentProvider';
import { getConfig } from '@utils/config';
import { GlobalStorageFS, AbsoluteFS } from '@utils/files';

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
    // Note: This uses synchronous approach for template generation
    // Agent options with metadata are computed asynchronously via computeAgentOptions
    const agents = getConfig<string[]>('agents', []);
    const configuredToolUseAgents = getConfig<string[]>('toolUseAgents', []);
    const toolUseDir = GlobalStorageFS.fullPath('tool_use_agents');
    const builtInDir = GlobalStorageFS.fullPath('agents');
    const configuredCustomDir = getConfig<string>(
      'explorer.agentsDirectory',
      '',
    ).trim();
    const customDir = path.isAbsolute(configuredCustomDir)
      ? configuredCustomDir
      : '';

    const agentDirectories: AgentDirectoryMap = {
      custom: customDir,
      builtIn: builtInDir,
      builtInToolUse: toolUseDir,
    };
    let discoveredToolUseAgents: string[] = [];
    try {
      const files = AbsoluteFS.readDirSync(toolUseDir);
      discoveredToolUseAgents = files
        .filter((f) => f.endsWith('.yaml'))
        .map((f) => path.basename(f, '.yaml'));
    } catch {
      discoveredToolUseAgents = [];
    }
    const toolUseAgents = Array.from(
      new Set([...configuredToolUseAgents, ...discoveredToolUseAgents]),
    );
    const allAgents = Array.from(new Set([...agents, ...toolUseAgents]));
    const optionBuckets: AgentOptionsPayload = buildAgentOptionsPayload(
      allAgents,
      agentDirectories,
      toolUseAgents,
    );

    const models = getConfig<string[]>('models', []);
    const modelOptions = models
      .map((model) => `<option value="${model}">${model}</option>`)
      .join('\n');

    return {
      workflowAgentOptions: optionBuckets.workflow,
      toolUseAgentOptions: optionBuckets.toolUse,
      modelOptions,
    };
  }
}
