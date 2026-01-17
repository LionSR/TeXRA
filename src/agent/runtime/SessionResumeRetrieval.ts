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
import {
  ExecutionIdSchema,
  type StreamTabId,
  type ExecutionId,
} from '@agent/types/IdentifierTypes';
import type { FlowRecord } from '@agent/node/persisted-flow';
import { AgentRunStateSnapshotSchema } from '@agent/core/AgentState';
import { AgentWorkspaceStateSnapshotSchema } from '@agent/core/AgentWorkspaceState';
import { UserVariableChannelsSchema } from '@agent/core/AgentCycleOptions';
import { ProviderMessageSchema } from '@agent/modelHandlers/types/ProviderMessage';
import {
  TOOL_USE_SNAPSHOT_VERSION,
  ToolUseSessionSnapshotSchema,
  type ToolUseSessionSnapshot,
} from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import type { TaskState } from '@logger/TaskState';
import { isToolUseTaskState, isWorkflowTaskState } from '@logger/TaskState';
import { AgentLogger } from '@logger/AgentLogger';

const logger = new AgentLogger('SessionResumeRetrieval');

// =============================================================================
// Types - Zod schemas as single source of truth
// =============================================================================

/**
 * Schema for tool-use session resume data.
 * Contains full snapshot with messages, state slices, etc.
 */
const ToolUseResumeDataSchema = z.object({
  type: z.literal('toolUse'),
  snapshot: ToolUseSessionSnapshotSchema,
});

/**
 * Schema for workflow session resume data.
 * Contains minimal data - flow reads persisted state via executionId.
 */
const WorkflowResumeDataSchema = z.object({
  type: z.literal('workflow'),
  agentConfig: AgentConfigSchema,
  executionId: ExecutionIdSchema,
});

/**
 * Discriminated union schema for session resume data.
 * Uses z.discriminatedUnion for O(1) lookup and better error messages.
 */
export const SessionResumeDataSchema = z.discriminatedUnion('type', [
  ToolUseResumeDataSchema,
  WorkflowResumeDataSchema,
]);

/** Resume data for tool-use sessions - derived from schema. */
export type ToolUseResumeData = z.infer<typeof ToolUseResumeDataSchema>;

/** Resume data for workflow sessions - derived from schema. */
export type WorkflowResumeData = z.infer<typeof WorkflowResumeDataSchema>;

/** Discriminated union of session resume data - derived from schema. */
export type SessionResumeData = z.infer<typeof SessionResumeDataSchema>;

// =============================================================================
// Schema for Tool-Use Flow Record Validation
// =============================================================================

/**
 * State slices schema (shared between flat and legacy formats).
 */
const StateSlicesSchema = z.object({
  runStateSnapshot: AgentRunStateSnapshotSchema,
  workspaceSnapshot: AgentWorkspaceStateSnapshotSchema,
  userChannels: UserVariableChannelsSchema,
});

/**
 * Current flat format schema (introduced with state flattening refactor).
 * Shared state has conversation and stateSlices at top level.
 */
const FlatToolUseFlowRecordStateSchema = z.object({
  conversation: z.array(ProviderMessageSchema),
  stateSlices: StateSlicesSchema,
});

/**
 * Legacy format schema (pre-flattening).
 * Shared state is wrapped in a `state` property.
 */
const LegacyToolUseFlowRecordStateSchema = z.object({
  state: z.object({
    conversation: z.array(ProviderMessageSchema),
    stateSlices: StateSlicesSchema,
  }),
});

/**
 * Normalized result from parsing either format.
 * Both schemas are transformed to this common structure.
 */
interface NormalizedToolUseState {
  conversation: z.infer<typeof ProviderMessageSchema>[];
  stateSlices: z.infer<typeof StateSlicesSchema>;
}

/**
 * Parse tool-use flow record shared state, supporting both flat and legacy formats.
 * Returns normalized state structure regardless of input format.
 */
function parseToolUseFlowRecordState(
  shared: unknown,
): NormalizedToolUseState | null {
  // Try flat format first (current)
  const flatResult = FlatToolUseFlowRecordStateSchema.safeParse(shared);
  if (flatResult.success) {
    return flatResult.data;
  }

  // Fall back to legacy format (unwrap nested state)
  const legacyResult = LegacyToolUseFlowRecordStateSchema.safeParse(shared);
  if (legacyResult.success) {
    return legacyResult.data.state;
  }

  return null;
}

/**
 * Minimal schema for validating workflow flow record exists and has resumable state.
 * Full validation happens when the flow actually resumes.
 */
const WorkflowFlowRecordStateSchema = z.object({
  currentRound: z.number(),
  totalRounds: z.number(),
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

    // Parse shared state, supporting both flat and legacy formats
    const parsedState = parseToolUseFlowRecordState(flowRecord.shared);
    if (!parsedState) {
      logger.warn(
        `Invalid flow record structure for execution: ${executionId}`,
      );
      return null;
    }

    const { conversation, stateSlices } = parsedState;

    // Construct and validate the complete snapshot.
    // Validation provides defense-in-depth: even if flow record is valid,
    // we ensure the assembled snapshot matches the expected schema.
    const rawSnapshot = {
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
    const kv = getExecutionStore(executionId);
    const flowRecord = await kv.read<FlowRecord>(`flow:${executionId}`);

    if (!flowRecord?.shared) {
      logger.warn(
        `No flow record found for workflow execution: ${executionId}`,
      );
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
