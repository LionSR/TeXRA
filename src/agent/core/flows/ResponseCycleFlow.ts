// Standard library imports
import * as path from 'path';

// Local imports - core flow primitives
import { isRemoteAgent } from '@agent/index';
import { BaseNode, Flow } from '@agent/node';
// Internal imports
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import {
  BaseCycleState,
  BaseCycleShared,
  BaseInvocationPrepResult,
  BaseInvocationSuccessData,
  resetCycleState,
  type CycleDebugContext,
  type CycleDebugFileOptions,
  SkippableNodeResult,
} from '@agent/core/flows/CommonCycleTypes';
// Type imports
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
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
import type { AgentFileLocation } from '@utils/files';
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

/** Input state for response cycles. */
interface ResponseCycleInputState {
  /** Agent output location - always workspace or runStorage (never external) */
  outputLocation: AgentFileLocation;
}

/**
 * Debug options for cycle - consolidated from separate context/fileOptions fields.
 * Always set/checked together, so merged into single optional field.
 */
interface CycleDebugOptions {
  context: CycleDebugContext;
  fileOptions: CycleDebugFileOptions;
}

/** Runtime state for response cycles. */
interface ResponseCycleRuntimeState extends BaseCycleState {
  /**
   * Whether the last cycle ended normally (model said end_turn).
   *
   * Lifecycle:
   * - Initialized to `false` when shared state is created
   * - Set to `true` when model's stop_reason is 'end_turn'
   * - Set to `false` on failures, cancellations, or empty responses
   *
   * Used by callers to distinguish between:
   * - Normal completion: shouldStop=true, endTurn=true
   * - User cancellation: shouldStop=true, endTurn=false, lastError=undefined
   * - Failure: shouldStop=true, endTurn=false, lastError defined
   */
  endTurn: boolean;
  outputExists: boolean;
  systemPrompt?: string;
  /** Consolidated debug options (context + fileOptions always used together) */
  debug?: CycleDebugOptions;
  responseObject?: unknown;
  processedResponse?: string;
  /** Agent output location - always workspace or runStorage (never external) */
  outputLocation?: AgentFileLocation;
}

export type ResponseCycleState = ResponseCycleInputState &
  ResponseCycleRuntimeState;

function resetResponseCycleState(cycle: ResponseCycleRuntimeState): void {
  resetCycleState(cycle, ['responseObject', 'processedResponse']);
  // Boolean fields set directly to avoid undefined intermediate state
  cycle.endTurn = false;
}

/**
 * Shared state for response cycle flows.
 * Uses BaseCycleShared with ResponseCycleState for type safety.
 *
 * ## Architecture
 * - Mutable state: `shared` (this interface)
 * - Immutable services: `_params.services` (ResponseCycleServices)
 */
export type ResponseCycleShared = BaseCycleShared<ResponseCycleState>;

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
    debug?: CycleDebugOptions;
    outputLocation: AgentFileLocation;
  }> {
    const services = this.services;
    const { agentPrompt, userVars, logger, agentConfig, round } = services;
    const { state } = shared;
    const interrupted = Boolean(await services.checkInterruption());
    const outputLocation = state.outputLocation;
    const exists = await flexibleFS.exists(outputLocation);
    const systemPrompt = interrupted
      ? undefined
      : await getSystemPromptWithRules(agentPrompt.systemPrompt, userVars);

    // Consolidated debug options (always used together)
    const debug: CycleDebugOptions | undefined = interrupted
      ? undefined
      : {
          context: {
            logger,
            modelName: agentConfig.model,
            executionId: services.context.executionId,
            isRemote: isRemoteAgent(agentConfig.agent),
          },
          fileOptions: {
            continuationCount: round.continuationCount,
            baseName: 'response',
            outputFile: state.outputLocation.relativePath,
          },
        };

    return {
      interrupted,
      exists,
      systemPrompt,
      debug,
      outputLocation,
    };
  }

  async post(
    shared: ResponseCycleShared,
    prepRes: {
      interrupted: boolean;
      exists: boolean;
      systemPrompt?: string;
      debug?: CycleDebugOptions;
      outputLocation: AgentFileLocation;
    },
  ): Promise<string | undefined> {
    const { state } = shared;

    if (prepRes.interrupted) {
      resetResponseCycleState(state);
      state.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    state.outputExists = prepRes.exists;
    state.systemPrompt = prepRes.systemPrompt;
    state.debug = prepRes.debug;
    state.outputLocation = prepRes.outputLocation;
    resetResponseCycleState(state);

    if (state.debug) {
      await maybeSaveDebugObject({
        object: state.messages,
        objectType: 'messages',
        context: state.debug.context,
        fileOptions: state.debug.fileOptions,
      });
    }

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
   * Extract data from shared for exec().
   * PocketFlow compliance: exec() should only use prepRes, not shared.
   */
  async prep(shared: ResponseCycleShared): Promise<InvocationPrepResult> {
    const { state } = shared;
    return {
      shouldStop: state.shouldStop,
      messages: state.messages,
      systemPrompt: state.systemPrompt,
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
    const { logger } = this.services;
    const { state, retryState } = shared;

    // Handle non-success cases (returns null) or get narrowed success result
    const successRes = handleInvocationResult(execRes, state, retryState, {
      logger,
      operationName: this.getOperationName(),
    });

    if (!successRes) {
      return FlowTransition.COMPLETE;
    }

    // Apply success-specific side effects
    state.responseObject = successRes.response;
    state.responseTimeMs = successRes.responseTimeMs;

    if (state.debug) {
      await maybeSaveDebugObject({
        object: successRes.response,
        objectType: 'response',
        context: state.debug.context,
        fileOptions: state.debug.fileOptions,
      });
    }

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
    const { state } = shared;
    return {
      shouldStop: state.shouldStop,
      responseObject: state.responseObject,
      responseTimeMs: state.responseTimeMs,
      messages: state.messages,
      outputLocation: state.outputLocation!,
      outputExists: state.outputExists,
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
          messageType: MESSAGE_TYPES.THINKING,
        });
      }

      // Scratchpad is always extracted from final response, not streamed
      const scratchpad = await extractScratchpad(
        newResponse,
        'scratchpad',
      );
      if (scratchpad) {
        logger.info(scratchpad, {
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
    const { state } = shared;

    if (execRes.kind === 'skipped') {
      state.endTurn = false;
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

    state.stopReason = result.stopReason;
    state.processedResponse = result.processedResponse;

    if (result.repetitionDetected) {
      state.endTurn = false;
      state.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    const processedResponse = result.processedResponse;

    if (!processedResponse) {
      state.endTurn = false;
      state.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    const outputLocation = prepRes.outputLocation;

    await AbsoluteFS.ensureDir(path.dirname(outputLocation.absolutePath));

    if (!prepRes.outputExists) {
      logger.debug(`Creating new file: ${outputLocation.absolutePath}`);
      await AbsoluteFS.write(outputLocation.absolutePath, processedResponse);
      state.outputExists = true;
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
        state.messages,
        connector,
        processedResponse,
        workspace,
      );
    } else {
      modelHandler.updateMessageContentWithoutPrefill(
        state.messages,
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
 * - Services accessed via `_params.services`
 */
class ResponseCycleFinalizeNode<C> extends BaseNode<
  ResponseCycleShared,
  ResponseCycleParams<C>,
  ResponseCycleServices<C>
> {
  /**
   * Finalize the round using the shared helper.
   *
   * This is the SINGLE finalization point for ResponseCycleFlow.
   * The parent ResponseCycleNode must pass onRoundFinalized
   * to services for this to work correctly.
   */
  async exec(): Promise<void> {
    // Use shared helper for consistent finalization (single source of truth)
    await finalizeRound(this.services);
  }

  async post(): Promise<string | undefined> {
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
    const { state } = shared;

    // Check skip conditions in prep
    const shouldSkip =
      state.shouldStop || !state.stopReason || !state.processedResponse;

    // Check interruption only if not already skipping (avoid unnecessary I/O)
    const interrupted = shouldSkip ? false : Boolean(await checkInterruption());

    return {
      shouldSkip,
      interrupted,
      stopReason: state.stopReason,
      processedResponse: state.processedResponse,
      messages: state.messages,
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
    const { state } = shared;

    if (execRes.kind === 'skipped') {
      state.endTurn = false;
      state.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    const { shouldEndTurn, shouldStop, shouldContinue } = execRes.value;

    state.endTurn = shouldEndTurn;
    state.shouldStop = shouldStop;

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
        state.messages,
        round,
        workspace,
        agentSetting,
        agentConfig,
      );
    } else {
      modelHandler.addContinueMessageWithoutPrefill(
        state.messages,
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
