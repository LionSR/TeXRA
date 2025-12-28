// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports - agent core
import { AgentType } from '@agent/core/AgentDataclass';
// Type imports
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { AgentSharedStore } from '@agent/core/AgentSharedStore';
// Internal imports
import { BaseToolUseAgent } from '@agent/implementations/BaseToolUseAgent';
import {
  prepareAgentInstance,
  runPreparedAgent,
} from '@agent/runtime/executeAgent';
import { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';
// Type imports
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';

// Local imports - logging
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { STREAM_STATUS } from '@common/constants/streamStatus';
import { logErrorMessage } from '@common/errors/errorHandlingUtils';
import { AgentLogger } from '@logger/AgentLogger';
import { getToolUsePersistenceEnabled } from '@utils/config';

// Local imports - persistence helpers

// Local file imports
import { ToolUseFollowUpQueue, type FollowUpQueue } from './ToolUseFollowUp';
import {
  ToolUseSessionManager,
  type SaveToolUseSnapshotPayload,
  type ToolUseSessionSnapshot,
} from './ToolUseSessionManager';
import { ToolUseSnapshotStore } from './ToolUseSnapshotStore';

const CHANNEL = 'ToolUseSessionPersistence';
const logger = new AgentLogger(CHANNEL);

interface PersistSnapshotArgs {
  executionId: ExecutionId | undefined;
  streamId: StreamTabId;
  agentConfig: AgentConfig;
  messages: ProviderMessage[];
  store: AgentSharedStore | null;
  queue: FollowUpQueue;
}

async function persistSnapshot({
  executionId,
  streamId,
  agentConfig,
  messages,
  store,
  queue,
}: PersistSnapshotArgs): Promise<boolean> {
  if (!ToolUseSessionPersistence.isEnabled() || !executionId || !store) {
    return false;
  }

  const payload: SaveToolUseSnapshotPayload = {
    executionId,
    streamId,
    agentConfig,
    messages,
    store,
  };

  const outcome = await queue.runIfIdle(() =>
    ToolUseSnapshotStore.save(payload),
  );
  const stored = outcome.result;
  if (!stored) {
    return false;
  }

  if (outcome.aborted) {
    await ToolUseSnapshotStore.delete(payload.executionId);
    logger.debug(
      `Dropped snapshot for execution ${payload.executionId} because a follow-up arrived during persistence.`,
    );
    return false;
  }

  ToolUseSessionManager.cacheSnapshot(stored);
  return true;
}

async function buildToolUseAgent(snapshot: ToolUseSessionSnapshot): Promise<{
  agent: BaseToolUseAgent;
  context: AgentExecutionContext;
}> {
  const config: AgentConfig = snapshot.agentConfig;

  const { agent, agentType, context } =
    await prepareAgentInstance<BaseToolUseAgent>({
      agentName: config.agent,
      configPayload: config,
      executionId: snapshot.executionId as ExecutionId,
    });

  if (!(agent instanceof BaseToolUseAgent) || agentType !== AgentType.ToolUse) {
    throw new Error('Attempted to resume a non tool-use agent.');
  }

  return { agent, context };
}

/** Schema for agent resume operation result. */
export const ResumeAgentResultSchema = z.object({
  success: z.boolean(),
  lostFollowUps: z.number().nonnegative().optional(),
});

/** Result of resuming a tool-use agent from a snapshot. */
export type ResumeAgentResult = z.infer<typeof ResumeAgentResultSchema>;

export const ToolUseSessionPersistence = {
  isEnabled(): boolean {
    return getToolUsePersistenceEnabled();
  },

  registerPersistedSnapshots(snapshots: ToolUseSessionSnapshot[]): void {
    if (!this.isEnabled() || snapshots.length === 0) {
      return;
    }

    ToolUseSessionManager.registerSnapshots(snapshots);
  },

  clearAllPersistedSnapshots(): void {
    ToolUseSessionManager.clearAll();
  },

  async maybePersistIdleSnapshot({
    executionId,
    streamId,
    agentConfig,
    messages,
    store,
    queue,
  }: PersistSnapshotArgs): Promise<boolean> {
    if (!this.isEnabled() || !queue.isEmpty()) {
      return false;
    }

    return persistSnapshot({
      executionId,
      streamId,
      agentConfig,
      messages,
      store,
      queue,
    });
  },

  async persistCheckpointSnapshot(args: PersistSnapshotArgs): Promise<boolean> {
    if (!this.isEnabled() || !args.executionId || !args.store) {
      return false;
    }

    const payload: SaveToolUseSnapshotPayload = {
      executionId: args.executionId,
      streamId: args.streamId,
      agentConfig: args.agentConfig,
      messages: args.messages,
      store: args.store,
    };

    const stored = await ToolUseSnapshotStore.save(payload);
    if (!stored) {
      return false;
    }

    ToolUseSessionManager.cacheSnapshot(stored);
    return true;
  },

  async clearPersistedSnapshot(
    executionId: ExecutionId | undefined,
  ): Promise<void> {
    if (!executionId || !this.isEnabled()) {
      return;
    }

    ToolUseSessionManager.clearByExecution(executionId);

    await ToolUseSnapshotStore.delete(executionId);
  },

  async resumeFromSnapshot(
    snapshot: ToolUseSessionSnapshot,
    followUp?: string,
  ): Promise<ResumeAgentResult> {
    if (!this.isEnabled()) {
      return { success: false };
    }

    const streamId = snapshot.streamId as StreamTabId;
    const existingStatus = StreamStatusService.get(streamId);

    if (
      existingStatus === STREAM_STATUS.RUNNING ||
      existingStatus === STREAM_STATUS.RESUMING
    ) {
      return { success: false };
    }

    ToolUseFollowUpQueue.markResuming(streamId);
    StreamStatusService.set(streamId, STREAM_STATUS.RESUMING);

    let queuedFollowUps: string[] = [];
    try {
      // Build and configure the agent
      const { agent, context } = await buildToolUseAgent(snapshot);

      // Restore agent state from snapshot
      agent.setResumeSnapshot(snapshot);

      // Append any follow-up messages
      if (followUp !== undefined) {
        agent.session.appendFollowUp(followUp);
      }

      // Drain and append any queued follow-ups
      queuedFollowUps = ToolUseFollowUpQueue.drain(streamId);
      for (const queuedFollowUp of queuedFollowUps) {
        agent.session.appendFollowUp(queuedFollowUp);
      }

      // Run the prepared agent
      await runPreparedAgent(agent, context, {
        isResume: true,
        executionId: snapshot.executionId as ExecutionId,
      });

      ToolUseSessionManager.clearByStream(streamId);

      return { success: true };
    } catch (error) {
      const lostFollowUps =
        queuedFollowUps.length > 0
          ? queuedFollowUps
          : ToolUseFollowUpQueue.drain(streamId);

      const baseMessage = logErrorMessage(
        CHANNEL,
        'Failed to resume tool-use session',
        error,
      );
      const lostCount = lostFollowUps.length;

      await vscode.window.showWarningMessage(
        `${baseMessage}${lostCount === 0 ? '' : formatLostFollowUpSuffix(lostCount)}`,
      );

      return { success: false, lostFollowUps: lostCount };
    } finally {
      ToolUseFollowUpQueue.clearResuming(streamId);
      const status = StreamStatusService.get(streamId);
      if (status === STREAM_STATUS.RESUMING) {
        StreamStatusService.set(streamId, STREAM_STATUS.WAITING);
      }
    }
  },
};

function formatLostFollowUpSuffix(count: number): string {
  if (count === 0) {
    return '';
  }

  const label = count === 1 ? 'follow-up was' : 'follow-ups were';
  return ` ${count} queued ${label} lost.`;
}
