// Standard library imports
import * as path from 'path';

// Local imports - core flow primitives
import { BaseNode, Flow } from '@agent/node';
import { AgentSharedStore } from '@agent/core/AgentSharedStore';
// Type imports
import type { ResponseCycleOptions } from '@agent/core/ResponseCycle';
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
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';

// Local imports - utilities
import { maybeSaveDebugObject } from '@agent/utils/debugMessageSaver';
// Type imports
import type { DebugObjectType } from '@agent/utils/debugMessageSaver';
// Internal imports
import { messageToSkeleton } from '@agent/utils/messageSkeletonUtils';
import { getSystemPromptWithRules } from '@agent/utils/promptHelpers';
import { checkForMassiveRepetition } from '@agent/utils/text/repetitionUtils';

// Local imports - logging
import type { ExecutionId } from '@agent/types/IdentifierTypes';
// Internal imports
import { isTokenLimitStopReason } from '@agent/modelHandlers/utils/stopReasonUtils';
import { formatProviderHttpError } from '@common/errors/sdkErrorUtils';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import replacementEngine from '@replacement/engine';
import type { AgentFileLocation } from '@utils/files';
import { K_SLICE, REPETITION_DETECTION_THRESHOLD } from '@utils/config';
import { AbsoluteFS, TaskRunFileService, flexibleFS } from '@utils/files';
import type { FileLocation } from '@utils/files';
import { sleep } from '@utils/helpers';
import xmlUtils from '@utils/text/xmlUtils';
import { bestConnectionMethod } from '@latex';

// Local file imports
import { FlowTransition } from './FlowTransitions';
import {
  type RetryState,
  type RetryCallbacks,
  clearRetryError,
  determineRetryStrategy,
} from './RetryState';
import { createRetryWaitNode } from './BaseRetryWaitNode';

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

export interface ResponseCycleContext<C = unknown> {
  options: ResponseCycleOptions<C>;
  store: AgentSharedStore;
  state: ResponseCycleState;
  /** Retry state for model invocation errors. */
  retryState: RetryState;
  /** Callbacks for manual retry control from UI. */
  retryCallbacks: RetryCallbacks;
}

type InvocationNodeResult = SkippableNodeResult<{
  response: unknown;
  responseTime?: number;
}>;

// Each node in the response cycle progressively hydrates the shared cycle
// object. Mutations performed in `prep`, `exec`, and `post` stages are
// intentionally visible to downstream nodes so that debug metadata and model
// results accumulate over the course of the flow.

/**
 * Prepares a response cycle by hydrating prompts, checking interruptions, and
 * establishing debug metadata before invoking the model.
 */
class ResponsePrepNode<C> extends BaseNode<ResponseCycleContext<C>> {
  async prep(shared: ResponseCycleContext<C>): Promise<{
    interrupted: boolean;
    exists: boolean;
    systemPrompt?: string;
    debugContext?: CycleDebugContext;
    debugFileOptions?: CycleDebugFileOptions;
    outputLocation: AgentFileLocation;
  }> {
    const { options, state, store } = shared;
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
    { state }: ResponseCycleContext<C>,
    prepRes: {
      interrupted: boolean;
      exists: boolean;
      systemPrompt?: string;
      debugContext?: CycleDebugContext;
      debugFileOptions?: CycleDebugFileOptions;
      outputLocation: AgentFileLocation;
    },
  ): Promise<string | undefined> {
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
 */
class ResponseModelInvocationNode<C> extends BaseNode<ResponseCycleContext<C>> {
  async prep(
    shared: ResponseCycleContext<C>,
  ): Promise<ResponseCycleContext<C>> {
    return shared;
  }

  async exec(context: ResponseCycleContext<C>): Promise<InvocationExecResult> {
    const { options, state, retryState } = context;
    if (state.shouldStop) {
      return { success: true, response: undefined };
    }

    // Increment attempt counter
    retryState.attemptCount++;

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
    shared: ResponseCycleContext<C>,
    prepRes: ResponseCycleContext<C>,
    execRes: InvocationExecResult,
  ): Promise<string | undefined> {
    const { options, state, retryState } = shared;

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

    // Handle error - use single source of truth for retry decision
    const formatted = formatProviderHttpError(execRes.error);
    const decision = determineRetryStrategy(
      retryState,
      formatted.message,
      formatted.statusCode,
    );

    switch (decision.action) {
      case 'auto_retry':
        options.logger.warn(
          `Retrying model invocation after ${decision.delayMs}ms (retry ${retryState.attemptCount - 1}/${retryState.maxAutoAttempts}): ${decision.error.message}`,
          {
            messageType: MESSAGE_TYPES.PROGRESS_STATUS,
            data: {
              attempt: retryState.attemptCount,
              maxAttempts: retryState.maxAutoAttempts,
              statusCode: decision.error.statusCode,
            },
          },
        );
        await sleep(decision.delayMs!);
        return FlowTransition.RETRY;

      case 'manual_retry':
        options.logger.error(
          `Model invocation failed: ${decision.error.message}`,
          {
            messageType: MESSAGE_TYPES.PROGRESS_STATUS,
            data: { statusCode: decision.error.statusCode, retryable: true },
          },
        );
        return FlowTransition.AWAIT_RETRY;

      case 'fail':
        options.logger.error(
          `Model invocation failed (not retryable): ${decision.error.message}`,
          {
            messageType: MESSAGE_TYPES.PROGRESS_STATUS,
            data: { statusCode: decision.error.statusCode, retryable: false },
          },
        );
        state.shouldStop = true;
        state.endTurn = false;
        return FlowTransition.COMPLETE;
    }
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
 */
class ResponseProcessNode<C> extends BaseNode<ResponseCycleContext<C>> {
  async prep(
    shared: ResponseCycleContext<C>,
  ): Promise<ResponseCycleContext<C>> {
    return shared;
  }

  async exec(context: ResponseCycleContext<C>): Promise<ProcessNodeResult> {
    const { options, state, store } = context;
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
    _shared: ResponseCycleContext<C>,
    prepRes: ResponseCycleContext<C>,
    execRes: ProcessNodeResult,
  ): Promise<string | undefined> {
    const { options, state, store } = prepRes;

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
 */
class ResponseContinuationNode<C> extends BaseNode<ResponseCycleContext<C>> {
  async prep(
    shared: ResponseCycleContext<C>,
  ): Promise<ResponseCycleContext<C>> {
    return shared;
  }

  async exec(
    context: ResponseCycleContext<C>,
  ): Promise<ContinuationNodeResult> {
    const { options, state, store } = context;
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
    _shared: ResponseCycleContext<C>,
    prepRes: ResponseCycleContext<C>,
    execRes: ContinuationNodeResult,
  ): Promise<string | undefined> {
    const { options, state, store } = prepRes;

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

export function createResponseCycleFlow<C>(): Flow<ResponseCycleContext<C>> {
  const prepNode = new ResponsePrepNode<C>();
  const invokeNode = new ResponseModelInvocationNode<C>();
  // Use shared retry wait node (single source of truth)
  const retryWaitNode = createRetryWaitNode<ResponseCycleContext<C>>({
    getStreamId: (ctx) => ctx.options.context.streamId,
    getLogger: (ctx) => ctx.options.logger,
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

  return new Flow<ResponseCycleContext<C>>(prepNode);
}
