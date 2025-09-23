// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { AgentConfigSchema } from '@agent/core/AgentConfig';
import {
  AgentSetting,
  AgentPrompt,
  AgentType,
} from '@agent/core/AgentDataclass';
import { BaseToolUseAgent } from '@agent/implementations/BaseToolUseAgent';
import { loadAgentSettingAndPrompts } from '@agent/runtime/agentLoad';
import { ModelFactory } from '@agent/runtime/ModelFactory';
import {
  executeAgentWithLogging,
  getAgentPath,
} from '@agent/runtime/executeAgent';
import {
  ToolUseSessionManager,
  type ToolUseSessionSnapshot,
} from '@agent/toolUse/ToolUseSessionManager';
import type { ExecutionId } from '@agent/types/IdentifierTypes';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import { isToolUseTaskState } from '@logger/TaskState';
import { MODEL_CONFIGS } from '@model/ModelRegistry';

function isToolUseAgent(setting: AgentSetting): boolean {
  return setting.agentType === AgentType.ToolUse;
}

async function buildToolUseAgent(
  snapshot: ToolUseSessionSnapshot,
  context: vscode.ExtensionContext,
): Promise<{ agent: BaseToolUseAgent; agentSetting: AgentSetting }> {
  const provider = ProgressViewProvider.getInstance();
  if (!provider) {
    throw new Error('Progress view provider is not initialized.');
  }

  const taskState = provider.state.getTaskState(snapshot.streamId);
  if (!taskState) {
    throw new Error('No saved task state found for stream.');
  }

  if (!isToolUseTaskState(taskState)) {
    throw new Error('Saved task state is not a tool-use session.');
  }

  const fullConfig = AgentConfigSchema.parse(taskState.agentConfig);
  const modelName = fullConfig.model;
  if (!(modelName in MODEL_CONFIGS)) {
    throw new Error(`Model ${modelName} not found in MODEL_CONFIGS`);
  }

  const modelHandler = ModelFactory.createHandler(MODEL_CONFIGS[modelName]);
  const agentPath = await getAgentPath(fullConfig.agent, context);
  const [agentSetting, agentPrompt] = await loadAgentSettingAndPrompts(
    agentPath,
    fullConfig.agent,
    { preferMultiple: fullConfig.useMultipleOutputs },
  );

  if (!isToolUseAgent(agentSetting)) {
    throw new Error('Attempted to resume a non tool-use agent.');
  }

  const agent = new BaseToolUseAgent(
    modelHandler,
    fullConfig,
    agentSetting,
    agentPrompt as AgentPrompt,
    agentPath.directory,
    snapshot.executionId as ExecutionId,
  );

  agent.resumeFromSnapshot(snapshot);
  return { agent, agentSetting };
}

export function registerResumeAgentCommand(
  context: vscode.ExtensionContext,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    'texra.resumeAgent',
    async (snapshot: ToolUseSessionSnapshot | undefined) => {
      if (!snapshot || !ToolUseSessionManager.isPersistenceEnabled()) {
        return;
      }

      try {
        const provider = ProgressViewProvider.getInstance();
        if (!provider) {
          return;
        }

        const executionId = snapshot.executionId as ExecutionId;
        const existingStatus = provider.eventHandler.getStreamStatus(
          snapshot.streamId,
        );
        if (existingStatus === 'running') {
          return;
        }

        const { agent, agentSetting } = await buildToolUseAgent(
          snapshot,
          context,
        );

        await executeAgentWithLogging(
          snapshot.agentName,
          async () => ({
            agent,
            agentType: agentSetting.agentType,
          }),
          context,
          executionId,
          { resume: true },
        );
      } catch (error) {
        await ToolUseSessionManager.deleteSnapshot(snapshot.executionId);
        const message =
          error instanceof Error ? error.message : String(error ?? 'unknown');
        vscode.window.showWarningMessage(
          `Failed to resume tool-use session: ${message}`,
        );
      }
    },
  );
}
