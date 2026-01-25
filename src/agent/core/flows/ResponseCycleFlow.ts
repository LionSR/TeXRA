import { dirname } from 'path';

import { z } from 'zod';

import { RetryErrorInfoSchema, type RetryErrorInfo } from '@shared/schemas';
import { MESSAGE_TYPES } from '@shared/schemas';
import {
  AgentFileLocationSchema,
  type AgentFileLocation,
} from '@shared/schemas';
import { isRemoteAgent } from '@agent/index';
import { BaseNode, Flow } from '@agent/node';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import {
  BaseCycleFieldsSchema,
  BaseInvocationPrepResult,
  BaseInvocationSuccessData,
  getDebugContext,
  resetCycleState,
  SkippableNodeResult,
} from '@agent/core/flows/CommonCycleTypes';
import { type ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { ProviderStopReason } from '@agent/modelHandlers/types/StopReasonTypes';

import { maybeSaveDebugObject } from '@agent/utils/debugMessageSaver';
import { messageToSkeleton } from '@agent/utils/messageSkeletonUtils';
import { checkForMassiveRepetition } from '@agent/utils/text/repetitionUtils';

import { isTokenLimitStopReason } from '@agent/modelHandlers/utils/stopReasonUtils';
import replacementEngine from '@replacement/engine';
import { AbsoluteFS, flexibleFS } from '@utils/files';
import { K_SLICE, REPETITION_DETECTION_THRESHOLD } from '@utils/config';
import { getSystemPromptWithRules } from '@utils/prompt';
import { extractScratchpad } from '@utils/text/xmlUtils';
import { bestConnectionMethod } from '@latex';

import { FlowTransition } from './FlowTransitions';
import {
  type InvocationResult,
  RetryableInvocationNode,
  handleInvocationResult,
} from './RetryState';
import {
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
  const obj = shared as Record<string, unknown>;
  const requiredFields = ['messages', 'shouldStop', 'endTurn', 'outputExists'];

  for (const field of requiredFields) {
    if (obj[field] === undefined) {
      throw new Error(
        `Cycle field '${field}' must be populated before running cycle flow`,
      );
    }
  }

  if (obj['outputLocation'] == null) {
    throw new Error(
      `Cycle field 'outputLocation' must be set to a valid location before running cycle flow`,
    );
  }
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
    const { prompt, userVarChannels, checkInterruption } = this.services;
    const interrupted = checkInterruption();
    const outputLocation = shared.outputLocation!;
    const exists = await flexibleFS.exists(outputLocation);
    const userVars = { ...userVarChannels.input, ...userVarChannels.transient };
    const systemPrompt = interrupted
      ? undefined
      : await getSystemPromptWithRules(prompt.systemPrompt, userVars);

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
      resetCycleState(shared, ['responseObject', 'processedResponse']);
      shared.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    const { config, round } = this.services;
    shared.outputExists = prepRes.exists;
    shared.systemPrompt = prepRes.systemPrompt;
    shared.outputLocation = prepRes.outputLocation;
    resetCycleState(shared, ['responseObject', 'processedResponse']);

    await maybeSaveDebugObject({
      object: shared.messages,
      objectType: 'messages',
      context: getDebugContext(this.services, {
        modelName: config.model,
        isRemote: isRemoteAgent(config.agent),
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

  async exec(
    prepRes: InvocationPrepResult,
  ): Promise<InvocationResult<BaseInvocationSuccessData>> {
    const services = this.services;

    if (prepRes.shouldStop) {
      return { kind: 'skipped' };
    }

    services.modelHandler.setOutputStreaming(false);

    const stage = await services.logger.stage('Model invocation', {
      skip: true,
    });

    const start = Date.now();

    return this.withAbortController(async (signal) => {
      const { response, responseTimeMs } = await stage.run(async () => {
        const modelResponse = await services.modelHandler.createResponse({
          client: services.client,
          messages: prepRes.messages,
          temperature: services.setting.temperature || 0.0,
          systemPrompt: prepRes.systemPrompt,
          endTag: services.setting.endTag,
          signal,
          tools: services.modelHandler.capabilities.supportsFunctionCalling
            ? services.setting.tools
            : undefined,
        });

        const elapsedMs = Date.now() - start;

        return { response: modelResponse, responseTimeMs: elapsedMs };
      });

      return { kind: 'success', response, responseTimeMs };
    });
  }

  /**
   * Called by PocketFlow Node when retryPrompt returns false.
   * Uses base class getFallbackResult() for shared logic.
   */
  async execFallback(
    _prepRes: InvocationPrepResult,
    error: Error,
  ): Promise<InvocationResult<BaseInvocationSuccessData>> {
    return this.getFallbackResult(error);
  }

  async post(
    shared: ResponseCycleShared,
    _prepRes: InvocationPrepResult,
    execRes: InvocationResult<BaseInvocationSuccessData>,
  ): Promise<string | undefined> {
    const { logger, config, round } = this.services;

    const successRes = handleInvocationResult(execRes, shared, shared, {
      logger,
      operationName: this.getOperationName(),
    });

    if (!successRes) {
      return FlowTransition.COMPLETE;
    }

    shared.responseObject = successRes.response;
    shared.responseTimeMs = successRes.responseTimeMs;

    await maybeSaveDebugObject({
      object: successRes.response,
      objectType: 'response',
      context: getDebugContext(this.services, {
        modelName: config.model,
        isRemote: isRemoteAgent(config.agent),
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
 */
interface ProcessPrepResult {
  shouldStop: boolean;
  responseObject: unknown;
  responseTimeMs?: number;
  messages: ProviderMessage[];
  outputLocation: AgentFileLocation;
  outputExists: boolean;
  lastResponse: string;
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
  normalizedUsage: NormalizedUsage;
  repetitionDetected: boolean;
  responseTimeMs?: number;
  updatedLastResponse?: string;
  updatedAccumulatedOutput?: string;
}

type ProcessNodeResult = SkippableNodeResult<ProcessResult>;

/**
 * Data extracted by prep() for continuation decision.
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
      outputLocation: shared.outputLocation!,
      outputExists: shared.outputExists,
      lastResponse: workspace.assembly.lastResponse,
      accumulatedOutput: workspace.assembly.accumulatedOutput,
    };
  }

  async exec(prepRes: ProcessPrepResult): Promise<ProcessNodeResult> {
    const { workspace, logger, modelHandler, setting } = this.services;

    if (prepRes.shouldStop || !prepRes.responseObject) {
      return { kind: 'skipped' };
    }

    const stage = await logger.stage('Process response', {
      skip: true,
    });

    return stage.run(async () => {
      const {
        text: newResponse,
        usage: responseUsage,
        stopReason,
      } = modelHandler.extractResponse(prepRes.responseObject, setting.endTag);

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

      if (thinkingContent && !useStreaming) {
        logger.info(thinkingContent, {
          messageType: MESSAGE_TYPES.THINKING,
        });
      }

      const scratchpad = await extractScratchpad(newResponse, 'scratchpad');
      if (scratchpad) {
        logger.info(scratchpad, {
          messageType: MESSAGE_TYPES.SCRATCHPAD,
        });
      }

      const normalizedUsage = modelHandler.normalizeUsage(
        responseUsage,
        prepRes.responseTimeMs ?? 0,
      );

      const { inputTokens } = normalizedUsage;
      const { contextWindow } = modelHandler.config;
      if (inputTokens > 0 && contextWindow > 0) {
        logger.logContextState(inputTokens, contextWindow);
      }

      const repetitionResult = checkForMassiveRepetition(
        prepRes.lastResponse,
        newResponse,
      );

      if (repetitionResult.massiveRepetitionDetected && newResponse) {
        const preview = newResponse.substring(
          0,
          REPETITION_DETECTION_THRESHOLD,
        );
        const skeleton = JSON.stringify(
          messageToSkeleton(prepRes.messages),
          null,
          2,
        );
        logger.error(
          `Massive repetition detected - skipping this response\n` +
            `First ${REPETITION_DETECTION_THRESHOLD} chars: ${preview}\n` +
            `Message structure:\n${skeleton}`,
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

    if (!result.processedResponse) {
      shared.endTurn = false;
      shared.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    await AbsoluteFS.ensureDir(dirname(prepRes.outputLocation.absolutePath));

    if (!prepRes.outputExists) {
      logger.debug(`Creating new file: ${prepRes.outputLocation.absolutePath}`);
      await AbsoluteFS.write(
        prepRes.outputLocation.absolutePath,
        result.processedResponse,
      );
      shared.outputExists = true;
    } else {
      logger.debug(
        `Appending to existing file: ${prepRes.outputLocation.absolutePath}`,
      );
      await flexibleFS.appendFile(
        prepRes.outputLocation,
        (result.bestConnector ?? '') + result.processedResponse,
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
      `First ${K_SLICE} chars:\n${result.processedResponse.slice(0, K_SLICE)}`,
    );
    logger.debug(
      `Last ${K_SLICE} chars:\n${result.processedResponse.slice(-K_SLICE)}`,
    );

    const connector = result.bestConnector ?? '';

    if (modelHandler.capabilities.supportsAssistantPrefill) {
      modelHandler.updateMessageContentWithPrefill(
        shared.messages,
        connector,
        result.processedResponse,
        workspace,
      );
    } else {
      modelHandler.updateMessageContentWithoutPrefill(
        shared.messages,
        connector,
        result.processedResponse,
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
 */
class ResponseCycleFinalizeNode<C> extends BaseNode<
  ResponseCycleShared,
  ResponseCycleParams<C>,
  ResponseCycleServices<C>
> {
  async prep(_shared: ResponseCycleShared): Promise<void> {}

  /**
   * Finalize the round by recording stats and invoking callback.
   * This is the single finalization point for ResponseCycleFlow.
   */
  async exec(_prepRes: void): Promise<void> {
    const { round, run, onRoundFinalized } = this.services;
    run.recordRound(round);
    if (onRoundFinalized) {
      await onRoundFinalized(run);
    }
  }

  async post(
    _shared: ResponseCycleShared,
    _prepRes: void,
    _execRes: void,
  ): Promise<string | undefined> {
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
 */
class ResponseContinuationNode<C> extends BaseNode<
  ResponseCycleShared,
  ResponseCycleParams<C>,
  ResponseCycleServices<C>
> {
  async prep(shared: ResponseCycleShared): Promise<ContinuationPrepResult> {
    const { checkInterruption } = this.services;

    const shouldSkip =
      shared.shouldStop || !shared.stopReason || !shared.processedResponse;

    const interrupted = !shouldSkip && Boolean(await checkInterruption());

    return {
      shouldSkip,
      interrupted,
      stopReason: shared.stopReason,
      processedResponse: shared.processedResponse,
      messages: shared.messages,
    };
  }

  async exec(prepRes: ContinuationPrepResult): Promise<ContinuationNodeResult> {
    const { round, run, modelHandler, setting } = this.services;

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
        setting,
      );

    const shouldContinue = modelHandler.shouldContinue(
      stopReason,
      processedResponse,
      setting,
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
    const { round, workspace, logger, modelHandler, setting, config } =
      this.services;

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
        setting,
        config,
      );
    } else {
      modelHandler.addContinueMessageWithoutPrefill(
        shared.messages,
        round,
        workspace,
        setting,
        config,
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

  prepNode.next(invokeNode);
  invokeNode.next(processNode);
  processNode.next(continuationNode);

  prepNode.on(FlowTransition.COMPLETE, finalizeNode);
  invokeNode.on(FlowTransition.COMPLETE, finalizeNode);
  processNode.on(FlowTransition.COMPLETE, finalizeNode);
  continuationNode.on(FlowTransition.COMPLETE, finalizeNode);

  continuationNode.on(FlowTransition.CONTINUE, prepNode);

  return new Flow<ResponseCycleShared, ResponseCycleParams<C>>(prepNode);
}
