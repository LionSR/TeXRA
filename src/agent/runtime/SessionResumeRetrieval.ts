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

import { Effect } from 'effect';

import { deriveResumability } from '@agent/storage';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  PersistedFlowStateError,
  type FlowRecord,
} from '@agent/node/persistedFlow';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { ReflectionFlowStateSchema } from '@agent/implementations/flows/reflection/ReflectionFlowState';
import {
  parseToolUseShared,
  type PreparedShared,
} from '@agent/implementations/flows/tooluse/nodes/types';
import { createLog } from '@logger/logUtils';
import type { RunId } from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';
import type { ModelHandlerCompatibilityKey } from './modelHandlerCompatibilityKey';

const logger = createLog('SessionResumeRetrieval');

/** Canonical tool-use shared state plus the identity needed to resume it. */
export interface ToolUseResumeData {
  readonly type: 'toolUse';
  readonly shared: PreparedShared;
  readonly agentConfig: AgentConfig;
  readonly executionId: RunId;
}

/** Workflow session resume data: flow reads full state via executionId. */
interface WorkflowResumeData {
  readonly type: 'workflow';
  readonly agentConfig: AgentConfig;
  readonly executionId: RunId;
  readonly modelHandlerCompatibilityKey?: ModelHandlerCompatibilityKey | null;
}

type SessionResumeData = ToolUseResumeData | WorkflowResumeData;

/** Agent-type label used in resume-retrieval warnings and error messages. */
type ResumeAgentLabel = 'tool-use' | 'workflow';

/**
 * Probe resumability for an execution: returns the persisted flow record when
 * resumable, `null` when there is nothing to resume, and throws when the
 * resume storage itself is unreadable (re-wrapped by the caller's catch).
 */
const probeResumableFlowRecord = Effect.fn('probeResumableFlowRecord')(
  function* (
    executionId: RunId,
    agentType: ResumeAgentLabel,
    session: SessionHandle,
  ): Effect.fn.Return<FlowRecord | null, Error> {
    const resumability = yield* deriveResumability(executionId, session);
    if (resumability.kind === 'checkpoint') return resumability.flowRecord;
    // Unreadable storage is a failure to report, never "nothing to resume":
    // the caller's catch re-wraps it so hosts can word the difference. A record
    // that is present but malformed is the one fault that names the checkpoint
    // itself, so it throws the typed error the resume boundary refuses as
    // unusable saved state; a metadata or transient read failure stays an
    // untyped operational error there.
    if (resumability.kind === 'unreadable') {
      if (resumability.fault === 'checkpoint-malformed') {
        return yield* Effect.fail(
          new PersistedFlowStateError(executionId, 'unsupported-record'),
        );
      }
      return yield* Effect.fail(
        new Error(`Unable to read resume storage: ${resumability.cause}`),
      );
    }
    logger.warn('Execution is not resumable', {
      data: { agentType, executionId },
    });
    return null;
  },
);

/**
 * Wrap an unexpected retrieval failure (KV/IO error) so the resume boundary
 * can distinguish "resume failed" from "no session to resume" instead of
 * silently falling back to starting a new run.
 */
function resumeRetrievalError(
  agentType: ResumeAgentLabel,
  executionId: RunId,
  error: unknown,
): Error {
  return new Error(
    `Failed to retrieve ${agentType} resume data for run: ${executionId}`,
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
 * @param executionId - The run id
 * @param agentConfig - The run config for the run
 * @returns The resume data, or `null` when there is no resumable session
 *   (missing/invalid flow record). Throws when retrieval fails unexpectedly
 *   (e.g. a transient KV/IO error) so the caller can distinguish "nothing to
 *   resume" from "resume failed" instead of silently abandoning the session.
 */
export const retrieveSessionResumeData = Effect.fn('retrieveSessionResumeData')(
  function* (
    executionId: RunId,
    agentConfig: AgentConfig,
    session: SessionHandle,
  ): Effect.fn.Return<SessionResumeData | null, Error> {
    if (agentConfig.agentCategory === AgentCategory.ToolUse) {
      return yield* retrieveToolUseResumeData(executionId, agentConfig, session);
    }

    if (agentConfig.agentCategory === AgentCategory.Workflow) {
      return yield* retrieveWorkflowResumeData(
        executionId,
        agentConfig,
        session,
      );
    }

    logger.warn(`Unknown agent config type for run: ${executionId}`);
    return null;
  },
);

/**
 * Retrieve resume data for a tool-use session.
 */
const retrieveToolUseResumeData = Effect.fn('retrieveToolUseResumeData')(
  function* (
    executionId: RunId,
    agentConfig: AgentConfig,
    session: SessionHandle,
  ): Effect.fn.Return<ToolUseResumeData | null, Error> {
    const flowRecord = yield* probeResumableFlowRecord(
      executionId,
      'tool-use',
      session,
    ).pipe(
      Effect.mapError((error) =>
        resumeRetrievalError('tool-use', executionId, error),
      ),
    );
    return yield* Effect.try({
      try: (): ToolUseResumeData | null => {
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
          parsedShared.data.modelHandlerCompatibilityKey;

        const shared: PreparedShared = {
          ...parsedShared.data,
          stateSlices,
          ...(modelHandlerCompatibilityKey !== undefined && {
            modelHandlerCompatibilityKey,
          }),
        };

        logger.debug(`Retrieved tool-use resume data for run: ${executionId}`);
        return {
          type: 'toolUse',
          shared,
          executionId,
          agentConfig: currentConfig,
        };
      },
      catch: (error) => resumeRetrievalError('tool-use', executionId, error),
    });
  },
);

/**
 * Retrieve resume data for a workflow session.
 * Verifies flow record exists before returning resume data.
 * Workflow flows read full persisted state via executionId during resume.
 */
const retrieveWorkflowResumeData = Effect.fn('retrieveWorkflowResumeData')(
  function* (
    executionId: RunId,
    agentConfig: AgentConfig,
    session: SessionHandle,
  ): Effect.fn.Return<WorkflowResumeData | null, Error> {
    const flowRecord = yield* probeResumableFlowRecord(
      executionId,
      'workflow',
      session,
    ).pipe(
      Effect.mapError((error) =>
        resumeRetrievalError('workflow', executionId, error),
      ),
    );
    return yield* Effect.try({
      try: (): WorkflowResumeData | null => {
        if (!flowRecord) return null;

        const parseResult = ReflectionFlowStateSchema.safeParse(
          flowRecord.shared,
        );
        if (!parseResult.success) {
          logger.warn(
            `Invalid workflow flow record for execution: ${executionId}`,
          );
          return null;
        }

        logger.debug('Retrieved workflow resume data for run', {
          data: {
            executionId,
            currentRound: parseResult.data.currentRound,
            totalRounds: parseResult.data.totalRounds,
          },
        });
        const modelHandlerCompatibilityKey =
          parseResult.data.modelHandlerCompatibilityKey;
        return {
          type: 'workflow',
          agentConfig,
          executionId,
          modelHandlerCompatibilityKey,
        };
      },
      catch: (error) => resumeRetrievalError('workflow', executionId, error),
    });
  },
);
