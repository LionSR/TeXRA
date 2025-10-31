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
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';

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

  protected override async getTemplateVariables(): Promise<
    Record<string, any>
  > {
    const configuredWorkflowAgents = getConfig<string[]>('agents', []);
    const configuredToolUseAgents = getConfig<string[]>('toolUseAgents', []);

    agentDirectories.initialize(this.context);

    let directories: AgentDirectoryMap | undefined;
    let shouldShowAgentBanner = false;
    let bannerText = 'Agent configuration is missing.';

    try {
      directories = await agentDirectories.getDirectoryMap();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        this.channel,
        `Failed to resolve agent directories: ${message}`,
      );
      shouldShowAgentBanner = true;
      bannerText = 'Agent directories could not be loaded.';
    }

    const resolvedDirectories: AgentDirectoryMap = directories ?? {};
    const customDirSet = Boolean(resolvedDirectories.custom);

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
      resolvedDirectories,
      toolUseAgents,
      {
        workflowAgent: defaultWorkflowAgent,
        toolUseAgent: DEFAULT_TOOL_USE_AGENT,
      },
    );

    const models = getConfig<string[]>('models', []);
    const modelOptions = models
      .map(
        (model) => `<vscode-option value="${model}">${model}</vscode-option>`,
      )
      .join('\n');

    const agentConfigBannerStyle = shouldShowAgentBanner
      ? 'display: flex'
      : 'display: none';
    const agentConfigCustomDirSet = customDirSet ? 'true' : 'false';

    return {
      workflowAgentOptions: optionBuckets.workflow,
      toolUseAgentOptions: optionBuckets.toolUse,
      modelOptions,
      agentConfigBannerStyle,
      agentConfigBannerText: bannerText,
      agentConfigCustomDirSet,
    };
  }
}
