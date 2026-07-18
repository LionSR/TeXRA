/**
 * Session resume data retrieval for auto-resume functionality.
 *
 * This module provides functions to retrieve resume data from persisted state,
 * enabling automatic resumption of WAITING sessions for both workflow and tool-use agents.
 *
 * Resume strategies differ by agent type:
 * - Tool-use: Canonical shared state plus resume identity
 * - Workflow: agentConfig + executionId + transcript-format key
 */

import { z } from 'zod';

import {
  deriveResumability,
  RESUMABILITY_CAUSE,
  type ResumabilityDecision,
} from '@agent/storage';
import { createChannelTrace } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { ProviderMessageArraySchema } from '@agent/types/ProviderMessage';
import {
  migrateSharedState,
  type PreparedShared,
} from '@agent/implementations/flows/tooluse/nodes/types';
import { currentModelFromUserChannels } from '@agent/implementations/flows/tooluse/modelSwitchState';
import type { TaskState } from '@agent/core/state/TaskState';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { StreamTabId, ExecutionId } from '@shared/schemas';
import { inferPersistedModelHandlerCompatibilityKey } from './modelHandlerCompatibilityInference';
import {
  ModelHandlerCompatibilityKeySchema,
  type ModelHandlerCompatibilityKey,
} from './modelHandlerCompatibilityKey';

const logger = createChannelTrace('SessionResumeRetrieval');

/** Canonical tool-use shared state plus the identity needed to resume it. */
export interface ToolUseResumeData {
  readonly type: 'toolUse';
  readonly shared: PreparedShared;
  readonly agentConfig: AgentConfig;
  readonly executionId: ExecutionId;
  readonly streamId: StreamTabId;
  readonly parentStreamId?: StreamTabId;
}

/** Workflow session resume data: flow reads full state via executionId. */
interface WorkflowResumeData {
  readonly type: 'workflow';
  readonly agentConfig: AgentConfig;
  readonly executionId: ExecutionId;
  readonly modelHandlerCompatibilityKey?: ModelHandlerCompatibilityKey | null;
}

export type SessionResumeData = ToolUseResumeData | WorkflowResumeData;

export interface SessionResumeRetrievalOptions {
  readonly parentStreamId?: StreamTabId;
}

function throwIfResumeStorageUnreadable(
  resumability: ResumabilityDecision,
): void {
  if (resumability.resumable) return;
  if (
    resumability.cause !== RESUMABILITY_CAUSE.UNREADABLE_FLOW &&
    resumability.cause !== RESUMABILITY_CAUSE.UNREADABLE_META &&
    resumability.cause !== RESUMABILITY_CAUSE.INVALID_META
  ) {
    return;
  }
  throw new Error(`Unable to read resume storage: ${resumability.cause}`);
}

/**
 * Minimal schema for validating workflow flow record exists and has resumable state.
 * Full validation happens when the flow actually resumes.
 */
const WorkflowFlowRecordStateSchema = z
  .looseObject({
    currentRound: z.int().nonnegative(),
    totalRounds: z.int().nonnegative(),
    conversation: ProviderMessageArraySchema.nullish(),
    messages: ProviderMessageArraySchema.nullish(),
    modelHandlerCompatibilityKey: ModelHandlerCompatibilityKeySchema.nullish(),
  })
  .transform(({ messages, conversation, ...state }) => ({
    ...state,
    conversation: conversation ?? messages ?? [],
  }));

/**
 * Retrieve resume data for a WAITING session.
 *
 * Returns appropriate resume data based on task type:
 * - Tool-use: Canonical shared state with launch metadata
 * - Workflow: agentConfig, executionId, and transcript-format key
 *
 * @param streamId - Stream tab ID used for logging and resume identity
 * @param executionId - The execution ID for the stream
 * @param state - Current run config, or legacy TaskState compatibility input
 * @returns The resume data, or `null` when there is no resumable session
 *   (missing/invalid flow record). Throws when retrieval fails unexpectedly
 *   (e.g. a transient KV/IO error) so the caller can distinguish "nothing to
 *   resume" from "resume failed" instead of silently abandoning the session.
 */
export async function retrieveSessionResumeData(
  streamId: StreamTabId,
  executionId: ExecutionId,
  state: AgentConfig | TaskState,
  options: SessionResumeRetrievalOptions = {},
): Promise<SessionResumeData | null> {
  const agentConfig = 'agentConfig' in state ? state.agentConfig : state;

  if (agentConfig.agentCategory === AgentCategory.ToolUse) {
    return retrieveToolUseResumeData(
      streamId,
      executionId,
      agentConfig,
      options,
    );
  }

  if (agentConfig.agentCategory === AgentCategory.Workflow) {
    return retrieveWorkflowResumeData(streamId, executionId, agentConfig);
  }

  logger.warn(`Unknown agent config type for stream: ${streamId}`);
  return null;
}

/**
 * Retrieve resume data for a tool-use session.
 */
async function retrieveToolUseResumeData(
  streamId: StreamTabId,
  executionId: ExecutionId,
  agentConfig: AgentConfig,
  options: SessionResumeRetrievalOptions,
): Promise<ToolUseResumeData | null> {
  try {
    const resumability = await deriveResumability(executionId);
    if (!resumability.resumable) {
      throwIfResumeStorageUnreadable(resumability);
      logger.warn('Execution is not resumable', {
        data: {
          agentType: 'tool-use',
          executionId,
          cause: resumability.cause,
        },
      });
      return null;
    }
    const { flowRecord } = resumability;

    const migrationResult = migrateSharedState(flowRecord.shared);
    if (!migrationResult.success) {
      logger.warn(
        `Invalid flow record structure for execution: ${executionId}`,
        {
          data: { error: migrationResult.error },
        },
      );
      return null;
    }

    const { messages, stateSlices } = migrationResult.data;
    if (stateSlices === null) {
      logger.warn(
        `Invalid flow record structure for execution: ${executionId}`,
      );
      return null;
    }

    const currentConfig = {
      ...agentConfig,
      model:
        currentModelFromUserChannels(stateSlices.userChannels) ??
        agentConfig.model,
    };
    const modelHandlerCompatibilityKey =
      migrationResult.data.modelHandlerCompatibilityKey ??
      inferPersistedModelHandlerCompatibilityKey(currentConfig.model, messages);

    const shared: PreparedShared = {
      ...migrationResult.data,
      stateSlices,
      ...(modelHandlerCompatibilityKey !== undefined && {
        modelHandlerCompatibilityKey,
      }),
    };

    logger.debug(`Retrieved tool-use resume data for stream: ${streamId}`);
    return {
      type: 'toolUse',
      shared,
      executionId,
      streamId,
      ...(options.parentStreamId !== undefined && {
        parentStreamId: options.parentStreamId,
      }),
      agentConfig: currentConfig,
    };
  } catch (error) {
    // An unexpected failure here (KV/IO error) is NOT the same as "no session
    // to resume" — propagate it so the resume boundary surfaces it rather than
    // silently falling back to "start a new run".
    throw new Error(
      `Failed to retrieve tool-use resume data for stream: ${streamId}`,
      { cause: error },
    );
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
  agentConfig: AgentConfig,
): Promise<WorkflowResumeData | null> {
  try {
    const resumability = await deriveResumability(executionId);
    if (!resumability.resumable) {
      throwIfResumeStorageUnreadable(resumability);
      logger.warn('Execution is not resumable', {
        data: {
          agentType: 'workflow',
          executionId,
          cause: resumability.cause,
        },
      });
      return null;
    }
    const { flowRecord } = resumability;

    // Minimal validation - just verify essential fields exist.
    // Full state validation happens when the flow actually resumes.
    const parseResult = WorkflowFlowRecordStateSchema.safeParse(
      flowRecord.shared,
    );
    if (!parseResult.success) {
      logger.warn(`Invalid workflow flow record for execution: ${executionId}`);
      return null;
    }

    logger.debug('Retrieved workflow resume data for stream', {
      data: {
        streamId,
        currentRound: parseResult.data.currentRound,
        totalRounds: parseResult.data.totalRounds,
      },
    });
    const modelHandlerCompatibilityKey =
      parseResult.data.modelHandlerCompatibilityKey ??
      inferPersistedModelHandlerCompatibilityKey(
        agentConfig.model,
        parseResult.data.conversation,
      );
    return {
      type: 'workflow',
      agentConfig,
      executionId,
      modelHandlerCompatibilityKey,
    };
  } catch (error) {
    // Unexpected failure (KV/IO error) is distinct from "no session to resume":
    // propagate so the resume boundary surfaces it instead of silently
    // degrading to "start a new run".
    throw new Error(
      `Failed to retrieve workflow resume data for stream: ${streamId}`,
      { cause: error },
    );
  }
}
