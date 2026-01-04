/**
 * Tool-use session snapshot retrieval for auto-resume functionality.
 *
 * This module provides functions to construct ToolUseSessionSnapshot from
 * persisted state, enabling automatic resumption of WAITING tool-use sessions.
 */

import { getExecutionStore } from '@agent/storage';
import type { StreamTabId, ExecutionId } from '@agent/types/IdentifierTypes';
import type { FlowRecord } from '@agent/node/persisted-flow';
import {
  TOOL_USE_SNAPSHOT_VERSION,
  type ToolUseSessionSnapshot,
} from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import type { TaskState } from '@logger/TaskState';
import { isToolUseTaskState } from '@logger/TaskState';
import { AgentLogger } from '@logger/AgentLogger';

const logger = new AgentLogger('ToolUseSnapshotRetrieval');

/**
 * Retrieve a ToolUseSessionSnapshot for a WAITING tool-use session.
 *
 * Constructs the snapshot from:
 * - TaskState (agentConfig)
 * - ExecutionKVStore (flow record with messages and state slices)
 *
 * @param streamId - The stream tab ID
 * @param executionId - The execution ID for the stream
 * @param taskState - The persisted task state
 * @returns The snapshot, or null if retrieval fails
 */
export async function retrieveToolUseSnapshot(
  streamId: StreamTabId,
  executionId: ExecutionId,
  taskState: TaskState,
): Promise<ToolUseSessionSnapshot | null> {
  // Validate task state is for tool-use agent
  if (!isToolUseTaskState(taskState)) {
    logger.warn(
      `Cannot retrieve snapshot for non-tool-use stream: ${streamId}`,
    );
    return null;
  }

  try {
    // Get the flow record from execution storage
    const kv = getExecutionStore(executionId);
    const flowRecord = await kv.read<FlowRecord>(`flow:${executionId}`);

    if (!flowRecord?.shared) {
      logger.warn(`No flow record found for execution: ${executionId}`);
      return null;
    }

    // Runtime validation of shared structure (avoids unsafe type casting)
    const shared = flowRecord.shared as Record<string, unknown>;
    if (!shared.state || typeof shared.state !== 'object') {
      logger.warn(`Flow record has no state for execution: ${executionId}`);
      return null;
    }

    const state = shared.state as Record<string, unknown>;
    const conversation = state.conversation;
    const stateSlices = state.stateSlices as Record<string, unknown> | undefined;

    if (!Array.isArray(conversation)) {
      logger.warn(`Flow record has invalid conversation for execution: ${executionId}`);
      return null;
    }

    if (!stateSlices || typeof stateSlices !== 'object') {
      logger.warn(`Flow record has no state slices for execution: ${executionId}`);
      return null;
    }

    // Validate required state slice fields
    const { runStateSnapshot, workspaceSnapshot, userChannels } = stateSlices;
    if (!runStateSnapshot || !workspaceSnapshot || !userChannels) {
      logger.warn(`Flow record has incomplete state slices for execution: ${executionId}`);
      return null;
    }

    // Construct the snapshot
    // Map field names from StateSlicesSnapshot to ToolUseSessionSnapshot:
    // - runStateSnapshot → run
    // - workspaceSnapshot → workspace
    // - userChannels → user
    const snapshot: ToolUseSessionSnapshot = {
      version: TOOL_USE_SNAPSHOT_VERSION,
      executionId,
      streamId,
      agentConfig: taskState.agentConfig,
      messages: conversation as ToolUseSessionSnapshot['messages'],
      run: runStateSnapshot as ToolUseSessionSnapshot['run'],
      workspace: workspaceSnapshot as ToolUseSessionSnapshot['workspace'],
      user: userChannels as ToolUseSessionSnapshot['user'],
      lastUpdated: Date.now(),
    };

    logger.debug(`Retrieved snapshot for stream: ${streamId}`);
    return snapshot;
  } catch (error) {
    logger.error(`Failed to retrieve snapshot for stream: ${streamId}`, {
      data: error,
    });
    return null;
  }
}
