// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent runtime
import { ActiveAgentManager, executeAgentWithLogging } from '@agent/runtime';
import { ModelFactory } from '@agent/runtime/ModelFactory';
import { loadAgentSettingAndPrompts } from '@agent/runtime/agentLoad';
import { BaseToolUseAgent } from '@agent/implementations';
import { MODEL_CONFIGS } from '@model/ModelRegistry';
import { AgentConfigSchema } from '@agent/core/AgentConfig';
import { agentConfigToTaskState } from '@utils/config';
import { bus } from '@eventBus/ProgressEventBus';
import { getStreamTabId } from '@/logger/streamUtils';

const CHANNEL = 'resumeCommand';
console.log(`[${CHANNEL}] command registered`);

export function registerResumeCommand(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.resumeAgent', async () => {
      const state = await ActiveAgentManager.getState();
      if (!state) {
        vscode.window.showInformationMessage('No agent state to resume');
        return;
      }
      const agentConfig = AgentConfigSchema.parse(state.agentConfig);
      const modelName = agentConfig.model;
      const modelConfig = MODEL_CONFIGS[modelName];
      if (!modelConfig) {
        vscode.window.showErrorMessage(
          `Model configuration for ${modelName} not found`,
        );
        await ActiveAgentManager.clear();
        return;
      }
      modelConfig.toolConfig = agentConfig.toolConfig;
      const modelHandler = ModelFactory.createHandler(modelConfig);
      const agentPath = state.agentPath;
      const [agentSetting, agentPrompt] = await loadAgentSettingAndPrompts(
        agentPath,
        agentConfig.agent,
      );
      const agent = new BaseToolUseAgent(
        modelHandler,
        agentConfig,
        agentSetting,
        agentPrompt,
        agentPath,
      );
      try {
        agent.restoreState(state);
      } catch (error: any) {
        vscode.window.showErrorMessage(
          `Failed to restore agent state: ${error.message}`,
        );
        await ActiveAgentManager.clear();
        return;
      }
      const streamTabId = getStreamTabId(
        agentConfig.agent,
        agentConfig.model,
        agentConfig.inputFile,
      );
      bus.emit('updateStreamStatus', {
        stream: streamTabId,
        status: 'running',
      });
      bus.emit('setTaskState', {
        streamTabId,
        executionId: state.executionId,
        taskState: agentConfigToTaskState(agentConfig, agentSetting.agentType),
      });
      await executeAgentWithLogging(
        agentConfig.agent,
        async () => ({ agent, agentType: agentSetting.agentType }),
        context,
        state.executionId,
      );
    }),
  );
}
