// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { parseAgentConfig } from '@agent/core/AgentConfig';
import { AgentType } from '@agent/core/AgentDataclass';
import { BaseToolUseAgent } from '@agent/implementations/BaseToolUseAgent';
import {
  executeAgentWithLogging,
  prepareAgentInstance,
} from '@agent/runtime/executeAgent';
import {
  ToolUseSessionManager,
  type ToolUseSessionSnapshot,
} from '@agent/toolUse/ToolUseSessionManager';
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import { STATUS } from '@progressView/modules/constants.js';
import { isToolUseTaskState } from '@logger/TaskState';
import { logErrorMessage } from '@common/errors/errorHandlingUtils';

async function buildToolUseAgent(
  snapshot: ToolUseSessionSnapshot,
  _context: vscode.ExtensionContext,
): Promise<{ agent: BaseToolUseAgent; agentType: AgentType }> {
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

  const fullConfig = parseAgentConfig(taskState.agentConfig);
  const { agent, agentType } = await prepareAgentInstance<BaseToolUseAgent>({
    agentName: fullConfig.agent,
    configPayload: fullConfig,
    executionId: snapshot.executionId as ExecutionId,
  });

  if (!(agent instanceof BaseToolUseAgent) || agentType !== AgentType.ToolUse) {
    throw new Error('Attempted to resume a non tool-use agent.');
  }

  return { agent, agentType };
}
import {
  resumeFromSnapshot,
  type ResumeAgentResult,
} from '@agent/toolUse/ToolUseFollowUpCoordinator';
import type { ToolUseSessionSnapshot } from '@agent/toolUse/ToolUseSessionManager';

interface ResumeAgentCommandPayload {
  snapshot: ToolUseSessionSnapshot;
  followUp?: string;
}

export function registerResumeAgentCommand(
  context: vscode.ExtensionContext,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    'texra.resumeAgent',
    async (
      payload: ResumeAgentCommandPayload | undefined,
    ): Promise<ResumeAgentResult> => {
      const snapshot = payload?.snapshot;
      if (!snapshot) {
        return { success: false };
      }

      return resumeFromSnapshot(snapshot, payload?.followUp);
    },
  );
}
