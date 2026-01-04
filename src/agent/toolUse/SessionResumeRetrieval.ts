/**
 * Session resume data retrieval for auto-resume functionality.
 *
 * This module provides functions to retrieve resume data from persisted state,
 * enabling automatic resumption of WAITING sessions for both workflow and tool-use agents.
 *
 * Resume strategies differ by agent type:
 * - Tool-use: Full snapshot needed (messages, state slices, etc.)
 * - Workflow: Just agentConfig + executionId (flow reads persisted state)
 */

import { z } from 'zod';

import { getExecutionStore } from '@agent/storage';
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { StreamTabId, ExecutionId } from '@agent/types/IdentifierTypes';
import type { FlowRecord } from '@agent/node/persisted-flow';
import { AgentRunStateSnapshotSchema } from '@agent/core/AgentState';
import { AgentWorkspaceStateSnapshotSchema } from '@agent/core/AgentWorkspaceState';
import { UserVariableChannelsSchema } from '@agent/core/AgentCycleOptions';
import { ProviderMessageSchema } from '@agent/modelHandlers/types/ProviderMessage';
import {
  TOOL_USE_SNAPSHOT_VERSION,
  type ToolUseSessionSnapshot,
} from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import type { TaskState } from '@logger/TaskState';
import { isToolUseTaskState, isWorkflowTaskState } from '@logger/TaskState';
import { AgentLogger } from '@logger/AgentLogger';

const logger = new AgentLogger('SessionResumeRetrieval');

// =============================================================================
// Types
// =============================================================================

/**
 * Resume data for tool-use sessions.
 * Contains full snapshot with messages, state slices, etc.
 */
export interface ToolUseResumeData {
  type: 'toolUse';
  snapshot: ToolUseSessionSnapshot;
}

/**
 * Resume data for workflow sessions.
 * Contains minimal data - flow reads persisted state via executionId.
 */
export interface WorkflowResumeData {
  type: 'workflow';
  agentConfig: AgentConfig;
  executionId: ExecutionId;
}

/**
 * Discriminated union of session resume data.
 * Use `type` field to determine how to resume.
 */
export type SessionResumeData = ToolUseResumeData | WorkflowResumeData;

// =============================================================================
// Schema for Tool-Use Flow Record Validation
// =============================================================================

/**
 * Schema for validating tool-use flow record shared state structure.
 * Maps internal field names to snapshot format.
 */
const ToolUseFlowRecordStateSchema = z.object({
  state: z.object({
    conversation: z.array(ProviderMessageSchema),
    stateSlices: z.object({
      runStateSnapshot: AgentRunStateSnapshotSchema,
      workspaceSnapshot: AgentWorkspaceStateSnapshotSchema,
      userChannels: UserVariableChannelsSchema,
    }),
  }),
});

// =============================================================================
// Public API
// =============================================================================

/**
 * Retrieve resume data for a WAITING session.
 *
 * Returns appropriate resume data based on task type:
 * - Tool-use: Full snapshot with messages and state
 * - Workflow: Minimal data (agentConfig + executionId)
 *
 * @param streamId - The stream tab ID
 * @param executionId - The execution ID for the stream
 * @param taskState - The persisted task state
 * @returns The resume data, or null if retrieval fails
 */
export async function retrieveSessionResumeData(
  streamId: StreamTabId,
  executionId: ExecutionId,
  taskState: TaskState,
): Promise<SessionResumeData | null> {
  if (isToolUseTaskState(taskState)) {
    return retrieveToolUseResumeData(streamId, executionId, taskState);
  }

  if (isWorkflowTaskState(taskState)) {
    return retrieveWorkflowResumeData(executionId, taskState);
  }

  logger.warn(`Unknown task state type for stream: ${streamId}`);
  return null;
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Retrieve resume data for a tool-use session.
 */
async function retrieveToolUseResumeData(
  streamId: StreamTabId,
  executionId: ExecutionId,
  taskState: TaskState,
): Promise<ToolUseResumeData | null> {
  try {
    const kv = getExecutionStore(executionId);
    const flowRecord = await kv.read<FlowRecord>(`flow:${executionId}`);

    if (!flowRecord?.shared) {
      logger.warn(`No flow record found for execution: ${executionId}`);
      return null;
    }

    const parseResult = ToolUseFlowRecordStateSchema.safeParse(flowRecord.shared);
    if (!parseResult.success) {
      logger.warn(`Invalid flow record structure for execution: ${executionId}`);
      return null;
    }

    const { conversation, stateSlices } = parseResult.data.state;

    const snapshot: ToolUseSessionSnapshot = {
      version: TOOL_USE_SNAPSHOT_VERSION,
      executionId,
      streamId,
      agentConfig: taskState.agentConfig,
      messages: conversation,
      run: stateSlices.runStateSnapshot,
      workspace: stateSlices.workspaceSnapshot,
      user: stateSlices.userChannels,
      lastUpdated: Date.now(),
    };

    logger.debug(`Retrieved tool-use resume data for stream: ${streamId}`);
    return { type: 'toolUse', snapshot };
  } catch (error) {
    logger.error(`Failed to retrieve tool-use resume data for stream: ${streamId}`, {
      data: error,
    });
    return null;
  }
}

/**
 * Retrieve resume data for a workflow session.
 * Workflow flows read persisted state via executionId, so no full snapshot needed.
 */
function retrieveWorkflowResumeData(
  executionId: ExecutionId,
  taskState: TaskState,
): WorkflowResumeData {
  return {
    type: 'workflow',
    agentConfig: taskState.agentConfig,
    executionId,
  };
}
