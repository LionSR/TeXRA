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
import { K_SLICE, REPETITION_DETECTION_THRESHOLD } from '@utils/config';
import { AbsoluteFS, TaskRunFileService, flexibleFS } from '@utils/files';
import xmlUtils from '@utils/text/xmlUtils';
import { bestConnectionMethod } from '@latex';

// Local file imports
import { FlowTransition } from './FlowTransitions';

export interface ResponseCycleInputState {
  outputFile: string;
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
  outputLocation?: ReturnType<TaskRunFileService['resolveRelativePath']>;
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
    outputLocation: ReturnType<TaskRunFileService['resolveRelativePath']>;
  }> {
    const { options, state, store } = shared;
    const { agentPrompt, userVars, logger, agentConfig, fileService } = options;
    const interrupted = Boolean(await options.checkInterruption());
    const outputLocation = fileService.resolveRelativePath(state.outputFile);
    const exists = await flexibleFS.exists(outputLocation.absolutePath);
    const systemPrompt = interrupted
      ? undefined
      : await getSystemPromptWithRules(agentPrompt.systemPrompt, userVars);

    const debugContext: CycleDebugContext | undefined = interrupted
      ? undefined
      : {
          logger,
          modelName: agentConfig.model,
          executionId: options.context.executionId,
        };

    const debugFileOptions: CycleDebugFileOptions | undefined = interrupted
      ? undefined
      : {
          continuationCount: store.round.continuationCount,
          outputFile: state.outputFile,
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
      outputLocation: ReturnType<TaskRunFileService['resolveRelativePath']>;
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
 * Handles the actual model invocation step, storing the raw response payload and
 * timing information for downstream processing.
 */
class ResponseModelInvocationNode<C> extends BaseNode<ResponseCycleContext<C>> {
  async prep(
    shared: ResponseCycleContext<C>,
  ): Promise<ResponseCycleContext<C>> {
    return shared;
  }

  async exec(context: ResponseCycleContext<C>): Promise<InvocationNodeResult> {
    const { options, state } = context;
    if (state.shouldStop) {
      return { skipped: true };
    }

    const abortController = new AbortController();
    options.setAbortController(abortController);
    options.modelHandler.setOutputStreaming(false);

    const stage = await options.logger.stage('Model invocation', {
      skip: true,
    });

    try {
      const { response, responseTime } = await stage.run(async () => {
        const invocation = await options.modelHandler.createResponse(
          options.client,
          state.messages,
          options.agentSetting.temperature || 0.0,
          state.systemPrompt,
          options.agentSetting.endTag,
          abortController.signal,
          options.modelHandler.capabilities.supportsFunctionCalling
            ? options.agentSetting.tools
            : undefined,
        );

        const elapsed = state.startTime
          ? (Date.now() - state.startTime) / 1000
          : undefined;

        return { response: invocation, responseTime: elapsed };
      });

      return { skipped: false, value: { response, responseTime } };
    } catch (error) {
      const formattedError = formatProviderHttpError(error);
      const message = `Model invocation failed: ${formattedError.message}`;
      options.logger.error(
        message,
        undefined,
        MESSAGE_TYPES.PROGRESS_STATUS,
        formattedError,
      );
      state.shouldStop = true;
      state.endTurn = false;
      throw error;
    } finally {
      options.setAbortController(null);
    }
  }

  async post(
    _shared: ResponseCycleContext<C>,
    prepRes: ResponseCycleContext<C>,
    execRes: InvocationNodeResult,
  ): Promise<string | undefined> {
    const { options, state } = prepRes;

    if (execRes.skipped) {
      state.endTurn = false;
      return FlowTransition.COMPLETE;
    }

    const { response, responseTime } = execRes.value;

    state.responseObject = response;
    state.responseTime = responseTime;

    if (state.debugContext && state.debugFileOptions) {
      await maybeSaveDebugObject({
        object: response,
        objectType: 'response',
        context: state.debugContext,
        fileOptions: state.debugFileOptions,
      });
    }

    if (!response) {
      options.logger.warn(
        'Model response was aborted or returned no data; output may be incomplete.',
      );
      state.endTurn = false;
      state.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    return undefined;
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
      const [newResponse, responseUsage, stopReason] =
        options.modelHandler.extractResponse(
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
          options.logger.info(formatted, undefined, MESSAGE_TYPES.THINKING);
        }
      }

      const scratchpad = await xmlUtils.extractScratchpad(
        newResponse,
        'scratchpad',
      );
      if (scratchpad) {
        options.logger.info(scratchpad, undefined, MESSAGE_TYPES.SCRATCHPAD);
      }

      if (newResponse && !useStreaming) {
        const formattedResponse = await xmlUtils.formatContent(newResponse);
        options.logger.info(
          formattedResponse,
          undefined,
          MESSAGE_TYPES.INTERNAL,
        );
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

    const outputLocation =
      state.outputLocation ??
      options.fileService.resolveRelativePath(state.outputFile);
    state.outputLocation = outputLocation;

    await AbsoluteFS.ensureDir(path.dirname(outputLocation.absolutePath));

    if (!state.outputExists) {
      options.logger.debug(`Creating new file: ${outputLocation.absolutePath}`);
      await AbsoluteFS.write(outputLocation.absolutePath, processedResponse);
      state.outputExists = true;
    } else {
      options.logger.debug(
        `Appending to existing file: ${outputLocation.absolutePath}`,
      );
      const existing = (await AbsoluteFS.exists(outputLocation.absolutePath))
        ? await AbsoluteFS.read(outputLocation.absolutePath)
        : '';
      await AbsoluteFS.write(
        outputLocation.absolutePath,
        `${existing}${(result.bestConnector ?? '') + processedResponse}`,
      );
    }

    const responseUsage = result.responseUsage ?? {};
    const usageSummary = Object.entries(responseUsage)
      .map(([key, value]) => `${key}: ${value}`)
      .join(', ');
    options.logger.debug(`Usage summary: ${usageSummary}`);

    if (result.thinkingContent && !result.useStreaming) {
      options.logger.info(
        result.thinkingContent,
        undefined,
        MESSAGE_TYPES.THINKING,
      );
    }

    options.logger.info(
      `Stop reason: ${result.stopReason}`,
      undefined,
      MESSAGE_TYPES.PROGRESS_STATUS,
    );

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

      const [shouldEndTurn, shouldStop] =
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
      undefined,
      MESSAGE_TYPES.PROGRESS_STATUS,
    );

    if (reachedTokenLimit) {
      options.logger.info(
        'Continuing after hitting the model token limit',
        undefined,
        MESSAGE_TYPES.PROGRESS_STATUS,
      );
    }

    options.logger.info(
      '🧵 Added continuation prompt from partial XML output',
      undefined,
      MESSAGE_TYPES.PROGRESS_STATUS,
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
  const processNode = new ResponseProcessNode<C>();
  const continuationNode = new ResponseContinuationNode<C>();

  prepNode.next(invokeNode);
  invokeNode.next(processNode);
  processNode.next(continuationNode);

  continuationNode.on(FlowTransition.CONTINUE, prepNode);

  return new Flow<ResponseCycleContext<C>>(prepNode);
}
