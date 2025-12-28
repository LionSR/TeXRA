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
  CycleDebugContext,
  CycleDebugFileOptions,
  SkippableNodeResult,
  createDebugContext,
  createDebugFileOptions,
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
import xmlUtils from '@utils/text/xmlUtils';
import { bestConnectionMethod } from '@latex';

// Local file imports
import { FlowTransition } from './FlowTransitions';
import {
  type InvocationResult,
  RetryableInvocationNode,
  handleInvocationResult,
} from './RetryState';
import type {
  ResponseCycleParams,
  ResponseCycleServices,
} from './CycleServices';

/** Input state for response cycles. */
interface ResponseCycleInputState {
  /** Agent output location - always workspace or runStorage (never external) */
  outputLocation: AgentFileLocation;
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
  debugContext?: CycleDebugContext;
  debugFileOptions?: CycleDebugFileOptions;
  startTime?: number;
  responseObject?: unknown;
  processedResponse?: string;
  /** Agent output location - always workspace or runStorage (never external) */
  outputLocation?: AgentFileLocation;
  roundFinalized: boolean;
}

export type ResponseCycleState = ResponseCycleInputState &
  ResponseCycleRuntimeState;

function resetResponseCycleState(cycle: ResponseCycleRuntimeState): void {
  resetCycleState(cycle, ['responseObject', 'processedResponse']);
  // Boolean fields set directly to avoid undefined intermediate state
  cycle.endTurn = false;
  cycle.roundFinalized = false;
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
 * Services accessed via `_params.services`: options, store
 */
class ResponsePrepNode<C> extends BaseNode<
  ResponseCycleShared,
  ResponseCycleParams<C>
> {
  async prep(shared: ResponseCycleShared): Promise<{
    interrupted: boolean;
    exists: boolean;
    systemPrompt?: string;
    debugContext?: CycleDebugContext;
    debugFileOptions?: CycleDebugFileOptions;
    outputLocation: AgentFileLocation;
  }> {
    const { options, store } = this._params.services;
    const { state } = shared;
    const { agentPrompt, userVars, logger, agentConfig } = options;
    const interrupted = Boolean(await options.checkInterruption());
    const outputLocation = state.outputLocation;
    const exists = await flexibleFS.exists(outputLocation);
    const systemPrompt = interrupted
      ? undefined
      : await getSystemPromptWithRules(agentPrompt.systemPrompt, userVars);

    const debugContext: CycleDebugContext | undefined = interrupted
      ? undefined
      : createDebugContext({
          logger,
          modelName: agentConfig.model,
          executionId: options.context.executionId,
          isRemote: isRemoteAgent(agentConfig.agent),
        });

    const debugFileOptions: CycleDebugFileOptions | undefined = interrupted
      ? undefined
      : createDebugFileOptions(
          store.round.continuationCount,
          'response',
          state.outputLocation.relativePath,
        );

    return {
      interrupted,
      exists,
      systemPrompt,
      debugContext,
      debugFileOptions,
      outputLocation,
    };
  }

  async post(
    shared: ResponseCycleShared,
    prepRes: {
      interrupted: boolean;
      exists: boolean;
      systemPrompt?: string;
      debugContext?: CycleDebugContext;
      debugFileOptions?: CycleDebugFileOptions;
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
    state.debugContext = prepRes.debugContext;
    state.debugFileOptions = prepRes.debugFileOptions;
    state.outputLocation = prepRes.outputLocation;
    state.startTime = Date.now();
    resetResponseCycleState(state);

    if (state.debugContext && state.debugFileOptions) {
      await maybeSaveDebugObject({
        object: state.messages,
        objectType: 'messages',
        context: state.debugContext,
        fileOptions: state.debugFileOptions,
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
 * Services accessed via `_params.services`: options
 */
class ResponseModelInvocationNode<C> extends RetryableInvocationNode<
  ResponseCycleShared,
  ResponseCycleParams<C>
> {
  protected getOperationName(): string {
    return 'Model invocation';
  }

  protected getServices(): ResponseCycleServices<C> {
    return this._params.services;
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
    const { options } = this._params.services;

    if (prepRes.shouldStop) {
      return { kind: 'skipped' };
    }

    const abortController = new AbortController();
    // Set signal on Node so retry loop can detect user cancellation
    this.signal = abortController.signal;
    options.setAbortController(abortController);
    options.modelHandler.setOutputStreaming(false);

    const stage = await options.logger.stage('Model invocation', {
      skip: true,
    });

    const start = Date.now();
    try {
      const { response, responseTime } = await stage.run(async () => {
        const modelResponse = await options.modelHandler.createResponse({
          client: options.client,
          messages: prepRes.messages,
          temperature: options.agentSetting.temperature || 0.0,
          systemPrompt: prepRes.systemPrompt,
          endTag: options.agentSetting.endTag,
          signal: abortController.signal,
          tools: options.modelHandler.capabilities.supportsFunctionCalling
            ? options.agentSetting.tools
            : undefined,
        });

        const elapsedMs = Date.now() - start;

        return { response: modelResponse, responseTime: elapsedMs };
      });

      return { kind: 'success', response, responseTime };
    } finally {
      options.setAbortController(null);
    }
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
    const { options } = this._params.services;
    const { state, retryState } = shared;

    // Handle non-success cases (returns null) or get narrowed success result
    const successRes = handleInvocationResult(execRes, state, retryState, {
      logger: options.logger,
      operationName: this.getOperationName(),
    });

    if (!successRes) {
      return FlowTransition.COMPLETE;
    }

    // Apply success-specific side effects
    state.responseObject = successRes.response;
    state.responseTime = successRes.responseTime;

    if (state.debugContext && state.debugFileOptions) {
      await maybeSaveDebugObject({
        object: successRes.response,
        objectType: 'response',
        context: state.debugContext,
        fileOptions: state.debugFileOptions,
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
  responseTime?: number;
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
  /** Response time for store update in post() */
  responseTime?: number;
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
 * Services accessed via `_params.services`: options, store
 */
class ResponseProcessNode<C> extends BaseNode<
  ResponseCycleShared,
  ResponseCycleParams<C>
> {
  async prep(shared: ResponseCycleShared): Promise<ProcessPrepResult> {
    const { store } = this._params.services;
    const { state } = shared;
    return {
      shouldStop: state.shouldStop,
      responseObject: state.responseObject,
      responseTime: state.responseTime,
      messages: state.messages,
      outputLocation: state.outputLocation!,
      outputExists: state.outputExists,
      // Read store values before they're updated (for connector calculation)
      lastResponse: store.workspace.assembly.lastResponse,
      accumulatedOutput: store.workspace.assembly.accumulatedOutput,
    };
  }

  async exec(prepRes: ProcessPrepResult): Promise<ProcessNodeResult> {
    const { options, store } = this._params.services;

    if (prepRes.shouldStop || !prepRes.responseObject) {
      return { kind: 'skipped' };
    }

    const stage = await options.logger.stage('Process response', {
      skip: true,
    });

    return stage.run(async () => {
      const {
        response: newResponse,
        usage: responseUsage,
        stopReason,
      } = options.modelHandler.extractResponse(
        prepRes.responseObject,
        options.agentSetting.endTag,
      );

      if (newResponse) {
        options.logger.debug(`Model response: ${newResponse.slice(0, 100)}`);
      }

      if (prepRes.responseTime !== undefined) {
        options.logger.debug(
          `Response time: ${prepRes.responseTime.toFixed(2)}s`,
        );
      }

      options.logger.debug(`Stop reason: ${stopReason}`);
      options.logger.debug(`Token usage: ${JSON.stringify(responseUsage)}`);

      const thinkingContent = options.modelHandler.processThinkingBlock(
        prepRes.responseObject,
        store.workspace,
      );
      const useStreaming = options.modelHandler.getStreamingConfig();

      // For non-streaming mode, emit thinking to progress view
      // (streaming mode already shows it progressively via streams)
      if (thinkingContent && !useStreaming) {
        options.logger.info(thinkingContent, {
          messageType: MESSAGE_TYPES.THINKING,
        });
      }

      // Scratchpad is always extracted from final response, not streamed
      const scratchpad = await xmlUtils.extractScratchpad(
        newResponse,
        'scratchpad',
      );
      if (scratchpad) {
        options.logger.info(scratchpad, {
          messageType: MESSAGE_TYPES.SCRATCHPAD,
        });
      }

      // Normalize usage once - this is the single source of truth
      const normalizedUsage = options.modelHandler.normalizeUsage(
        responseUsage,
        prepRes.responseTime ?? 0,
      );

      const repetitionResult = checkForMassiveRepetition(
        prepRes.lastResponse,
        newResponse,
      );

      if (repetitionResult.massiveRepetitionDetected && newResponse) {
        options.logger.error(
          `The new response is (first ${REPETITION_DETECTION_THRESHOLD} chars): ${newResponse.substring(0, REPETITION_DETECTION_THRESHOLD)}`,
        );
        options.logger.error(
          'Massive repetition detected - skipping this response',
        );
        options.logger.error('Message structure when repetition detected:');
        options.logger.error(
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
          responseTime: prepRes.responseTime,
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
    const { options, store } = this._params.services;
    const { state } = shared;

    if (execRes.kind === 'skipped') {
      state.endTurn = false;
      if (!state.roundFinalized) {
        state.roundFinalized = true;
        await store.finalizeRound();
      }
      return FlowTransition.COMPLETE;
    }

    const result = execRes.value;

    // Apply side effects that were computed in exec()
    // These updates are now in post() where they belong (PocketFlow compliance)
    if (result.responseTime !== undefined) {
      store.round.addResponseTime(result.responseTime);
    }

    if (result.normalizedUsage) {
      store.round.setNormalizedUsage(result.normalizedUsage);
    }

    if (result.updatedLastResponse !== undefined) {
      store.workspace.assembly.updateLastResponse(result.updatedLastResponse);
    }

    if (result.updatedAccumulatedOutput !== undefined) {
      store.workspace.assembly.updateAccumulatedOutput(
        result.updatedAccumulatedOutput,
      );
    }

    state.stopReason = result.stopReason;
    state.processedResponse = result.processedResponse;

    if (result.repetitionDetected) {
      state.endTurn = false;
      state.shouldStop = true;
      if (!state.roundFinalized) {
        state.roundFinalized = true;
        await store.finalizeRound();
      }
      return FlowTransition.COMPLETE;
    }

    const processedResponse = result.processedResponse;

    if (!processedResponse) {
      state.endTurn = false;
      state.shouldStop = true;
      if (!state.roundFinalized) {
        state.roundFinalized = true;
        await store.finalizeRound();
      }
      return FlowTransition.COMPLETE;
    }

    const outputLocation = prepRes.outputLocation;

    await AbsoluteFS.ensureDir(path.dirname(outputLocation.absolutePath));

    if (!prepRes.outputExists) {
      options.logger.debug(`Creating new file: ${outputLocation.absolutePath}`);
      await AbsoluteFS.write(outputLocation.absolutePath, processedResponse);
      state.outputExists = true;
    } else {
      options.logger.debug(
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
    options.logger.debug(`Usage summary: ${usageSummary}`);

    options.logger.info(`Stop reason: ${result.stopReason}`, {
      messageType: MESSAGE_TYPES.PROGRESS_STATUS,
    });

    options.logger.debug(
      `Normalized usage: ${JSON.stringify(result.normalizedUsage)}`,
    );

    options.logger.debug('Response preview:');
    options.logger.debug(
      `First ${K_SLICE} chars:\n${processedResponse.slice(0, K_SLICE)}`,
    );
    options.logger.debug(
      `Last ${K_SLICE} chars:\n${processedResponse.slice(-K_SLICE)}`,
    );

    const connector = result.bestConnector ?? '';

    if (options.modelHandler.capabilities.supportsAssistantPrefill) {
      options.modelHandler.updateMessageContentWithPrefill(
        state.messages,
        connector,
        processedResponse,
        store.workspace,
      );
    } else {
      options.modelHandler.updateMessageContentWithoutPrefill(
        state.messages,
        connector,
        processedResponse,
        store.workspace,
      );
    }

    if (result.useStreaming) {
      options.logger.debug(
        'Using streaming - deferring continuation decision to next stage',
      );
    }

    return FlowTransition.DEFAULT;
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
  ResponseCycleParams<C>
> {
  /**
   * Extract data and check interruption.
   * PocketFlow compliance: I/O (checkInterruption) happens in prep().
   */
  async prep(shared: ResponseCycleShared): Promise<ContinuationPrepResult> {
    const { options } = this._params.services;
    const { state } = shared;

    // Check skip conditions in prep
    const shouldSkip =
      state.shouldStop || !state.stopReason || !state.processedResponse;

    // Check interruption only if not already skipping (avoid unnecessary I/O)
    const interrupted =
      !shouldSkip && Boolean(await options.checkInterruption());

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
    const { options, store } = this._params.services;

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
      options.modelHandler.checkStopConditions(
        stopReason,
        processedResponse,
        store.round,
        store.run,
        options.agentSetting,
      );

    const shouldContinue = options.modelHandler.shouldContinue(
      stopReason,
      processedResponse,
      options.agentSetting,
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
    const { options, store } = this._params.services;
    const { state } = shared;

    if (execRes.kind === 'skipped') {
      state.endTurn = false;
      state.shouldStop = true;
      if (!state.roundFinalized) {
        state.roundFinalized = true;
        await store.finalizeRound();
      }
      return FlowTransition.COMPLETE;
    }

    const { shouldEndTurn, shouldStop, shouldContinue } = execRes.value;

    state.endTurn = shouldEndTurn;
    state.shouldStop = shouldStop;

    if (shouldStop) {
      if (!state.roundFinalized) {
        state.roundFinalized = true;
        await store.finalizeRound();
      }
      return FlowTransition.COMPLETE;
    }

    const reachedTokenLimit = isTokenLimitStopReason(prepRes.stopReason);
    const willContinue = shouldContinue || reachedTokenLimit;

    if (!willContinue) {
      if (!state.roundFinalized) {
        state.roundFinalized = true;
        await store.finalizeRound();
      }
      return FlowTransition.COMPLETE;
    }

    store.round.incrementContinuation();
    options.logger.info(
      `Starting continuation #${store.round.continuationCount}`,
      { messageType: MESSAGE_TYPES.PROGRESS_STATUS },
    );

    if (reachedTokenLimit) {
      options.logger.info('Continuing after hitting the model token limit', {
        messageType: MESSAGE_TYPES.PROGRESS_STATUS,
      });
    }

    options.logger.info(
      '🧵 Added continuation prompt from partial XML output',
      { messageType: MESSAGE_TYPES.PROGRESS_STATUS },
    );

    if (options.modelHandler.capabilities.supportsAssistantPrefill) {
      options.modelHandler.addContinueMessageWithPrefill(
        state.messages,
        store.round,
        store.workspace,
        options.agentSetting,
        options.agentConfig,
      );
    } else {
      options.modelHandler.addContinueMessageWithoutPrefill(
        state.messages,
        store.round,
        store.workspace,
        options.agentSetting,
        options.agentConfig,
      );
    }

    return FlowTransition.CONTINUE;
  }
}

/**
 * Creates a response cycle flow with services injected via params.
 *
 * The returned flow uses the services pattern:
 * - Services (options, store) are passed via `setParams({ services })`
 * - Only mutable state flows through the shared context
 *
 * @example
 * ```typescript
 * const flow = createResponseCycleFlow<MyContext>();
 * flow.setParams({ services: { options, store } });
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

  // Main flow: prep → invoke → process → continuation
  // Note: Retry (both auto and manual) is handled internally by PocketFlow Node
  // via maxRetries, wait, and retryPrompt. No separate RetryWaitNode needed.
  prepNode.next(invokeNode);
  invokeNode.next(processNode);
  processNode.next(continuationNode);

  // Continuation can loop back to prep
  continuationNode.on(FlowTransition.CONTINUE, prepNode);

  return new Flow<ResponseCycleShared, ResponseCycleParams<C>>(prepNode);
}
