// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { AgentConfigSchema } from '@agent/core/AgentConfig';
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

  const fullConfig = AgentConfigSchema.parse(taskState.agentConfig);
  const { agent, agentType } = await prepareAgentInstance<BaseToolUseAgent>({
    agentName: fullConfig.agent,
    configPayload: fullConfig,
  });

  if (!(agent instanceof BaseToolUseAgent) || agentType !== AgentType.ToolUse) {
    throw new Error('Attempted to resume a non tool-use agent.');
  }

  return { agent, agentType };
}

interface ResumeAgentCommandPayload {
  snapshot: ToolUseSessionSnapshot;
  followUp?: string;
}

const CHANNEL = 'resumeAgentCommand';

export interface ResumeAgentResult {
  success: boolean;
  lostFollowUps?: number;
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
      const followUp = payload?.followUp;
      if (!snapshot || !ToolUseSessionManager.isPersistenceEnabled()) {
        return { success: false };
      }

      const provider = ProgressViewProvider.getInstance();
      if (!provider) {
        return { success: false };
      }

      const streamId = snapshot.streamId as StreamTabId;
      let queuedFollowUps: string[] = [];

      try {
        const executionId = snapshot.executionId as ExecutionId;
        const existingStatus = provider.eventHandler.getStreamStatus(
          snapshot.streamId,
        );
        if (
          existingStatus === STATUS.RUNNING ||
          existingStatus === STATUS.RESUMING
        ) {
          return { success: false };
        }

        provider.eventHandler.setStreamStatus(
          snapshot.streamId,
          STATUS.RESUMING,
        );

        const { agent, agentType } = await buildToolUseAgent(snapshot, context);

        agent.resumeFromSnapshot(snapshot);
        if (followUp !== undefined) {
          agent.appendFollowUp(followUp);
        }

        queuedFollowUps = ToolUseSessionManager.drainQueuedFollowUps(streamId);
        for (const queuedFollowUp of queuedFollowUps) {
          agent.appendFollowUp(queuedFollowUp);
        }

        await executeAgentWithLogging(
          snapshot.agentName,
          async () => ({
            agent,
            agentType,
          }),
          executionId,
          { resume: true },
        );

        ToolUseSessionManager.clearResumingSession(streamId);
        provider.eventHandler.setStreamStatus(
          snapshot.streamId,
          STATUS.WAITING,
        );

        return { success: true };
      } catch (error) {
        const lostFollowUps =
          queuedFollowUps.length > 0
            ? queuedFollowUps
            : ToolUseSessionManager.drainQueuedFollowUps(streamId);

        ToolUseSessionManager.clearResumingSession(streamId);
        provider.eventHandler.setStreamStatus(
          snapshot.streamId,
          STATUS.WAITING,
        );

        const baseMessage = logErrorMessage(
          CHANNEL,
          'Failed to resume tool-use session',
          error,
        );
        const lostCount = lostFollowUps.length;
        const followUpSuffix =
          lostCount > 0
            ? ` ${lostCount} queued ${
                lostCount === 1 ? 'follow-up was' : 'follow-ups were'
              } lost.`
            : '';
        await vscode.window.showWarningMessage(
          `${baseMessage}${followUpSuffix}`,
        );

        return { success: false, lostFollowUps: lostCount };
      }
    },
  );
}
