import { dirname } from 'path';

import { z } from 'zod';

import { BaseNode, Flow } from '@agent/node';
import { recordRound } from '@agent/core/AgentState';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import {
  BaseCycleFieldsSchema,
  defaultPostCompactionContext,
  extractModelResponse,
  resetCycleState,
  saveCycleDebug,
  SkippableNodeResult,
} from '@agent/core/flows/CommonCycleTypes';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { ProviderStopReason } from '@agent/modelHandlers/types/StopReasonTypes';
import type { ProviderUsage } from '@agent/core/ResponseUsage';

import { messageToSkeleton } from '@agent/utils/messageSkeletonUtils';
import { checkForMassiveRepetition } from '@agent/utils/text/repetitionUtils';

import { isTokenLimitStopReason } from '@agent/modelHandlers/utils/stopReasonUtils';
import { K_SLICE, REPETITION_DETECTION_THRESHOLD } from '@agent/core/constants';
import { bestConnectionMethod } from '@latex';
import replacementEngine from '@replacement/engine';
import { MESSAGE_TYPES, AgentFileLocationSchema } from '@shared/schemas';
import { AbsoluteFS, flexibleFS } from '@utils/files';
import { getSystemPromptWithRules } from '@utils/prompt';
import { extractScratchpad } from '@utils/text/xmlUtils';

import { FlowTransition } from './FlowTransitions';
import { ModelInvocationNode } from './ModelInvocationNode';
import type { CycleParams, ResponseCycleServices } from './CycleServices';

// ============================================================================
// Cycle Fields Schema (Extends Base)
// ============================================================================

/**
 * Schema for serializable response cycle fields.
 *
 * Extends BaseCycleFieldsSchema with response-specific fields for output tracking.
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
 * This is what cycle nodes operate on. ResponseCycleNode creates a
 * dedicated instance for each cycle, keeping cycle fields off the
 * outer ReflectionFlowShared.
 */
export type ResponseCycleShared = CycleFields & CycleTransientFields;

/** Prep result for ResponsePrepNode - captures interruption status and initial state. */
interface ResponsePrepResult {
  interrupted: boolean;
  exists: boolean;
  systemPrompt?: string;
}

/**
 * Prepares a response cycle by hydrating prompts, checking interruptions, and
 * establishing debug metadata before invoking the model.
 */
class ResponsePrepNode<C> extends BaseNode<
  ResponseCycleShared,
  CycleParams,
  ResponseCycleServices<C>
> {
  async prep(shared: ResponseCycleShared): Promise<ResponsePrepResult> {
    const { prompt, userVarChannels, checkInterruption } = this.services;
    const interrupted = checkInterruption();
    const exists = await flexibleFS.exists(shared.outputLocation!);
    const systemPrompt = interrupted
      ? undefined
      : await getSystemPromptWithRules(prompt.systemPrompt, {
          ...userVarChannels.input,
          ...userVarChannels.transient,
        });

    return { interrupted, exists, systemPrompt };
  }

  async post(
    shared: ResponseCycleShared,
    prepRes: ResponsePrepResult,
  ): Promise<string | undefined> {
    if (prepRes.interrupted) {
      resetCycleState(shared, ['responseObject', 'processedResponse']);
      shared.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    const { round } = this.services;
    shared.outputExists = prepRes.exists;
    shared.systemPrompt = prepRes.systemPrompt;
    resetCycleState(shared, ['responseObject', 'processedResponse']);

    await saveCycleDebug(shared.messages, 'messages', this.services, {
      continuationCount: round.continuationCount,
      baseName: 'response',
      outputFile: shared.outputLocation!.relativePath,
    });

    return FlowTransition.DEFAULT;
  }
}

/**
 * Data extracted by prep() for response processing.
 * Note: outputLocation and outputExists are accessed directly from shared
 * in post() since they're only needed there.
 */
interface ProcessPrepResult {
  shouldStop: boolean;
  responseObject: unknown;
  responseTimeMs?: number;
  messages: ProviderMessage[];
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
  responseUsage: ProviderUsage;
  normalizedUsage?: NormalizedUsage;
  repetitionDetected: boolean;
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
  CycleParams,
  ResponseCycleServices<C>
> {
  async prep(shared: ResponseCycleShared): Promise<ProcessPrepResult> {
    const { assembly } = this.services.workspace;
    return {
      shouldStop: shared.shouldStop,
      responseObject: shared.responseObject,
      responseTimeMs: shared.responseTimeMs,
      messages: shared.messages,
      lastResponse: assembly.lastResponse,
      accumulatedOutput: assembly.accumulatedOutput,
    };
  }

  async exec(prepRes: ProcessPrepResult): Promise<ProcessNodeResult> {
    const { logger } = this.services;

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
        thinking: thinkingContent,
        useStreaming,
        normalizedUsage,
      } = extractModelResponse(
        prepRes.responseObject,
        prepRes.responseTimeMs,
        this.services.setting.endTag,
        this.services,
      );

      if (newResponse) {
        logger.debug(`Model response: ${newResponse.slice(0, 100)}`);
      }
      if (prepRes.responseTimeMs != null) {
        logger.debug(
          `Response time: ${(prepRes.responseTimeMs / 1000).toFixed(2)}s`,
        );
      }
      logger.debug(`Stop reason: ${stopReason}`);
      logger.debug(`Token usage: ${JSON.stringify(responseUsage)}`);

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

    if (shared.responseTimeMs != null) {
      round.responseTimeMs += shared.responseTimeMs;
    }

    if (result.normalizedUsage) {
      round.normalizedUsage = result.normalizedUsage;
    }

    if (result.updatedLastResponse != null) {
      workspace.assembly.lastResponse = result.updatedLastResponse;
    }

    if (result.updatedAccumulatedOutput != null) {
      workspace.assembly.accumulatedOutput = result.updatedAccumulatedOutput;
    }

    shared.stopReason = result.stopReason;
    shared.processedResponse = result.processedResponse;

    if (result.repetitionDetected || !result.processedResponse) {
      shared.endTurn = false;
      shared.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    const outputLocation = shared.outputLocation!;
    const connector = result.bestConnector ?? '';

    await AbsoluteFS.ensureDir(dirname(outputLocation.absolutePath));

    if (!shared.outputExists) {
      logger.debug(`Creating new file: ${outputLocation.absolutePath}`);
      await AbsoluteFS.write(
        outputLocation.absolutePath,
        result.processedResponse,
      );
      shared.outputExists = true;
    } else {
      logger.debug(
        `Appending to existing file: ${outputLocation.absolutePath}`,
      );
      await flexibleFS.appendFile(
        outputLocation,
        connector + result.processedResponse,
      );
    }

    const responseUsage = result.responseUsage ?? {};
    const usageSummary = Object.entries(responseUsage)
      .map(([key, value]) => `${key}: ${value}`)
      .join(', ');
    logger.debug(`Usage summary: ${usageSummary}`);

    logger.debug(`Normalized usage: ${JSON.stringify(result.normalizedUsage)}`);

    logger.debug('Response preview:');
    logger.debug(
      `First ${K_SLICE} chars:\n${result.processedResponse.slice(0, K_SLICE)}`,
    );
    logger.debug(
      `Last ${K_SLICE} chars:\n${result.processedResponse.slice(-K_SLICE)}`,
    );

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
 * PocketFlow pattern: Single finalization point in the flow graph.
 * No guard flags needed (graph ensures single execution).
 */
class ResponseCycleFinalizeNode<C> extends BaseNode<
  ResponseCycleShared,
  CycleParams,
  ResponseCycleServices<C>
> {
  /** Finalize the round by recording stats and invoking callback. */
  async exec(): Promise<void> {
    const { round, run, onRoundFinalized } = this.services;
    recordRound(run, round);
    await onRoundFinalized?.(run);
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
  CycleParams,
  ResponseCycleServices<C>
> {
  async prep(shared: ResponseCycleShared): Promise<ContinuationPrepResult> {
    const shouldSkip =
      shared.shouldStop || !shared.stopReason || !shared.processedResponse;

    const interrupted =
      !shouldSkip && Boolean(await this.services.checkInterruption());

    return {
      shouldSkip,
      interrupted,
      stopReason: shared.stopReason ?? undefined,
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

    const reachedTokenLimit = isTokenLimitStopReason(prepRes.stopReason);
    if (shouldStop || !(shouldContinue || reachedTokenLimit)) {
      return FlowTransition.COMPLETE;
    }

    round.continuationCount += 1;
    logger.info(`Starting continuation #${round.continuationCount}`, {
      messageType: MESSAGE_TYPES.PROGRESS_STATUS,
    });

    if (reachedTokenLimit) {
      logger.info('Continuing after hitting the model token limit', {
        messageType: MESSAGE_TYPES.PROGRESS_STATUS,
      });
    }

    if (modelHandler.capabilities.supportsAssistantPrefill) {
      modelHandler.addContinueMessageWithPrefill(
        shared.messages,
        workspace,
        setting,
      );
    } else {
      modelHandler.addContinueMessageWithoutPrefill(
        shared.messages,
        workspace,
        setting,
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
  CycleParams
> {
  const prepNode = new ResponsePrepNode<C>();
  const invokeNode = new ModelInvocationNode<
    ResponseCycleShared,
    CycleParams,
    ResponseCycleServices<C>
  >({
    operationName: 'Model invocation',
    streaming: false,
    backgroundModeAware: true,
    getSystemPrompt: (shared) => shared.systemPrompt,
    getEndTag: (services) => services.setting.endTag,
    getTools: (services) =>
      services.modelHandler.capabilities.supportsFunctionCalling
        ? services.setting.tools
        : undefined,
    storeResponse: (shared, response) => {
      shared.responseObject = response;
    },
    getPostCompactionContext: defaultPostCompactionContext,
    getDebugFileOptions: (shared, services) => ({
      continuationCount: services.round.continuationCount,
      baseName: 'response',
      outputFile: shared.outputLocation!.relativePath,
    }),
  });
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

  return new Flow<ResponseCycleShared, CycleParams>(prepNode);
}
