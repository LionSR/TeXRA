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

import {
  deriveResumability,
  RESUMABILITY_CAUSE,
  type ResumabilityDecision,
} from '@agent/storage';
import type { FlowRecord } from '@agent/node/persistedFlow';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { ReflectionFlowStateSchema } from '@agent/implementations/flows/reflection/ReflectionFlowState';
import {
  parseToolUseShared,
  type PreparedShared,
} from '@agent/implementations/flows/tooluse/nodes/types';
import { createLog } from '@logger/logUtils';
import type { StreamTabId, ExecutionId } from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';
import {
  inferAndLogPersistedModelHandlerCompatibilityKey,
  inferPersistedModelHandlerCompatibilityKey,
} from './modelHandlerCompatibilityInference';
import {
  ModelHandlerCompatibilityKeySchema,
  type ModelHandlerCompatibilityKey,
} from './modelHandlerCompatibilityKey';

const logger = createLog('SessionResumeRetrieval');

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
  readonly parentStreamId?: StreamTabId | undefined;
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

/** Agent-type label used in resume-retrieval warnings and error messages. */
type ResumeAgentLabel = 'tool-use' | 'workflow';

/**
 * Probe resumability for an execution: returns the persisted flow record when
 * resumable, `null` when there is nothing to resume, and throws when the
 * resume storage itself is unreadable (re-wrapped by the caller's catch).
 */
async function probeResumableFlowRecord(
  executionId: ExecutionId,
  agentType: ResumeAgentLabel,
): Promise<FlowRecord | null> {
  const resumability = await deriveResumability(executionId);
  if (!resumability.resumable) {
    throwIfResumeStorageUnreadable(resumability);
    logger.warn('Execution is not resumable', {
      data: { agentType, executionId, cause: resumability.cause },
    });
    return null;
  }
  return resumability.flowRecord;
}

/**
 * Wrap an unexpected retrieval failure (KV/IO error) so the resume boundary
 * can distinguish "resume failed" from "no session to resume" instead of
 * silently falling back to starting a new run.
 */
function resumeRetrievalError(
  agentType: ResumeAgentLabel,
  streamId: StreamTabId,
  error: unknown,
): Error {
  return new Error(
    `Failed to retrieve ${agentType} resume data for stream: ${streamId}`,
    { cause: error },
  );
}

/**
 * Retrieve resume data for a WAITING session.
 *
 * Returns appropriate resume data based on task type:
 * - Tool-use: Canonical shared state with launch metadata
 * - Workflow: agentConfig, executionId, and transcript-format key
 *
 * @param streamId - Stream tab ID used for logging and resume identity
 * @param executionId - The execution ID for the stream
 * @param agentConfig - The run config for the execution
 * @returns The resume data, or `null` when there is no resumable session
 *   (missing/invalid flow record). Throws when retrieval fails unexpectedly
 *   (e.g. a transient KV/IO error) so the caller can distinguish "nothing to
 *   resume" from "resume failed" instead of silently abandoning the session.
 */
export async function retrieveSessionResumeData(
  streamId: StreamTabId,
  executionId: ExecutionId,
  agentConfig: AgentConfig,
  options: SessionResumeRetrievalOptions = {},
): Promise<SessionResumeData | null> {
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
    const flowRecord = await probeResumableFlowRecord(executionId, 'tool-use');
    if (!flowRecord) return null;

    const parsedShared = parseToolUseShared(flowRecord.shared);
    if (!parsedShared.success) {
      logger.warn(
        `Invalid flow record structure for execution: ${executionId}`,
        {
          data: { error: parsedShared.error },
        },
      );
      return null;
    }

    const { stateSlices } = parsedShared.data;
    if (stateSlices === null) {
      logger.warn(
        `Invalid flow record structure for execution: ${executionId}`,
      );
      return null;
    }

    const currentConfig = {
      ...agentConfig,
      model: parsedShared.data.modelId ?? agentConfig.model,
    };
    const modelHandlerCompatibilityKey =
      parsedShared.data.modelHandlerCompatibilityKey ??
      inferAndLogPersistedModelHandlerCompatibilityKey(
        currentConfig.model,
        logger,
      );

    const shared: PreparedShared = {
      ...parsedShared.data,
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
    throw resumeRetrievalError('tool-use', streamId, error);
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
    const flowRecord = await probeResumableFlowRecord(executionId, 'workflow');
    if (!flowRecord) return null;

    const parseResult = ReflectionFlowStateSchema.safeParse(flowRecord.shared);
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
      inferPersistedModelHandlerCompatibilityKey(agentConfig.model);
    return {
      type: 'workflow',
      agentConfig,
      executionId,
      modelHandlerCompatibilityKey,
    };
  } catch (error) {
    throw resumeRetrievalError('workflow', streamId, error);
  }
}
