// Local imports - core flow primitives
import { BaseNode, Flow } from '@agent/node';

// Local imports - flow constants
import { FlowTransition } from './FlowTransitions';

// Local imports - agent components
import { AgentSharedStore } from '@agent/core/AgentSharedStore';
import type { ResponseCycleOptions } from '@agent/core/ResponseCycle';
import { resolveUsageProvider } from '@agent/core/UsageProviderUtils';
import type { ProviderStopReason } from '@agent/modelHandlers/types/StopReasonTypes';

// Local imports - model handler types
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';

// Local imports - utilities
import { maybeSaveDebugObject } from '@agent/utils/debugMessageSaver';
import type { DebugObjectType } from '@agent/utils/debugMessageSaver';
import { messageToSkeleton } from '@agent/utils/messageSkeletonUtils';
import { getSystemPromptWithRules } from '@agent/utils/promptHelpers';
import { checkForMassiveRepetition } from '@agent/utils/text/repetitionUtils';

// Local imports - latex utilities
import { bestConnectionMethod } from '@latex';

// Local imports - logging
import { MESSAGE_TYPES } from '@logger/messageTypes';

// Local imports - replacement engine
import replacementEngine from '@replacement/engine';

// Local imports - configuration/constants
import { K_SLICE, REPETITION_DETECTION_THRESHOLD } from '@utils/config';

// Local imports - filesystem utilities
import { WorkspaceFS } from '@utils/files';

// Local imports - text utilities
import xmlUtils from '@utils/text/xmlUtils';

// Local imports - identifier types
import type { ExecutionId } from '@agent/types/IdentifierTypes';

interface DebugContext {
  logger: ResponseCycleOptions['logger'];
  modelName: string;
  executionId?: ExecutionId;
}

interface DebugFileOptions {
  continuationCount: number;
  outputFile: string;
}

async function maybeSaveDebug(
  debugContext: DebugContext | undefined,
  debugFileOptions: DebugFileOptions | undefined,
  object: unknown,
  objectType: DebugObjectType,
): Promise<void> {
  if (!debugContext || !debugFileOptions) {
    return;
  }

  await maybeSaveDebugObject({
    object,
    objectType,
    context: debugContext,
    fileOptions: debugFileOptions,
  });
}

export interface ResponseCycleInputState {
  messages: ProviderMessage[];
  outputFile: string;
}

export interface ResponseCycleRuntimeState {
  endTurn: boolean;
  shouldStop: boolean;
  outputExists: boolean;
  systemPrompt?: string;
  debugContext?: DebugContext;
  debugFileOptions?: DebugFileOptions;
  startTime?: number;
  responseObject?: unknown;
  responseTime?: number;
  stopReason?: ProviderStopReason;
  processedResponse?: string;
}

export type ResponseCycleState = ResponseCycleInputState &
  ResponseCycleRuntimeState;

function resetResponseCycleState(cycle: ResponseCycleRuntimeState): void {
  cycle.shouldStop = false;
  cycle.endTurn = false;
  cycle.responseObject = undefined;
  cycle.responseTime = undefined;
  cycle.stopReason = undefined;
  cycle.processedResponse = undefined;
}

export interface ResponseCycleShared<C = unknown> {
  options: ResponseCycleOptions<C>;
  store: AgentSharedStore;
  state: ResponseCycleState;
}

// Each node in the response cycle progressively hydrates the shared cycle
// object. Mutations performed in `prep`, `exec`, and `post` stages are
// intentionally visible to downstream nodes so that debug metadata and model
// results accumulate over the course of the flow.

/**
 * Prepares a response cycle by hydrating prompts, checking interruptions, and
 * establishing debug metadata before invoking the model.
 */
class ResponsePrepNode<C> extends BaseNode<ResponseCycleShared<C>> {
  async prep(shared: ResponseCycleShared<C>): Promise<{
    interrupted: boolean;
    exists: boolean;
    systemPrompt?: string;
    debugContext?: DebugContext;
    debugFileOptions?: DebugFileOptions;
  }> {
    const { options, state, store } = shared;
    const { agentPrompt, userVars, logger, agentConfig } = options;
    const interrupted = Boolean(await options.checkInterruption());
    const exists = await WorkspaceFS.exists(state.outputFile);
    const systemPrompt = interrupted
      ? undefined
      : await getSystemPromptWithRules(agentPrompt.systemPrompt, userVars);

    const debugContext: DebugContext | undefined = interrupted
      ? undefined
      : {
          logger,
          modelName: agentConfig.model,
          executionId: options.executionId,
        };

    const debugFileOptions: DebugFileOptions | undefined = interrupted
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
    };
  }

  async post(
    { state }: ResponseCycleShared<C>,
    prepRes: {
      interrupted: boolean;
      exists: boolean;
      systemPrompt?: string;
      debugContext?: DebugContext;
      debugFileOptions?: DebugFileOptions;
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
    state.startTime = Date.now();
    resetResponseCycleState(state);

    await maybeSaveDebug(
      state.debugContext,
      state.debugFileOptions,
      state.messages,
      'messages',
    );

    return undefined;
  }
}

/**
 * Handles the actual model invocation step, storing the raw response payload and
 * timing information for downstream processing.
 */
class ResponseModelInvocationNode<C> extends BaseNode<ResponseCycleShared<C>> {
  async prep(shared: ResponseCycleShared<C>): Promise<ResponseCycleShared<C>> {
    return shared;
  }

  async exec(
    context: ResponseCycleShared<C>,
  ): Promise<{ skipped: true } | { response: unknown; responseTime?: number }> {
    const { options, state } = context;
    if (state.shouldStop) {
      return { skipped: true };
    }

    const abortController = new AbortController();
    options.setAbortController(abortController);
    options.modelHandler.setOutputStreaming(false);

    let response: unknown;
    const groupId = options.logger.getActiveGroupId();

    try {
      response = await options.modelHandler.createResponse(
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
    } catch (error) {
      const message =
        error instanceof Error
          ? `Model invocation failed: ${error.message}`
          : 'Model invocation failed with an unknown error';
      options.logger.error(message, groupId);
      state.shouldStop = true;
      state.endTurn = false;
      throw error;
    } finally {
      options.setAbortController(null);
    }

    const responseTime = state.startTime
      ? (Date.now() - state.startTime) / 1000
      : undefined;

    return { response, responseTime };
  }

  async post(
    _shared: ResponseCycleShared<C>,
    prepRes: ResponseCycleShared<C>,
    execRes: { skipped: true } | { response: unknown; responseTime?: number },
  ): Promise<string | undefined> {
    const { options, state } = prepRes;
    const groupId = options.logger.getActiveGroupId();

    if ('skipped' in execRes) {
      state.endTurn = false;
      return FlowTransition.COMPLETE;
    }

    state.responseObject = execRes.response;
    state.responseTime = execRes.responseTime;

    await maybeSaveDebug(
      state.debugContext,
      state.debugFileOptions,
      execRes.response,
      'response',
    );

    if (!execRes.response) {
      options.logger.warn(
        'Model response was aborted or returned no data; output may be incomplete.',
        groupId,
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

/**
 * Transforms the raw model response into output-ready text, updates usage metrics,
 * and persists incremental tool-state derived from the result.
 */
class ResponseProcessNode<C> extends BaseNode<ResponseCycleShared<C>> {
  async prep(shared: ResponseCycleShared<C>): Promise<ResponseCycleShared<C>> {
    return shared;
  }

  async exec(
    context: ResponseCycleShared<C>,
  ): Promise<ProcessResult | { skipped: true }> {
    const { options, state, store } = context;
    if (state.shouldStop || !state.responseObject) {
      return { skipped: true };
    }

    const [newResponse, responseUsage, stopReason] =
      options.modelHandler.extractResponse(
        state.responseObject,
        options.agentSetting.endTag,
      );

    const groupId = options.logger.getActiveGroupId();

    if (newResponse) {
      options.logger.debug(
        `Model response: ${newResponse.slice(0, 100)}`,
        groupId,
      );
    }

    if (state.responseTime !== undefined) {
      store.round.addResponseTime(state.responseTime);
      options.logger.debug(
        `Response time: ${state.responseTime.toFixed(2)}s`,
        groupId,
      );
    }

    options.logger.debug(`Stop reason: ${stopReason}`, groupId);
    options.logger.debug(
      `Token usage: ${JSON.stringify(responseUsage)}`,
      groupId,
    );

    const thinkingContent = options.modelHandler.processThinkingBlock(
      state.responseObject,
      groupId,
      store.workspace,
    );
    const useStreaming = options.modelHandler.getStreamingConfig();

    if (thinkingContent && !useStreaming) {
      const formatted = await xmlUtils.formatContent(thinkingContent);
      if (formatted.trim().length > 0) {
        options.logger.info(formatted, groupId, MESSAGE_TYPES.THINKING);
      }
    }

    const scratchpad = await xmlUtils.extractScratchpad(
      newResponse,
      'scratchpad',
    );
    if (scratchpad) {
      options.logger.info(scratchpad, groupId, MESSAGE_TYPES.SCRATCHPAD);
    }

    if (newResponse && !useStreaming) {
      const formattedResponse = await xmlUtils.formatContent(newResponse);
      options.logger.info(formattedResponse, groupId, MESSAGE_TYPES.INTERNAL);
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
        groupId,
      );
      options.logger.error(
        'Massive repetition detected - skipping this response',
        groupId,
      );
      options.logger.error(
        'Message structure when repetition detected:',
        groupId,
      );
      options.logger.error(
        JSON.stringify(messageToSkeleton(state.messages), null, 2),
        groupId,
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
      stopReason,
      newResponse,
      processedResponse,
      bestConnector,
      thinkingContent,
      useStreaming,
      responseUsage,
      apiUsage,
      repetitionDetected: repetitionResult.massiveRepetitionDetected,
    };
  }

  async post(
    _shared: ResponseCycleShared<C>,
    prepRes: ResponseCycleShared<C>,
    execRes: ProcessResult | { skipped: true },
  ): Promise<string | undefined> {
    const { options, state, store } = prepRes;
    const groupId = options.logger.getActiveGroupId();

    if ('skipped' in execRes) {
      state.endTurn = false;
      return FlowTransition.COMPLETE;
    }

    state.stopReason = execRes.stopReason;
    state.processedResponse = execRes.processedResponse;
    store.run.recordRound(store.round);

    if (execRes.repetitionDetected || !execRes.processedResponse) {
      state.endTurn = false;
      state.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    if (!state.outputExists) {
      options.logger.debug(`Creating new file: ${state.outputFile}`, groupId);
      await WorkspaceFS.write(state.outputFile, execRes.processedResponse);
      state.outputExists = true;
    } else {
      options.logger.debug(
        `Appending to existing file: ${state.outputFile}`,
        groupId,
      );
      await WorkspaceFS.appendFile(
        state.outputFile,
        (execRes.bestConnector ?? '') + execRes.processedResponse,
      );
    }

    options.logger.debug('Response preview:', groupId);
    options.logger.debug(
      `First ${K_SLICE} chars:\n${execRes.processedResponse.slice(0, K_SLICE)}`,
      groupId,
    );
    options.logger.debug(
      `Last ${K_SLICE} chars:\n${execRes.processedResponse.slice(-K_SLICE)}`,
      groupId,
    );

    if (options.modelHandler.capabilities.supportsAssistantPrefill) {
      options.modelHandler.updateMessageContentWithPrefill(
        state.messages,
        execRes.bestConnector ?? '',
        execRes.processedResponse,
        store.workspace,
      );
    } else {
      options.modelHandler.updateMessageContentWithoutPrefill(
        state.messages,
        execRes.bestConnector ?? '',
        execRes.processedResponse,
        store.workspace,
      );
    }

    return undefined;
  }
}

/**
 * Evaluates the processed response to decide whether the agent should end the turn,
 * stop entirely, or enqueue a continuation request.
 */
class ResponseContinuationNode<C> extends BaseNode<ResponseCycleShared<C>> {
  async prep(shared: ResponseCycleShared<C>): Promise<ResponseCycleShared<C>> {
    return shared;
  }

  async exec(
    context: ResponseCycleShared<C>,
  ): Promise<
    | { shouldEndTurn: boolean; shouldStop: boolean; shouldContinue: boolean }
    | { skipped: true }
  > {
    const { options, state, store } = context;
    if (state.shouldStop || !state.stopReason || !state.processedResponse) {
      return { skipped: true };
    }

    const interrupted = Boolean(await options.checkInterruption());
    if (interrupted) {
      return { shouldEndTurn: false, shouldStop: true, shouldContinue: false };
    }

    const [shouldEndTurn, shouldStop] =
      options.modelHandler.checkStopConditions(
        state.stopReason,
        state.processedResponse,
        store.round,
        store.run,
        options.agentSetting,
      );

    const shouldContinue = options.modelHandler.shouldContinue(
      state.stopReason,
      state.processedResponse,
      options.agentSetting,
    );

    return { shouldEndTurn, shouldStop, shouldContinue };
  }

  async post(
    shared: ResponseCycleShared<C>,
    prepRes: ResponseCycleShared<C>,
    execRes:
      | { shouldEndTurn: boolean; shouldStop: boolean; shouldContinue: boolean }
      | { skipped: true },
  ): Promise<string | undefined> {
    const { options, state, store } = prepRes;
    const groupId = options.logger.getActiveGroupId();

    if ('skipped' in execRes) {
      state.endTurn = false;
      state.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    state.endTurn = execRes.shouldEndTurn;
    state.shouldStop = execRes.shouldStop;

    if (execRes.shouldStop) {
      return FlowTransition.COMPLETE;
    }

    store.round.incrementContinuation();
    options.logger.info(
      `Starting continuation #${store.round.continuationCount}`,
      groupId,
      MESSAGE_TYPES.PROGRESS_STATUS,
    );

    if (!execRes.shouldContinue) {
      return FlowTransition.COMPLETE;
    }

    options.logger.debug(
      'Should continue - adding continuation message to conversation',
      groupId,
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

export function createResponseCycleFlow<C>(): Flow<ResponseCycleShared<C>> {
  const prepNode = new ResponsePrepNode<C>();
  const invokeNode = new ResponseModelInvocationNode<C>();
  const processNode = new ResponseProcessNode<C>();
  const continuationNode = new ResponseContinuationNode<C>();

  prepNode.next(invokeNode);
  invokeNode.next(processNode);
  processNode.next(continuationNode);

  continuationNode.on(FlowTransition.CONTINUE, prepNode);

  return new Flow<ResponseCycleShared<C>>(prepNode);
}
