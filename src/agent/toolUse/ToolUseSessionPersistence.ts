// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent core
import { AgentConfigSchema } from '@agent/core/AgentConfig';
import { AgentType } from '@agent/core/AgentDataclass';
import type { AgentSessionDescriptor } from '@agent/core/AgentDataclass';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { BaseToolUseAgent } from '@agent/implementations/BaseToolUseAgent';
import {
  executeAgentWithLogging,
  prepareAgentInstance,
} from '@agent/runtime/executeAgent';
import {
  AgentExecutionContext,
  type AgentExecutionContextInit,
} from '@agent/runtime/AgentExecutionContext';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';

// Local imports - logging
import { AgentLogger } from '@logger/AgentLogger';

// Local imports - persistence helpers
import { getToolUsePersistenceEnabled } from '@utils/config';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import { STATUS } from '@progressView/modules/constants.js';
import { isToolUseTaskState } from '@logger/TaskState';
import { logErrorMessage } from '@common/errors/errorHandlingUtils';
import {
  ToolUseResumeQueue,
  type ToolUseSessionSnapshot,
} from './ToolUseResumeQueue';
import { ToolUseSnapshotStore } from './ToolUseSnapshotStore';
import { type SaveToolUseSnapshotPayload } from './ToolUseSnapshotTypes';

const CHANNEL = 'ToolUseSessionPersistence';
const logger = new AgentLogger(CHANNEL);

interface PersistSnapshotArgs {
  executionId: ExecutionId | undefined;
  streamId: StreamTabId;
  agentName: string;
  model: string;
  session: AgentSessionDescriptor;
  messages: ProviderMessage[];
  toolState: AgentWorkspaceState | null;
  hasQueuedFollowUps: () => boolean;
}

const persistedExecutions = new Map<ExecutionId, ToolUseSessionSnapshot>();

function rememberSnapshot(snapshot: ToolUseSessionSnapshot): void {
  persistedExecutions.set(snapshot.executionId as ExecutionId, snapshot);
  ToolUseResumeQueue.cacheSnapshot(snapshot);
}

function rememberSnapshots(snapshots: ToolUseSessionSnapshot[]): void {
  for (const snapshot of snapshots) {
    persistedExecutions.set(snapshot.executionId as ExecutionId, snapshot);
  }

  ToolUseResumeQueue.registerPendingSnapshots(snapshots);
}

function forgetSnapshot(
  executionId: ExecutionId,
): ToolUseSessionSnapshot | undefined {
  const snapshot = persistedExecutions.get(executionId);
  if (snapshot) {
    persistedExecutions.delete(executionId);
    ToolUseResumeQueue.clearPendingSnapshot(snapshot.streamId as StreamTabId);
  }

  return snapshot;
}

function forgetSnapshotForStream(streamId: StreamTabId): void {
  const snapshot = ToolUseResumeQueue.consumeSnapshotForStream(streamId);
  if (snapshot) {
    persistedExecutions.delete(snapshot.executionId as ExecutionId);
  }
}

async function buildToolUseAgent(
  snapshot: ToolUseSessionSnapshot,
  contextFactory: (init: AgentExecutionContextInit) => AgentExecutionContext,
): Promise<{
  agent: BaseToolUseAgent;
  agentType: AgentType;
  context: AgentExecutionContext;
}> {
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
  const { agent, agentType, context } =
    await prepareAgentInstance<BaseToolUseAgent>({
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

async function persistSnapshot(
  payload: SaveToolUseSnapshotPayload,
  hasQueuedFollowUps: () => boolean,
): Promise<ToolUseSessionSnapshot | null> {
  await ToolUseSnapshotStore.save(payload);

  if (hasQueuedFollowUps()) {
    await ToolUseSnapshotStore.delete(payload.executionId);
    logger.debug(
      `Aborted persistence for execution ${payload.executionId} because a follow-up arrived.`,
    );
    return null;
  }

  const stored = await ToolUseSnapshotStore.load(payload.executionId);
  if (!stored) {
    logger.debug(
      `Snapshot for execution ${payload.executionId} was not readable after save.`,
    );
    return null;
  }

  if (hasQueuedFollowUps()) {
    await ToolUseSnapshotStore.delete(payload.executionId);
    logger.debug(
      `Aborted caching for execution ${payload.executionId} because a follow-up arrived post-persistence.`,
    );
    return null;
  }

  return stored;
}

export const ToolUseSessionPersistence = {
  isEnabled(): boolean {
    return getToolUsePersistenceEnabled();
  },

  registerPersistedSnapshots(snapshots: ToolUseSessionSnapshot[]): void {
    if (!this.isEnabled() || snapshots.length === 0) {
      return;
    }

    rememberSnapshots(snapshots);
  },

  clearAllPersistedSnapshots(): void {
    persistedExecutions.clear();
    ToolUseResumeQueue.clearAllPendingSnapshots();
  },

  async maybePersistIdleSnapshot({
    executionId,
    streamId,
    agentName,
    model,
    session,
    messages,
    toolState,
    hasQueuedFollowUps,
  }: PersistSnapshotArgs): Promise<boolean> {
    if (!this.isEnabled() || !executionId || !toolState) {
      return false;
    }

    if (hasQueuedFollowUps()) {
      return false;
    }

    const payload: SaveToolUseSnapshotPayload = {
      executionId,
      streamId,
      agentName,
      model,
      session: {
        agentType: session.agentType ?? AgentType.ToolUse,
        agentCategory: session.agentCategory,
      },
      messages,
      toolState,
    };

    const stored = await persistSnapshot(payload, hasQueuedFollowUps);
    if (!stored) {
      return false;
    }

    if (hasQueuedFollowUps()) {
      await ToolUseSnapshotStore.delete(executionId);
      logger.debug(
        `Skipped caching snapshot for execution ${executionId} because a follow-up arrived post-persistence.`,
      );
      return false;
    }

    rememberSnapshot(stored);
    return true;
  },

  async clearPersistedSnapshot(
    executionId: ExecutionId | undefined,
  ): Promise<void> {
    if (!executionId || !this.isEnabled()) {
      return;
    }

    const cachedSnapshot = forgetSnapshot(executionId);
    if (!cachedSnapshot) {
      const storedSnapshot = await ToolUseSnapshotStore.load(executionId);
      if (storedSnapshot) {
        ToolUseResumeQueue.clearPendingSnapshot(
          storedSnapshot.streamId as StreamTabId,
        );
      }
    }

    await ToolUseSnapshotStore.delete(executionId);
  },

  async resumeFromSnapshot(
    snapshot: ToolUseSessionSnapshot,
    followUp?: string,
  ): Promise<ResumeAgentResult> {
    if (!this.isEnabled()) {
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

    if (
      existingStatus === STATUS.RUNNING ||
      existingStatus === STATUS.RESUMING
    ) {
      return { success: false };
    }

    ToolUseResumeQueue.setResumingSession(streamId);
    provider.eventHandler.setStreamStatus(snapshot.streamId, STATUS.RESUMING);

    let queuedFollowUps: string[] = [];
    let resumeFailed = false;
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

          queuedFollowUps = ToolUseResumeQueue.drainQueuedFollowUps(streamId);
          for (const queuedFollowUp of queuedFollowUps) {
            agent.appendFollowUp(queuedFollowUp);
          }

          return { agent, agentType, context };
        },
        snapshot.executionId as ExecutionId,
        { resume: true },
      );

      forgetSnapshotForStream(streamId);

      return { success: true };
    } catch (error) {
      resumeFailed = true;
      const lostFollowUps =
        queuedFollowUps.length > 0
          ? queuedFollowUps
          : ToolUseResumeQueue.drainQueuedFollowUps(streamId);

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
      ToolUseResumeQueue.clearResumingSession(streamId);
      const status = provider.eventHandler.getStreamStatus(snapshot.streamId);
      if (status === STATUS.RESUMING) {
        provider.eventHandler.setStreamStatus(
          snapshot.streamId,
          STATUS.WAITING,
        );
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

export type { ToolUseSessionSnapshot } from './ToolUseResumeQueue';
