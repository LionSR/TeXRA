// Standard library imports
import * as path from 'path';

// Local imports - core flow primitives
import { BaseNode, Flow } from '@agent/node';
// Internal imports
import { resolveUsageProvider } from '@agent/core/UsageProviderUtils';
import {
  BaseCycleState,
  resetCycleState,
  CycleDebugContext,
  CycleDebugFileOptions,
  SkippableNodeResult,
} from '@agent/core/flows/CommonCycleTypes';
import { RemoteAgentRegistry } from '@agent/remote/RemoteAgentRegistry';
// Type imports
import type { ProviderStopReason } from '@agent/modelHandlers/types/StopReasonTypes';

// Local imports - utilities
import { maybeSaveDebugObject } from '@agent/utils/debugMessageSaver';
// Internal imports
import { messageToSkeleton } from '@agent/utils/messageSkeletonUtils';
import { getSystemPromptWithRules } from '@agent/utils/promptHelpers';
import { checkForMassiveRepetition } from '@agent/utils/text/repetitionUtils';

// Local imports - logging
// Internal imports
import { isTokenLimitStopReason } from '@agent/modelHandlers/utils/stopReasonUtils';
import { formatProviderHttpError } from '@common/errors/sdkErrorUtils';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import replacementEngine from '@replacement/engine';
import type { AgentFileLocation } from '@utils/files';
import { K_SLICE, REPETITION_DETECTION_THRESHOLD } from '@utils/config';
import { AbsoluteFS, flexibleFS } from '@utils/files';
import xmlUtils from '@utils/text/xmlUtils';
import { bestConnectionMethod } from '@latex';

// Local file imports
import { FlowTransition } from './FlowTransitions';
import {
  type RetryState,
  type RetryCallbacks,
  clearRetryError,
  beginAttempt,
  determineRetryStrategy,
  applyRetryDecision,
} from './RetryState';
import { createRetryWaitNode } from './BaseRetryWaitNode';
import type {
  ResponseCycleOptions,
  ResponseCycleParams,
} from './CycleServices';

export interface ResponseCycleInputState {
  /** Agent output location - always workspace or runStorage (never external) */
  outputLocation: AgentFileLocation;
}

export interface ResponseCycleRuntimeState extends BaseCycleState {
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
 *
 * This contains only MUTABLE state that flows through nodes.
 * Services (options, store) are accessed via `_params.services`.
 *
 * ## Architecture
 * - Mutable state: `shared` (this interface)
 * - Immutable services: `_params.services` (ResponseCycleServices)
 */
export interface ResponseCycleShared<_C = unknown> {
  /** Runtime state for this cycle */
  state: ResponseCycleState;
  /** Retry state for model invocation errors */
  retryState: RetryState;
  /** Callbacks for manual retry control from UI */
  retryCallbacks: RetryCallbacks;
}

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
  ResponseCycleShared<C>,
  ResponseCycleParams<C>
> {
  async prep(shared: ResponseCycleShared<C>): Promise<{
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
      : {
          logger,
          modelName: agentConfig.model,
          executionId: options.context.executionId,
          isRemote: RemoteAgentRegistry.isRemote(agentConfig.agent),
        };

    const debugFileOptions: CycleDebugFileOptions | undefined = interrupted
      ? undefined
      : {
          continuationCount: store.round.continuationCount,
          // outputLocation is always AgentFileLocation (workspace or runStorage, never external)
          outputFile: state.outputLocation.relativePath,
        };

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
    shared: ResponseCycleShared<C>,
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

    return undefined;
  }
}

/**
 * Result type for model invocation that captures both success and error cases.
 */
type InvocationExecResult =
  | { success: true; response: unknown; responseTime?: number }
  | { success: false; error: unknown };

/**
 * Handles the actual model invocation step with integrated retry support.
 *
 * Instead of throwing errors and relying on external retry logic, this node
 * uses flow transitions to handle retry:
 * - RETRY: Auto-retry with backoff (loops back to self)
 * - AWAIT_RETRY: Pause for manual retry (goes to RetryWaitNode)
 * - default: Continue to next node on success
 * - COMPLETE: Non-retryable error
 *
 * Services accessed via `_params.services`: options
 */
class ResponseModelInvocationNode<C> extends BaseNode<
  ResponseCycleShared<C>,
  ResponseCycleParams<C>
> {
  async prep(shared: ResponseCycleShared<C>): Promise<ResponseCycleShared<C>> {
    return shared;
  }

  async exec(shared: ResponseCycleShared<C>): Promise<InvocationExecResult> {
    const { options } = this._params.services;
    const { state, retryState } = shared;
    if (state.shouldStop) {
      return { success: true, response: undefined };
    }

    // Increment attempt counter (single source of truth)
    beginAttempt(retryState);

    const abortController = new AbortController();
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
          messages: state.messages,
          temperature: options.agentSetting.temperature || 0.0,
          systemPrompt: state.systemPrompt,
          endTag: options.agentSetting.endTag,
          signal: abortController.signal,
          tools: options.modelHandler.capabilities.supportsFunctionCalling
            ? options.agentSetting.tools
            : undefined,
        });

        const elapsed = (Date.now() - start) / 1000;

        return { response: modelResponse, responseTime: elapsed };
      });

      return { success: true, response, responseTime };
    } catch (error) {
      return { success: false, error };
    } finally {
      options.setAbortController(null);
    }
  }

  async post(
    shared: ResponseCycleShared<C>,
    _prepRes: ResponseCycleShared<C>,
    execRes: InvocationExecResult,
  ): Promise<string | undefined> {
    const { options } = this._params.services;
    const { state, retryState } = shared;

    // Handle successful invocation
    if (execRes.success) {
      clearRetryError(retryState);

      if (!execRes.response) {
        // Skipped or aborted
        state.endTurn = false;
        if (state.shouldStop) {
          return FlowTransition.COMPLETE;
        }
        options.logger.warn(
          'Model response was aborted or returned no data; output may be incomplete.',
        );
        state.shouldStop = true;
        return FlowTransition.COMPLETE;
      }

      state.responseObject = execRes.response;
      state.responseTime = execRes.responseTime;

      if (state.debugContext && state.debugFileOptions) {
        await maybeSaveDebugObject({
          object: execRes.response,
          objectType: 'response',
          context: state.debugContext,
          fileOptions: state.debugFileOptions,
        });
      }

      return undefined; // Continue to process node
    }

    // Handle error - use single source of truth for retry decision and side-effects
    const formatted = formatProviderHttpError(execRes.error);
    const decision = determineRetryStrategy(
      retryState,
      formatted.message,
      formatted.statusCode,
      formatted.retryable,
    );

    // Apply retry decision (logging, sleeping) via shared helper
    const transition = await applyRetryDecision(
      decision,
      options.logger,
      retryState,
      'Model invocation',
    );

    // Set state flags on failure (response-cycle specific)
    if (decision.action === 'fail') {
      state.shouldStop = true;
      state.endTurn = false;
    }

    return transition;
  }
}

interface ProcessResult {
  stopReason: ProviderStopReason;
  newResponse?: string;
  processedResponse?: string;
  bestConnector?: string;
  thinkingContent?: string | null;
  useStreaming: boolean;
  responseUsage: any;
  apiUsage: ReturnType<
    ResponseCycleOptions['modelHandler']['computeResponseUsage']
  >;
  repetitionDetected: boolean;
}

type ProcessNodeResult = SkippableNodeResult<ProcessResult>;

type ContinuationNodeResult = SkippableNodeResult<{
  shouldEndTurn: boolean;
  shouldStop: boolean;
  shouldContinue: boolean;
}>;

/**
 * Transforms the raw model response into output-ready text, updates usage metrics,
 * and persists incremental tool-state derived from the result.
 *
 * Services accessed via `_params.services`: options, store
 */
class ResponseProcessNode<C> extends BaseNode<
  ResponseCycleShared<C>,
  ResponseCycleParams<C>
> {
  async prep(shared: ResponseCycleShared<C>): Promise<ResponseCycleShared<C>> {
    return shared;
  }

  async exec(shared: ResponseCycleShared<C>): Promise<ProcessNodeResult> {
    const { options, store } = this._params.services;
    const { state } = shared;
    if (state.shouldStop || !state.responseObject) {
      return { skipped: true };
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
        state.responseObject,
        options.agentSetting.endTag,
      );

      if (newResponse) {
        options.logger.debug(`Model response: ${newResponse.slice(0, 100)}`);
      }

      if (state.responseTime !== undefined) {
        store.round.addResponseTime(state.responseTime);
        options.logger.debug(
          `Response time: ${state.responseTime.toFixed(2)}s`,
        );
      }

      options.logger.debug(`Stop reason: ${stopReason}`);
      options.logger.debug(`Token usage: ${JSON.stringify(responseUsage)}`);

      const thinkingContent = options.modelHandler.processThinkingBlock(
        state.responseObject,
        store.workspace,
      );
      const useStreaming = options.modelHandler.getStreamingConfig();

      if (thinkingContent && !useStreaming) {
        const formatted = await xmlUtils.formatContent(thinkingContent);
        if (formatted.trim().length > 0) {
          options.logger.info(formatted, {
            messageType: MESSAGE_TYPES.THINKING,
          });
        }
      }

      const scratchpad = await xmlUtils.extractScratchpad(
        newResponse,
        'scratchpad',
      );
      if (scratchpad) {
        options.logger.info(scratchpad, {
          messageType: MESSAGE_TYPES.SCRATCHPAD,
        });
      }

      if (newResponse && !useStreaming) {
        const formattedResponse = await xmlUtils.formatContent(newResponse);
        options.logger.info(formattedResponse, {
          messageType: MESSAGE_TYPES.INTERNAL,
        });
      }

      const apiUsage = options.modelHandler.computeResponseUsage(
        responseUsage,
        state.responseTime ?? 0,
      );
      store.round.setUsage({
        summary: apiUsage,
        nativeUsage: responseUsage,
        provider: resolveUsageProvider(options.modelHandler),
      });

      const repetitionResult = checkForMassiveRepetition(
        store.workspace.assembly.lastResponse,
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
          JSON.stringify(messageToSkeleton(state.messages), null, 2),
        );
      }

      let processedResponse: string | undefined;
      let bestConnector: string | undefined;
      if (newResponse) {
        processedResponse = replacementEngine.applyAll(newResponse);

        if (!repetitionResult.massiveRepetitionDetected) {
          const connector = await bestConnectionMethod(
            store.workspace.assembly.lastResponse.slice(-K_SLICE),
            processedResponse.slice(0, K_SLICE),
          );
          bestConnector = connector.connector;
          store.workspace.assembly.updateLastResponse(processedResponse);
          store.workspace.assembly.updateAccumulatedOutput(
            store.workspace.assembly.accumulatedOutput +
              (bestConnector ?? '') +
              processedResponse,
          );
        }
      }

      return {
        skipped: false,
        value: {
          stopReason,
          newResponse,
          processedResponse,
          bestConnector,
          thinkingContent,
          useStreaming,
          responseUsage,
          apiUsage,
          repetitionDetected: repetitionResult.massiveRepetitionDetected,
        },
      };
    });
  }

  async post(
    shared: ResponseCycleShared<C>,
    _prepRes: ResponseCycleShared<C>,
    execRes: ProcessNodeResult,
  ): Promise<string | undefined> {
    const { options, store } = this._params.services;
    const { state } = shared;

    if (execRes.skipped) {
      state.endTurn = false;
      if (!state.roundFinalized) {
        state.roundFinalized = true;
        await store.finalizeRound();
      }
      return FlowTransition.COMPLETE;
    }

    const result = execRes.value;

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

    const outputLocation = state.outputLocation;

    await AbsoluteFS.ensureDir(path.dirname(outputLocation.absolutePath));

    if (!state.outputExists) {
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

    if (result.apiUsage) {
      store.round.setUsage({
        summary: result.apiUsage,
        nativeUsage: result.responseUsage,
        provider: resolveUsageProvider(options.modelHandler),
      });

      options.logger.debug(
        `API usage summary: ${JSON.stringify(result.apiUsage)}`,
      );
    }

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

    return undefined;
  }
}

/**
 * Evaluates the processed response to decide whether the agent should end the turn,
 * stop entirely, or enqueue a continuation request.
 *
 * Services accessed via `_params.services`: options, store
 */
class ResponseContinuationNode<C> extends BaseNode<
  ResponseCycleShared<C>,
  ResponseCycleParams<C>
> {
  async prep(shared: ResponseCycleShared<C>): Promise<ResponseCycleShared<C>> {
    return shared;
  }

  async exec(shared: ResponseCycleShared<C>): Promise<ContinuationNodeResult> {
    const { options, store } = this._params.services;
    const { state } = shared;
    if (state.shouldStop || !state.stopReason || !state.processedResponse) {
      return { skipped: true };
    }

    const stopReason = state.stopReason!;
    const processedResponse = state.processedResponse!;

    const stage = await options.logger.stage('Continuation decision', {
      skip: true,
    });

    return stage.run(async () => {
      const interrupted = Boolean(await options.checkInterruption());
      if (interrupted) {
        return {
          skipped: false,
          value: {
            shouldEndTurn: false,
            shouldStop: true,
            shouldContinue: false,
          },
        };
      }

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
        skipped: false,
        value: { shouldEndTurn, shouldStop, shouldContinue },
      };
    });
  }

  async post(
    shared: ResponseCycleShared<C>,
    _prepRes: ResponseCycleShared<C>,
    execRes: ContinuationNodeResult,
  ): Promise<string | undefined> {
    const { options, store } = this._params.services;
    const { state } = shared;

    if (execRes.skipped) {
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

    const reachedTokenLimit = isTokenLimitStopReason(state.stopReason);
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
  ResponseCycleShared<C>,
  ResponseCycleParams<C>
> {
  const prepNode = new ResponsePrepNode<C>();
  const invokeNode = new ResponseModelInvocationNode<C>();
  // Use shared retry wait node (single source of truth)
  // Note: RetryWaitNode accesses services via its own accessor pattern
  const retryWaitNode = createRetryWaitNode<ResponseCycleShared<C>>({
    getStreamId: (_shared, params) =>
      (params as ResponseCycleParams<C>).services.options.context.streamId,
    getLogger: (_shared, params) =>
      (params as ResponseCycleParams<C>).services.options.logger,
    operationName: 'Model invocation',
  });
  const processNode = new ResponseProcessNode<C>();
  const continuationNode = new ResponseContinuationNode<C>();

  // Main flow: prep → invoke → process → continuation
  prepNode.next(invokeNode);
  invokeNode.next(processNode);
  processNode.next(continuationNode);

  // Retry transitions from invoke node:
  // - RETRY: Loop back to invoke for auto-retry
  // - AWAIT_RETRY: Go to retry wait node for manual retry
  invokeNode.on(FlowTransition.RETRY, invokeNode);
  invokeNode.on(FlowTransition.AWAIT_RETRY, retryWaitNode);

  // Retry wait node transitions:
  // - RETRY: Loop back to invoke node after user triggers retry
  // - COMPLETE: Exit flow if user cancels
  retryWaitNode.on(FlowTransition.RETRY, invokeNode);

  // Continuation can loop back to prep
  continuationNode.on(FlowTransition.CONTINUE, prepNode);

  return new Flow<ResponseCycleShared<C>, ResponseCycleParams<C>>(prepNode);
}
