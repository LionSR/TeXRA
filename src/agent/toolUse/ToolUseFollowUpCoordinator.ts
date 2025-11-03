// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent core
import { AgentConfigSchema } from '@agent/core/AgentConfig';
import { AgentType } from '@agent/core/AgentDataclass';
import { BaseToolUseAgent } from '@agent/implementations/BaseToolUseAgent';
import {
  executeAgentWithLogging,
  prepareAgentInstance,
} from '@agent/runtime/executeAgent';
import {
  AgentExecutionContext,
  type AgentExecutionContextInit,
} from '@agent/runtime/AgentExecutionContext';
import {
  ToolUseSessionManager,
  type ToolUseSessionSnapshot,
} from '@agent/toolUse/ToolUseSessionManager';
import { getToolUseAgent } from '@agent/toolUse/ToolUseAgentRegistry';
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';

// Local imports - progress view
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import { STATUS } from '@progressView/modules/constants.js';

// Local imports - utilities
import { isToolUseTaskState } from '@logger/TaskState';
import {
  logErrorMessage,
  showLoggedErrorMessage,
} from '@common/errors/errorHandlingUtils';

const CHANNEL = 'toolUseFollowUpCoordinator';

async function buildToolUseAgent(
  snapshot: ToolUseSessionSnapshot,
  contextFactory: (init: AgentExecutionContextInit) => AgentExecutionContext,
): Promise<{ agent: BaseToolUseAgent; agentType: AgentType; context: AgentExecutionContext }> {
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
  const { agent, agentType, context } = await prepareAgentInstance<BaseToolUseAgent>({
    agentName: fullConfig.agent,
    configPayload: fullConfig,
    executionId: snapshot.executionId as ExecutionId,
    contextFactory,
  });

  if (!(agent instanceof BaseToolUseAgent) || agentType !== AgentType.ToolUse) {
    throw new Error('Attempted to resume a non tool-use agent.');
  }

  return { agent, agentType, context };
}

export interface ResumeAgentResult {
  success: boolean;
  lostFollowUps?: number;
}

function formatLostFollowUpSuffix(count: number): string {
  if (count === 0) {
    return '';
  }

  const label = count === 1 ? 'follow-up was' : 'follow-ups were';
  return ` ${count} queued ${label} lost.`;
}

export async function sendFollowUp(
  streamId: StreamTabId,
  text: string,
): Promise<void> {
  const agent = getToolUseAgent(streamId);
  if (agent) {
    try {
      agent.appendFollowUp(text);
    } catch (err) {
      await showLoggedErrorMessage(CHANNEL, 'Failed to send follow-up', err);
    }
    return;
  }

  if (ToolUseSessionManager.isResumingSession(streamId)) {
    if (ToolUseSessionManager.enqueueFollowUpWhileResuming(streamId, text)) {
      console.log(
        `[${CHANNEL}] queued follow-up while stream ${streamId} is resuming`,
      );
      return;
    }
  }

  const pendingSnapshot = ToolUseSessionManager.getSnapshotForStream(streamId);
  if (pendingSnapshot) {
    console.log(`[${CHANNEL}] resuming agent lazily for stream ${streamId}`);
    await resumeFromSnapshot(pendingSnapshot, text);
    return;
  }

  console.log(`[${CHANNEL}] no active session found for stream ${streamId}`);
  void vscode.window.showWarningMessage(
    'No active tool-use session found for this follow-up.',
  );
}

export async function resumeFromSnapshot(
  snapshot: ToolUseSessionSnapshot,
  followUp?: string,
): Promise<ResumeAgentResult> {
  if (!snapshot || !ToolUseSessionManager.isPersistenceEnabled()) {
    return { success: false };
  }

  const provider = ProgressViewProvider.getInstance();
  if (!provider) {
    return { success: false };
  }

  const streamId = snapshot.streamId as StreamTabId;
  const existingStatus = provider.eventHandler.getStreamStatus(
    snapshot.streamId,
  );

  if (existingStatus === STATUS.RUNNING || existingStatus === STATUS.RESUMING) {
    return { success: false };
  }

  ToolUseSessionManager.setResumingSession(streamId);
  provider.eventHandler.setStreamStatus(snapshot.streamId, STATUS.RESUMING);

  let queuedFollowUps: string[] = [];
  try {
    await executeAgentWithLogging(
      snapshot.agentName,
      async (contextFactory) => {
        const { agent, agentType, context } = await buildToolUseAgent(
          snapshot,
          contextFactory,
        );

        agent.resumeFromSnapshot(snapshot);
        if (followUp !== undefined) {
          agent.appendFollowUp(followUp);
        }

        queuedFollowUps = ToolUseSessionManager.drainQueuedFollowUps(streamId);
        for (const queuedFollowUp of queuedFollowUps) {
          agent.appendFollowUp(queuedFollowUp);
        }

        return { agent, agentType, context };
      },
      snapshot.executionId as ExecutionId,
      { resume: true },
    );

    ToolUseSessionManager.consumeSnapshotForStream(streamId);

    return { success: true };
  } catch (error) {
    const lostFollowUps =
      queuedFollowUps.length > 0
        ? queuedFollowUps
        : ToolUseSessionManager.drainQueuedFollowUps(streamId);

    const baseMessage = logErrorMessage(
      CHANNEL,
      'Failed to resume tool-use session',
      error,
    );
    const lostCount = lostFollowUps.length;

    await vscode.window.showWarningMessage(
      `${baseMessage}${formatLostFollowUpSuffix(lostCount)}`,
    );

    return { success: false, lostFollowUps: lostCount };
  } finally {
    ToolUseSessionManager.clearResumingSession(streamId);
    provider.eventHandler.setStreamStatus(snapshot.streamId, STATUS.WAITING);
  }
}
