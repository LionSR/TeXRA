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
import { AgentConfigSchema } from '@agent/core/AgentConfig';
import { flowKey, type FlowRecord } from '@agent/node/persistedFlow';
import { AgentRunStateSnapshotSchema } from '@agent/core/AgentState';
import { AgentWorkspaceStateSnapshotSchema } from '@agent/core/AgentWorkspaceState';
import { UserVariableChannelsSchema } from '@agent/core/AgentCycleOptions';
import { ProviderMessageSchema } from '@agent/modelHandlers/types/ProviderMessage';
import {
  TOOL_USE_SNAPSHOT_VERSION,
  ToolUseSessionSnapshotSchema,
} from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import { createChannelTrace } from '@logger';
import type { TaskState } from '@logger/TaskState';
import { isToolUseTaskState, isWorkflowTaskState } from '@logger/TaskState';
import {
  ExecutionIdSchema,
  type StreamTabId,
  type ExecutionId,
} from '@shared/schemas';

const logger = createChannelTrace('SessionResumeRetrieval');

/** Tool-use session resume data: full snapshot with messages, state slices. */
const ToolUseResumeDataSchema = z.object({
  type: z.literal('toolUse'),
  snapshot: ToolUseSessionSnapshotSchema,
});

/** Workflow session resume data: minimal — flow reads persisted state via executionId. */
const WorkflowResumeDataSchema = z.object({
  type: z.literal('workflow'),
  agentConfig: AgentConfigSchema,
  executionId: ExecutionIdSchema,
});

type ToolUseResumeData = z.infer<typeof ToolUseResumeDataSchema>;
type WorkflowResumeData = z.infer<typeof WorkflowResumeDataSchema>;

export type SessionResumeData = ToolUseResumeData | WorkflowResumeData;

/** State slices schema (shared between flat and legacy formats). */
const StateSlicesSchema = z.object({
  runStateSnapshot: AgentRunStateSnapshotSchema,
  workspaceSnapshot: AgentWorkspaceStateSnapshotSchema,
  userChannels: UserVariableChannelsSchema,
});

/** Core fields schema — accepts `messages` (current) or `conversation` (legacy), normalizing to `messages`. */
const ToolUseStateFieldsSchema = z
  .union([
    z.object({
      messages: z.array(ProviderMessageSchema),
      stateSlices: StateSlicesSchema,
    }),
    z.object({
      conversation: z.array(ProviderMessageSchema),
      stateSlices: StateSlicesSchema,
    }),
  ])
  .transform((data) => ({
    messages: 'messages' in data ? data.messages : data.conversation,
    stateSlices: data.stateSlices,
  }));

/**
 * Schema that accepts both flat and legacy formats, normalizing to flat.
 * - Flat format: { messages, stateSlices, ... }
 * - Legacy format: { state: { messages, stateSlices, ... } }
 */
const ToolUseFlowRecordStateSchema = z
  .union([
    ToolUseStateFieldsSchema,
    z.object({ state: ToolUseStateFieldsSchema }),
  ])
  .transform((data) => ('state' in data ? data.state : data));

type NormalizedToolUseState = z.infer<typeof ToolUseFlowRecordStateSchema>;

/**
 * Minimal schema for validating workflow flow record exists and has resumable state.
 * Full validation happens when the flow actually resumes.
 */
const WorkflowFlowRecordStateSchema = z.object({
  currentRound: z.int().nonnegative(),
  totalRounds: z.int().nonnegative(),
});

/**
 * Retrieve resume data for a WAITING session.
 *
 * Returns appropriate resume data based on task type:
 * - Tool-use: Full snapshot with messages and state
 * - Workflow: Minimal data (agentConfig + executionId)
 *
 * @param streamId - Stream tab ID (used for logging and tool-use snapshot)
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
    return retrieveWorkflowResumeData(streamId, executionId, taskState);
  }

  logger.warn(`Unknown task state type for stream: ${streamId}`);
  return null;
}

/** Read a flow record from the execution store. Returns null if absent or invalid. */
async function readFlowRecord(
  executionId: ExecutionId,
  agentType: 'tool-use' | 'workflow',
): Promise<FlowRecord | null> {
  const kv = getExecutionStore(executionId);
  const flowRecord = await kv.read<FlowRecord>(flowKey(executionId));

  if (!flowRecord?.shared) {
    logger.warn(
      `No flow record found for ${agentType} execution: ${executionId}`,
    );
    return null;
  }

  return flowRecord;
}

/**
 * Retrieve resume data for a tool-use session.
 */
async function retrieveToolUseResumeData(
  streamId: StreamTabId,
  executionId: ExecutionId,
  taskState: TaskState,
): Promise<ToolUseResumeData | null> {
  try {
    const flowRecord = await readFlowRecord(executionId, 'tool-use');
    if (!flowRecord) {
      return null;
    }

    // Parse shared state, supporting both flat and legacy formats
    const parseResult = ToolUseFlowRecordStateSchema.safeParse(
      flowRecord.shared,
    );
    if (!parseResult.success) {
      logger.warn(
        `Invalid flow record structure for execution: ${executionId}`,
      );
      return null;
    }

    const { messages, stateSlices } = parseResult.data;

    // Construct and validate the complete snapshot.
    // Validation provides defense-in-depth: even if flow record is valid,
    // we ensure the assembled snapshot matches the expected schema.
    const rawSnapshot = {
      version: TOOL_USE_SNAPSHOT_VERSION,
      executionId,
      streamId,
      agentConfig: taskState.agentConfig,
      messages,
      run: stateSlices.runStateSnapshot,
      workspace: stateSlices.workspaceSnapshot,
      user: stateSlices.userChannels,
      lastUpdated: Date.now(),
    };

    const snapshotResult = ToolUseSessionSnapshotSchema.safeParse(rawSnapshot);
    if (!snapshotResult.success) {
      logger.warn(
        `Invalid snapshot structure for stream: ${streamId}: ${snapshotResult.error.message}`,
      );
      return null;
    }

    logger.debug(`Retrieved tool-use resume data for stream: ${streamId}`);
    return { type: 'toolUse', snapshot: snapshotResult.data };
  } catch (error) {
    logger.error(
      `Failed to retrieve tool-use resume data for stream: ${streamId}`,
      {
        data: error,
      },
    );
    return null;
  }
}

/**
 * Retrieve resume data for a workflow session.
 * Verifies flow record exists before returning resume data.
 * Workflow flows read full persisted state via executionId during resume.
 */
async function retrieveWorkflowResumeData(
  streamId: StreamTabId,
  executionId: ExecutionId,
  taskState: TaskState,
): Promise<WorkflowResumeData | null> {
  try {
    const flowRecord = await readFlowRecord(executionId, 'workflow');
    if (!flowRecord) {
      return null;
    }

    // Minimal validation - just verify essential fields exist.
    // Full state validation happens when the flow actually resumes.
    const parseResult = WorkflowFlowRecordStateSchema.safeParse(
      flowRecord.shared,
    );
    if (!parseResult.success) {
      logger.warn(`Invalid workflow flow record for execution: ${executionId}`);
      return null;
    }

    logger.debug(
      `Retrieved workflow resume data for stream: ${streamId} (round ${parseResult.data.currentRound}/${parseResult.data.totalRounds})`,
    );
    return {
      type: 'workflow',
      agentConfig: taskState.agentConfig,
      executionId,
    };
  } catch (error) {
    logger.error(
      `Failed to retrieve workflow resume data for stream: ${streamId}`,
      {
        data: error,
      },
    );
    return null;
  }
}
