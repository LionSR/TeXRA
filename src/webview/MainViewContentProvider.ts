// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent utilities
import {
  buildAgentOptionsPayload,
  DEFAULT_TOOL_USE_AGENT,
  DEFAULT_WORKFLOW_AGENT,
  type AgentDirectoryMap,
} from '@agent/utils/agentOptionMetadata';
import type { AgentOptionsPayload } from '@agent/computeAgentOptions';

// Local imports - webview
import {
  BaseViewContentProvider,
  ModuleDescriptor,
} from '@common/webview/BaseViewContentProvider';
import { getConfig } from '@utils/config';
import { GlobalStorageFS } from '@utils/files';

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
    const configuredWorkflowAgents = getConfig<string[]>('agents', []);
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
    const hasConfiguredWorkflowAgents = configuredWorkflowAgents.length > 0;
    const workflowAgents = hasConfiguredWorkflowAgents
      ? Array.from(new Set(configuredWorkflowAgents))
      : [DEFAULT_WORKFLOW_AGENT];
    const toolUseAgents = Array.from(
      new Set([DEFAULT_TOOL_USE_AGENT, ...configuredToolUseAgents]),
    );
    const allAgents = Array.from(
      new Set([...workflowAgents, ...toolUseAgents]),
    );
    const defaultWorkflowAgent = configuredWorkflowAgents.includes(
      DEFAULT_WORKFLOW_AGENT,
    )
      ? DEFAULT_WORKFLOW_AGENT
      : (workflowAgents[0] ?? DEFAULT_WORKFLOW_AGENT);
    const optionBuckets: AgentOptionsPayload = buildAgentOptionsPayload(
      allAgents,
      agentDirectories,
      toolUseAgents,
      {
        workflowAgent: defaultWorkflowAgent,
        toolUseAgent: DEFAULT_TOOL_USE_AGENT,
      },
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
