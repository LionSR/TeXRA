// Standard library imports
import * as path from 'path';

import { z } from 'zod';

// Local imports - core flow primitives
import { isRemoteAgent } from '@agent/index';
import { BaseNode, Flow } from '@agent/node';
// Internal imports
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import {
  BaseCycleFieldsSchema,
  BaseInvocationPrepResult,
  BaseInvocationSuccessData,
  getDebugContext,
  resetCycleState,
  SkippableNodeResult,
} from '@agent/core/flows/CommonCycleTypes';
import { RetryErrorInfoSchema, type RetryErrorInfo } from './RetryState';
// Type imports
import { type ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { ProviderStopReason } from '@agent/modelHandlers/types/StopReasonTypes';

// Local imports - utilities
import { maybeSaveDebugObject } from '@agent/utils/debugMessageSaver';
// Internal imports
import { messageToSkeleton } from '@agent/utils/messageSkeletonUtils';
import { checkForMassiveRepetition } from '@agent/utils/text/repetitionUtils';

// Local imports - logging
// Internal imports
import { isTokenLimitStopReason } from '@agent/modelHandlers/utils/stopReasonUtils';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import replacementEngine from '@replacement/engine';
import { getSystemPromptWithRules } from '@utils/prompt';
import { AgentFileLocationSchema, type AgentFileLocation } from '@utils/files';
import { K_SLICE, REPETITION_DETECTION_THRESHOLD } from '@utils/config';
import { AbsoluteFS, flexibleFS } from '@utils/files';
import { extractScratchpad } from '@utils/text/xmlUtils';
import { bestConnectionMethod } from '@latex';

// Local file imports
import { FlowTransition } from './FlowTransitions';
import {
  type InvocationResult,
  RetryableInvocationNode,
  handleInvocationResult,
} from './RetryState';
import {
  finalizeRound,
  type ResponseCycleParams,
  type ResponseCycleServices,
} from './CycleServices';

// All debug options (context + file options) are derived at maybeSaveDebugObject call sites.

// ============================================================================
// Cycle Fields Schema (Extends Base)
// ============================================================================

/**
 * Schema for serializable response cycle fields.
 *
 * Extends BaseCycleFieldsSchema with response-specific fields for output tracking.
 * ReflectionFlowShared uses this (or derives from it) for native nesting.
 *
 * ## Field Categories
 *
 * From BaseCycleFieldsSchema (shared with ToolUseCycleFlow):
 * - messages, shouldStop, endTurn, responseTimeMs, stopReason, lastError
 *
 * Response-specific fields:
 * - outputExists, outputLocation, processedResponse
 *
 * ## Serialization
 *
 * All fields here are natively serializable (structuredClone compatible).
 * Non-serializable fields (debug, responseObject) are in CycleTransientFields.
 */
export const CycleFieldsSchema = BaseCycleFieldsSchema.extend({
  /** Whether output file exists */
  outputExists: z.boolean(),
  /** Agent output location (nullable for native nesting compatibility) */
  outputLocation: AgentFileLocationSchema.nullable(),
  /** Processed response text */
  processedResponse: z.string().optional(),
});

/** Serializable cycle fields derived from schema */
export type CycleFields = z.infer<typeof CycleFieldsSchema>;

/**
 * Transient cycle fields that are NOT serialized.
 *
 * These contain non-serializable data (unknown response objects)
 * and are regenerated each cycle execution.
 *
 * NOTE: All debug options (context and file options) are derived from
 * services/shared at each `maybeSaveDebugObject` call site. Nothing is
 * stored in shared state.
 */
export interface CycleTransientFields {
  /** System prompt for model (regenerated from agent prompt each cycle) */
  systemPrompt?: string;
  /** Raw response from model (type unknown, not serialized) */
  responseObject?: unknown;
}

/**
 * Full cycle shared type combining serializable and transient fields.
 *
 * This is what cycle nodes operate on. For native nesting, the outer
 * flow's shared type (e.g., ReflectionFlowShared) must be compatible
 * with this type.
 */
export type ResponseCycleShared = CycleFields & CycleTransientFields;

/**
 * Assert that a shared object has all required cycle fields populated.
 *
 * Use this before running a cycle flow on an outer flow's shared state
 * to get type-safe access without `as unknown as` double cast.
 *
 * @throws Error if required cycle fields are missing
 */
export function assertCycleFieldsPopulated<T extends object>(
  shared: T,
): asserts shared is T & ResponseCycleShared {
  // Required fields that must be defined (not undefined)
  const requiredDefined = [
    'messages',
    'shouldStop',
    'endTurn',
    'outputExists',
  ] as const;
  const obj = shared as Record<string, unknown>;
  for (const field of requiredDefined) {
    if (obj[field] === undefined) {
      throw new Error(
        `Cycle field '${field}' must be populated before running cycle flow`,
      );
    }
  }
  // outputLocation must be non-null (downstream code uses it directly)
  if (obj['outputLocation'] === undefined || obj['outputLocation'] === null) {
    throw new Error(
      `Cycle field 'outputLocation' must be set to a valid location before running cycle flow`,
    );
  }
}

/**
 * Reset cycle state for a new iteration.
 * Called at the start of each cycle to clear transient fields.
 * Reuses resetCycleState for base fields, adds response-specific fields.
 */
function resetResponseCycleShared(shared: ResponseCycleShared): void {
  resetCycleState(shared, ['responseObject', 'processedResponse']);
}

// Each node in the response cycle progressively hydrates the shared cycle
// object. Mutations performed in `prep`, `exec`, and `post` stages are
// intentionally visible to downstream nodes so that debug metadata and model
// results accumulate over the course of the flow.

/**
 * Prepares a response cycle by hydrating prompts, checking interruptions, and
 * establishing debug metadata before invoking the model.
 *
 * Services accessed via `_params.services` (options flattened into services).
 */
class ResponsePrepNode<C> extends BaseNode<
  ResponseCycleShared,
  ResponseCycleParams<C>,
  ResponseCycleServices<C>
> {
  async prep(shared: ResponseCycleShared): Promise<{
    interrupted: boolean;
    exists: boolean;
    systemPrompt?: string;
    outputLocation: AgentFileLocation;
  }> {
    const services = this.services;
    const { agentPrompt, userVars } = services;
    const interrupted = Boolean(await services.checkInterruption());
    // Non-null assertion: outputLocation is set by caller before cycle starts
    const outputLocation = shared.outputLocation!;
    const exists = await flexibleFS.exists(outputLocation);
    const systemPrompt = interrupted
      ? undefined
      : await getSystemPromptWithRules(agentPrompt.systemPrompt, userVars);

    return {
      interrupted,
      exists,
      systemPrompt,
      outputLocation,
    };
  }

  async post(
    shared: ResponseCycleShared,
    prepRes: {
      interrupted: boolean;
      exists: boolean;
      systemPrompt?: string;
      outputLocation: AgentFileLocation;
    },
  ): Promise<string | undefined> {
    if (prepRes.interrupted) {
      resetResponseCycleShared(shared);
      shared.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    const { agentConfig, round } = this.services;
    shared.outputExists = prepRes.exists;
    shared.systemPrompt = prepRes.systemPrompt;
    shared.outputLocation = prepRes.outputLocation;
    resetResponseCycleShared(shared);

    // Debug file options derived at call site (not stored in shared)
    await maybeSaveDebugObject({
      object: shared.messages,
      objectType: 'messages',
      context: getDebugContext(this.services, {
        modelName: agentConfig.model,
        isRemote: isRemoteAgent(agentConfig.agent),
      }),
      fileOptions: {
        continuationCount: round.continuationCount,
        baseName: 'response',
        outputFile: prepRes.outputLocation.relativePath,
      },
    });

    return FlowTransition.DEFAULT;
  }
}

/**
 * Data extracted by prep() for model invocation.
 * Extends base with optional system prompt for response generation.
 */
interface InvocationPrepResult extends BaseInvocationPrepResult {
  systemPrompt?: string;
}

/**
 * Result type for model invocation (uses shared InvocationResult).
 */
type InvocationExecResult = InvocationResult<BaseInvocationSuccessData>;

/**
 * Handles model invocation with PocketFlow's built-in retry.
 *
 * Extends RetryableInvocationNode for shared retry logic:
 * - maxRetries and wait configured from user settings
 * - exec() throws on error, Node retries automatically
 * - retryPrompt() shows UI when auto-retries exhausted (if error is retryable)
 * - execFallback() called only when user cancels or error is non-retryable
 *
 * Flow transitions:
 * - default: Continue to next node on success
 * - COMPLETE: All retries exhausted, non-retryable error, or user cancelled
 *
 * Services accessed via `_params.services` (options flattened into services).
 */
class ResponseModelInvocationNode<C> extends RetryableInvocationNode<
  ResponseCycleShared,
  ResponseCycleParams<C>,
  ResponseCycleServices<C>
> {
  protected getOperationName(): string {
    return 'Model invocation';
  }

  /**
   * Check if background mode is active via the model handler.
   * This enables the base class to enforce minimum retry count for background jobs.
   */
  protected override isBackgroundModeActive(): boolean {
    return this.services.modelHandler.isBackgroundModeActive();
  }

  /**
   * Extract data from shared for exec().
   * PocketFlow compliance: exec() should only use prepRes, not shared.
   */
  async prep(shared: ResponseCycleShared): Promise<InvocationPrepResult> {
    return {
      shouldStop: shared.shouldStop,
      messages: shared.messages,
      systemPrompt: shared.systemPrompt,
    };
  }

  async exec(prepRes: InvocationPrepResult): Promise<InvocationExecResult> {
    const services = this.services;

    if (prepRes.shouldStop) {
      return { kind: 'skipped' };
    }

    services.modelHandler.setOutputStreaming(false);

    const stage = await services.logger.stage('Model invocation', {
      skip: true,
    });

    const start = Date.now();

    // Use base class helper for abort controller lifecycle
    return this.withAbortController(async (signal) => {
      const { response, responseTimeMs } = await stage.run(async () => {
        const modelResponse = await services.modelHandler.createResponse({
          client: services.client,
          messages: prepRes.messages,
          temperature: services.agentSetting.temperature || 0.0,
          systemPrompt: prepRes.systemPrompt,
          endTag: services.agentSetting.endTag,
          signal,
          tools: services.modelHandler.capabilities.supportsFunctionCalling
            ? services.agentSetting.tools
            : undefined,
        });

        const elapsedMs = Date.now() - start;

        return { response: modelResponse, responseTimeMs: elapsedMs };
      });

      return { kind: 'success', response, responseTimeMs };
    });
    // Note: Errors from createResponse() are caught by PocketFlow Node's
    // retry loop in _exec(), which calls retryPrompt() then execFallback().
  }

  /**
   * Called by PocketFlow Node when retryPrompt returns false.
   * Uses base class getFallbackResult() for shared logic.
   */
  async execFallback(
    _prepRes: InvocationPrepResult,
    error: Error,
  ): Promise<InvocationExecResult> {
    return this.getFallbackResult(error);
  }

  async post(
    shared: ResponseCycleShared,
    _prepRes: InvocationPrepResult,
    execRes: InvocationExecResult,
  ): Promise<string | undefined> {
    const { logger, agentConfig, round } = this.services;

    // Handle non-success cases (returns null) or get narrowed success result
    // Pass shared directly since it's now flat (has shouldStop, endTurn, lastError)
    const successRes = handleInvocationResult(execRes, shared, shared, {
      logger,
      operationName: this.getOperationName(),
    });

    if (!successRes) {
      return FlowTransition.COMPLETE;
    }

    // Apply success-specific side effects
    shared.responseObject = successRes.response;
    shared.responseTimeMs = successRes.responseTimeMs;

    // Debug options derived at call site (not stored in shared)
    await maybeSaveDebugObject({
      object: successRes.response,
      objectType: 'response',
      context: getDebugContext(this.services, {
        modelName: agentConfig.model,
        isRemote: isRemoteAgent(agentConfig.agent),
      }),
      fileOptions: {
        continuationCount: round.continuationCount,
        baseName: 'response',
        outputFile: shared.outputLocation!.relativePath,
      },
    });

    return FlowTransition.DEFAULT;
  }
}

/**
 * Data extracted by prep() for response processing.
 * PocketFlow compliance: exec() should only use prepRes, not shared.
 */
interface ProcessPrepResult {
  shouldStop: boolean;
  responseObject: unknown;
  responseTimeMs?: number;
  messages: ProviderMessage[];
  outputLocation: AgentFileLocation;
  outputExists: boolean;
  /** Last response for connector calculation (read before update) */
  lastResponse: string;
  /** Accumulated output for updating (read before update) */
  accumulatedOutput: string;
}

interface ProcessResult {
  stopReason: ProviderStopReason;
  newResponse?: string;
  processedResponse?: string;
  bestConnector?: string;
  thinkingContent?: string | null;
  useStreaming: boolean;
  responseUsage: any;
  /** Normalized usage - single source of truth */
  normalizedUsage: NormalizedUsage;
  repetitionDetected: boolean;
  /** Response time in ms for store update in post() */
  responseTimeMs?: number;
  /** Updated last response for store update in post() */
  updatedLastResponse?: string;
  /** Updated accumulated output for store update in post() */
  updatedAccumulatedOutput?: string;
}

type ProcessNodeResult = SkippableNodeResult<ProcessResult>;

/**
 * Data extracted by prep() for continuation decision.
 * PocketFlow compliance: exec() should only use prepRes, not shared.
 */
interface ContinuationPrepResult {
  shouldSkip: boolean;
  interrupted: boolean;
  stopReason?: ProviderStopReason;
  processedResponse?: string;
  messages: ProviderMessage[];
}

type ContinuationNodeResult = SkippableNodeResult<{
  shouldEndTurn: boolean;
  shouldStop: boolean;
  shouldContinue: boolean;
}>;

/**
 * Transforms the raw model response into output-ready text, updates usage metrics,
 * and persists incremental tool-state derived from the result.
 *
 * PocketFlow compliance:
 * - prep() extracts only the data needed by exec()
 * - exec() performs pure computation, no side effects
 * - post() applies all side effects (store updates)
 *
 * Services accessed via `_params.services` (options flattened into services).
 */
class ResponseProcessNode<C> extends BaseNode<
  ResponseCycleShared,
  ResponseCycleParams<C>,
  ResponseCycleServices<C>
> {
  async prep(shared: ResponseCycleShared): Promise<ProcessPrepResult> {
    const { workspace } = this.services;
    return {
      shouldStop: shared.shouldStop,
      responseObject: shared.responseObject,
      responseTimeMs: shared.responseTimeMs,
      messages: shared.messages,
      // Non-null assertion: outputLocation is set by caller before cycle starts
      outputLocation: shared.outputLocation!,
      outputExists: shared.outputExists,
      // Read workspace values before they're updated (for connector calculation)
      lastResponse: workspace.assembly.lastResponse,
      accumulatedOutput: workspace.assembly.accumulatedOutput,
    };
  }

  async exec(prepRes: ProcessPrepResult): Promise<ProcessNodeResult> {
    const { workspace, logger, modelHandler, agentSetting } = this.services;

    if (prepRes.shouldStop || !prepRes.responseObject) {
      return { kind: 'skipped' };
    }

    // Capture the current group ID for logging (matches ToolUseCycleFlow pattern)
    const groupId = logger.withCurrentGroup((id) => id);

    const stage = await logger.stage('Process response', {
      skip: true,
    });

    return stage.run(async () => {
      const {
        response: newResponse,
        usage: responseUsage,
        stopReason,
      } = modelHandler.extractResponse(
        prepRes.responseObject,
        agentSetting.endTag,
      );

      if (newResponse) {
        logger.debug(`Model response: ${newResponse.slice(0, 100)}`);
      }

      if (prepRes.responseTimeMs !== undefined) {
        logger.debug(
          `Response time: ${(prepRes.responseTimeMs / 1000).toFixed(2)}s`,
        );
      }

      logger.debug(`Stop reason: ${stopReason}`);
      logger.debug(`Token usage: ${JSON.stringify(responseUsage)}`);

      const thinkingContent = modelHandler.processThinkingBlock(
        prepRes.responseObject,
        workspace,
      );
      const useStreaming = modelHandler.getStreamingConfig();

      // For non-streaming mode, emit thinking to progress view
      // (streaming mode already shows it progressively via streams)
      if (thinkingContent && !useStreaming) {
        logger.info(thinkingContent, {
          groupId,
          messageType: MESSAGE_TYPES.THINKING,
        });
      }

      // Scratchpad is always extracted from final response, not streamed
      const scratchpad = await extractScratchpad(newResponse, 'scratchpad');
      if (scratchpad) {
        logger.info(scratchpad, {
          groupId,
          messageType: MESSAGE_TYPES.SCRATCHPAD,
        });
      }

      // Normalize usage once - this is the single source of truth
      const normalizedUsage = modelHandler.normalizeUsage(
        responseUsage,
        prepRes.responseTimeMs ?? 0,
      );

      const repetitionResult = checkForMassiveRepetition(
        prepRes.lastResponse,
        newResponse,
      );

      if (repetitionResult.massiveRepetitionDetected && newResponse) {
        logger.error(
          `The new response is (first ${REPETITION_DETECTION_THRESHOLD} chars): ${newResponse.substring(0, REPETITION_DETECTION_THRESHOLD)}`,
        );
        logger.error('Massive repetition detected - skipping this response');
        logger.error('Message structure when repetition detected:');
        logger.error(
          JSON.stringify(messageToSkeleton(prepRes.messages), null, 2),
        );
      }

      let processedResponse: string | undefined;
      let bestConnector: string | undefined;
      let updatedLastResponse: string | undefined;
      let updatedAccumulatedOutput: string | undefined;

      if (newResponse) {
        processedResponse = replacementEngine.applyAll(newResponse);

        if (!repetitionResult.massiveRepetitionDetected) {
          const connector = await bestConnectionMethod(
            prepRes.lastResponse.slice(-K_SLICE),
            processedResponse.slice(0, K_SLICE),
          );
          bestConnector = connector.connector;
          // Compute new values but don't update store (that's a side effect for post())
          updatedLastResponse = processedResponse;
          updatedAccumulatedOutput =
            prepRes.accumulatedOutput +
            (bestConnector ?? '') +
            processedResponse;
        }
      }

      return {
        kind: 'success',
        value: {
          stopReason,
          newResponse,
          processedResponse,
          bestConnector,
          thinkingContent,
          useStreaming,
          responseUsage,
          normalizedUsage,
          repetitionDetected: repetitionResult.massiveRepetitionDetected,
          // Pass data for post() to apply side effects
          responseTimeMs: prepRes.responseTimeMs,
          updatedLastResponse,
          updatedAccumulatedOutput,
        },
      };
    });
  }

  async post(
    shared: ResponseCycleShared,
    prepRes: ProcessPrepResult,
    execRes: ProcessNodeResult,
  ): Promise<string | undefined> {
    const { round, workspace, logger, modelHandler } = this.services;

    if (execRes.kind === 'skipped') {
      shared.endTurn = false;
      return FlowTransition.COMPLETE;
    }

    const result = execRes.value;

    // Apply side effects that were computed in exec()
    // These updates are now in post() where they belong (PocketFlow compliance)
    if (result.responseTimeMs !== undefined) {
      round.addResponseTime(result.responseTimeMs);
    }

    if (result.normalizedUsage) {
      round.setNormalizedUsage(result.normalizedUsage);
    }

    if (result.updatedLastResponse !== undefined) {
      workspace.assembly.lastResponse = result.updatedLastResponse;
    }

    if (result.updatedAccumulatedOutput !== undefined) {
      workspace.assembly.accumulatedOutput = result.updatedAccumulatedOutput;
    }

    shared.stopReason = result.stopReason;
    shared.processedResponse = result.processedResponse;

    if (result.repetitionDetected) {
      shared.endTurn = false;
      shared.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    const processedResponse = result.processedResponse;

    if (!processedResponse) {
      shared.endTurn = false;
      shared.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    const outputLocation = prepRes.outputLocation;

    await AbsoluteFS.ensureDir(path.dirname(outputLocation.absolutePath));

    if (!prepRes.outputExists) {
      logger.debug(`Creating new file: ${outputLocation.absolutePath}`);
      await AbsoluteFS.write(outputLocation.absolutePath, processedResponse);
      shared.outputExists = true;
    } else {
      logger.debug(
        `Appending to existing file: ${outputLocation.absolutePath}`,
      );
      await flexibleFS.appendFile(
        outputLocation,
        (result.bestConnector ?? '') + processedResponse,
      );
    }

    const responseUsage = result.responseUsage ?? {};
    const usageSummary = Object.entries(responseUsage)
      .map(([key, value]) => `${key}: ${value}`)
      .join(', ');
    logger.debug(`Usage summary: ${usageSummary}`);

    logger.info(`Stop reason: ${result.stopReason}`, {
      messageType: MESSAGE_TYPES.PROGRESS_STATUS,
    });

    logger.debug(`Normalized usage: ${JSON.stringify(result.normalizedUsage)}`);

    logger.debug('Response preview:');
    logger.debug(
      `First ${K_SLICE} chars:\n${processedResponse.slice(0, K_SLICE)}`,
    );
    logger.debug(
      `Last ${K_SLICE} chars:\n${processedResponse.slice(-K_SLICE)}`,
    );

    const connector = result.bestConnector ?? '';

    if (modelHandler.capabilities.supportsAssistantPrefill) {
      modelHandler.updateMessageContentWithPrefill(
        shared.messages,
        connector,
        processedResponse,
        workspace,
      );
    } else {
      modelHandler.updateMessageContentWithoutPrefill(
        shared.messages,
        connector,
        processedResponse,
        workspace,
      );
    }

    if (result.useStreaming) {
      logger.debug(
        'Using streaming - deferring continuation decision to next stage',
      );
    }

    return FlowTransition.DEFAULT;
  }
}

/**
 * Finalizes the response cycle by recording round statistics.
 * All flow exit paths route through this node to ensure proper cleanup.
 *
 * PocketFlow pattern:
 * - Single finalization point in the flow graph
 * - No guard flags needed (graph ensures single execution)
 * - Services accessed via `this.services`
 *
 * PocketFlow compliance:
 * - prep(): Extracts data for exec() (none needed for finalization)
 * - exec(): Pure computation using prepRes (finalization is side-effect-free)
 * - post(): Applies side effects and returns action
 */
class ResponseCycleFinalizeNode<C> extends BaseNode<
  ResponseCycleShared,
  ResponseCycleParams<C>,
  ResponseCycleServices<C>
> {
  /**
   * No preparation needed - this node just finalizes.
   * PocketFlow compliance: prep() extracts data for exec().
   */
  async prep(_shared: ResponseCycleShared): Promise<void> {
    // No prep needed for finalize
  }

  /**
   * Finalize the round using the shared helper.
   *
   * This is the SINGLE finalization point for ResponseCycleFlow.
   * The parent ResponseCycleNode must pass onRoundFinalized
   * to services for this to work correctly.
   *
   * PocketFlow compliance: exec() receives prepRes, returns compute result.
   */
  async exec(_prepRes: void): Promise<void> {
    // Use shared helper for consistent finalization (single source of truth)
    await finalizeRound(this.services);
  }

  /**
   * Flow ends here.
   * PocketFlow compliance: post() applies side effects and returns action.
   */
  async post(
    _shared: ResponseCycleShared,
    _prepRes: void,
    _execRes: void,
  ): Promise<string | undefined> {
    // Flow ends here
    return undefined;
  }
}

/**
 * Evaluates the processed response to decide whether the agent should end the turn,
 * stop entirely, or enqueue a continuation request.
 *
 * PocketFlow compliance:
 * - prep() extracts only the data needed by exec()
 * - exec() performs pure computation using prepRes
 * - post() applies all side effects
 *
 * Services accessed via `_params.services`: options, store
 */
class ResponseContinuationNode<C> extends BaseNode<
  ResponseCycleShared,
  ResponseCycleParams<C>,
  ResponseCycleServices<C>
> {
  /**
   * Extract data and check interruption.
   * PocketFlow compliance: I/O (checkInterruption) happens in prep().
   */
  async prep(shared: ResponseCycleShared): Promise<ContinuationPrepResult> {
    const { checkInterruption } = this.services;

    // Check skip conditions in prep
    const shouldSkip =
      shared.shouldStop || !shared.stopReason || !shared.processedResponse;

    // Check interruption only if not already skipping (avoid unnecessary I/O)
    const interrupted = shouldSkip ? false : Boolean(await checkInterruption());

    return {
      shouldSkip,
      interrupted,
      stopReason: shared.stopReason,
      processedResponse: shared.processedResponse,
      messages: shared.messages,
    };
  }

  /**
   * Evaluate continuation conditions.
   * PocketFlow compliance: Pure computation, no side effects.
   */
  async exec(prepRes: ContinuationPrepResult): Promise<ContinuationNodeResult> {
    const { round, run, modelHandler, agentSetting } = this.services;

    if (prepRes.shouldSkip) {
      return { kind: 'skipped' };
    }

    if (prepRes.interrupted) {
      return {
        kind: 'success',
        value: {
          shouldEndTurn: false,
          shouldStop: true,
          shouldContinue: false,
        },
      };
    }

    const stopReason = prepRes.stopReason!;
    const processedResponse = prepRes.processedResponse!;

    const { endTurn: shouldEndTurn, shouldStop } =
      modelHandler.checkStopConditions(
        stopReason,
        processedResponse,
        round,
        run,
        agentSetting,
      );

    const shouldContinue = modelHandler.shouldContinue(
      stopReason,
      processedResponse,
      agentSetting,
    );

    return {
      kind: 'success',
      value: { shouldEndTurn, shouldStop, shouldContinue },
    };
  }

  async post(
    shared: ResponseCycleShared,
    prepRes: ContinuationPrepResult,
    execRes: ContinuationNodeResult,
  ): Promise<string | undefined> {
    const {
      round,
      workspace,
      logger,
      modelHandler,
      agentSetting,
      agentConfig,
    } = this.services;

    if (execRes.kind === 'skipped') {
      shared.endTurn = false;
      shared.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    const { shouldEndTurn, shouldStop, shouldContinue } = execRes.value;

    shared.endTurn = shouldEndTurn;
    shared.shouldStop = shouldStop;

    if (shouldStop) {
      return FlowTransition.COMPLETE;
    }

    const reachedTokenLimit = isTokenLimitStopReason(prepRes.stopReason);
    const willContinue = shouldContinue || reachedTokenLimit;

    if (!willContinue) {
      return FlowTransition.COMPLETE;
    }

    round.incrementContinuation();
    logger.info(`Starting continuation #${round.continuationCount}`, {
      messageType: MESSAGE_TYPES.PROGRESS_STATUS,
    });

    if (reachedTokenLimit) {
      logger.info('Continuing after hitting the model token limit', {
        messageType: MESSAGE_TYPES.PROGRESS_STATUS,
      });
    }

    logger.info('🧵 Added continuation prompt from partial XML output', {
      messageType: MESSAGE_TYPES.PROGRESS_STATUS,
    });

    if (modelHandler.capabilities.supportsAssistantPrefill) {
      modelHandler.addContinueMessageWithPrefill(
        shared.messages,
        round,
        workspace,
        agentSetting,
        agentConfig,
      );
    } else {
      modelHandler.addContinueMessageWithoutPrefill(
        shared.messages,
        round,
        workspace,
        agentSetting,
        agentConfig,
      );
    }

    return FlowTransition.CONTINUE;
  }
}

/**
 * Creates a response cycle flow with services injected directly.
 *
 * The returned flow uses the services pattern:
 * - Services are passed via `setServices()` (options flattened)
 * - Only mutable state flows through the shared context
 *
 * @example
 * ```typescript
 * const flow = createResponseCycleFlow<MyContext>();
 * flow.setServices({ ...options, store });
 * await flow.run(sharedState);
 * ```
 */
export function createResponseCycleFlow<C>(): Flow<
  ResponseCycleShared,
  ResponseCycleParams<C>
> {
  const prepNode = new ResponsePrepNode<C>();
  const invokeNode = new ResponseModelInvocationNode<C>();
  const processNode = new ResponseProcessNode<C>();
  const continuationNode = new ResponseContinuationNode<C>();
  const finalizeNode = new ResponseCycleFinalizeNode<C>();

  // Main flow: prep → invoke → process → continuation
  // Note: Retry (both auto and manual) is handled internally by PocketFlow Node
  // via maxRetries, wait, and retryPrompt. No separate RetryWaitNode needed.
  prepNode.next(invokeNode);
  invokeNode.next(processNode);
  processNode.next(continuationNode);

  // All completion paths route through finalize node (PocketFlow-native pattern)
  prepNode.on(FlowTransition.COMPLETE, finalizeNode);
  invokeNode.on(FlowTransition.COMPLETE, finalizeNode);
  processNode.on(FlowTransition.COMPLETE, finalizeNode);
  continuationNode.on(FlowTransition.COMPLETE, finalizeNode);

  // Continuation can loop back to prep
  continuationNode.on(FlowTransition.CONTINUE, prepNode);

  return new Flow<ResponseCycleShared, ResponseCycleParams<C>>(prepNode);
}
