// Local imports - core flow primitives
import { BaseNode, Flow } from '@agent/node';

// Local imports - flow constants
import { FlowTransition } from './FlowTransitions';

// Local imports - agent components
import { AgentStateGlobal, AgentStateRound } from '@agent/core/AgentState';
import { ToolState } from '@agent/core/ToolState';
import type { ResponseCycleOptions } from '@agent/core/ResponseCycle';
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

/**
 * Persistent state slice - data that flows through the entire cycle.
 * Part of Pocket Flow architecture - clearly separated from transient runtime state.
 */
export interface PersistentStateSlice {
  messages: ProviderMessage[];
  stateRound: AgentStateRound;
  stateGlobal: AgentStateGlobal;
  toolState: ToolState;
  outputFile: string;
}

/**
 * Runtime control slice - transient flags that control flow execution.
 * Part of Pocket Flow architecture - separated from persistent state.
 */
export interface RuntimeControlSlice {
  endTurn: boolean;
  shouldStop: boolean;
  outputExists: boolean;
}

/**
 * Debug state slice - debug-related metadata.
 * Part of Pocket Flow architecture - isolated debug concerns.
 */
export interface DebugStateSlice {
  systemPrompt?: string;
  debugContext?: DebugContext;
  debugFileOptions?: DebugFileOptions;
}

/**
 * Model interaction slice - model invocation and response data.
 * Part of Pocket Flow architecture - isolated model-specific state.
 */
export interface ModelInteractionSlice {
  startTime?: number;
  responseObject?: unknown;
  responseTime?: number;
  stopReason?: ProviderStopReason;
  processedResponse?: string;
}

/**
 * Unified shared store composing all state slices.
 * Part of Pocket Flow architecture - explicit slice boundaries instead of monolithic state blob.
 */
export interface ResponseCycleSharedStore {
  persistent: PersistentStateSlice;
  runtime: RuntimeControlSlice;
  debug: DebugStateSlice;
  model: ModelInteractionSlice;
}

/**
 * Resets transient runtime and model state between continuation attempts.
 * Part of Pocket Flow architecture - manipulates specific slices only.
 */
function resetRuntimeState(store: ResponseCycleSharedStore): void {
  store.runtime.shouldStop = false;
  store.runtime.endTurn = false;
  store.model.responseObject = undefined;
  store.model.responseTime = undefined;
  store.model.stopReason = undefined;
  store.model.processedResponse = undefined;
}

/**
 * Shared context passed to all nodes in the response cycle flow.
 * Part of Pocket Flow architecture - explicitly structured shared store instead of flat state blob.
 */
export interface ResponseCycleShared<C = unknown> {
  options: ResponseCycleOptions<C>;
  store: ResponseCycleSharedStore;
}

// Legacy type aliases for backward compatibility with external code
export type ResponseCycleInputState = PersistentStateSlice;
export type ResponseCycleRuntimeState = RuntimeControlSlice &
  DebugStateSlice &
  ModelInteractionSlice;
export type ResponseCycleState = PersistentStateSlice &
  ResponseCycleRuntimeState;

// Each node in the response cycle progressively hydrates the shared cycle
// object. Mutations performed in `prep`, `exec`, and `post` stages are
// intentionally visible to downstream nodes so that debug metadata and model
// results accumulate over the course of the flow.

/**
 * Prepares a response cycle by hydrating prompts, checking interruptions, and
 * establishing debug metadata before invoking the model.
 * Part of Pocket Flow architecture - reads from persistent slice, writes to debug slice.
 */
class ResponsePrepNode<C> extends BaseNode<ResponseCycleShared<C>> {
  async prep(shared: ResponseCycleShared<C>): Promise<{
    interrupted: boolean;
    exists: boolean;
    systemPrompt?: string;
    debugContext?: DebugContext;
    debugFileOptions?: DebugFileOptions;
  }> {
    const { options, store } = shared;
    const { agentPrompt, userVars, logger, agentConfig } = options;
    const interrupted = Boolean(await options.checkInterruption());
    const exists = await WorkspaceFS.exists(store.persistent.outputFile);
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
          continuationCount: store.persistent.stateRound.continuationCount,
          outputFile: store.persistent.outputFile,
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
    shared: ResponseCycleShared<C>,
    prepRes: {
      interrupted: boolean;
      exists: boolean;
      systemPrompt?: string;
      debugContext?: DebugContext;
      debugFileOptions?: DebugFileOptions;
    },
  ): Promise<string | undefined> {
    const { store } = shared;
    if (prepRes.interrupted) {
      resetRuntimeState(store);
      store.runtime.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    store.runtime.outputExists = prepRes.exists;
    store.debug.systemPrompt = prepRes.systemPrompt;
    store.debug.debugContext = prepRes.debugContext;
    store.debug.debugFileOptions = prepRes.debugFileOptions;
    store.model.startTime = Date.now();
    resetRuntimeState(store);

    await maybeSaveDebug(
      store.debug.debugContext,
      store.debug.debugFileOptions,
      store.persistent.messages,
      'messages',
    );

    return undefined;
  }
}

/**
 * Handles the actual model invocation step, storing the raw response payload and
 * timing information for downstream processing.
 * Part of Pocket Flow architecture - reads from persistent/debug slices, writes to model slice.
 */
class ResponseModelInvocationNode<C> extends BaseNode<ResponseCycleShared<C>> {
  async exec(
    context: ResponseCycleShared<C>,
  ): Promise<{ skipped: true } | { response: unknown; responseTime?: number }> {
    const { options, store } = context;
    if (store.runtime.shouldStop) {
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
        store.persistent.messages,
        options.agentSetting.temperature || 0.0,
        store.debug.systemPrompt,
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
      store.runtime.shouldStop = true;
      store.runtime.endTurn = false;
      throw error;
    } finally {
      options.setAbortController(null);
    }

    const responseTime = store.model.startTime
      ? (Date.now() - store.model.startTime) / 1000
      : undefined;

    return { response, responseTime };
  }

  async post(
    shared: ResponseCycleShared<C>,
    execRes: { skipped: true } | { response: unknown; responseTime?: number },
  ): Promise<string | undefined> {
    const { options, store } = shared;
    const groupId = options.logger.getActiveGroupId();

    if ('skipped' in execRes) {
      store.runtime.endTurn = false;
      return FlowTransition.COMPLETE;
    }

    store.model.responseObject = execRes.response;
    store.model.responseTime = execRes.responseTime;

    await maybeSaveDebug(
      store.debug.debugContext,
      store.debug.debugFileOptions,
      execRes.response,
      'response',
    );

    if (!execRes.response) {
      options.logger.warn(
        'Model response was aborted or returned no data; output may be incomplete.',
        groupId,
      );
      store.runtime.endTurn = false;
      store.runtime.shouldStop = true;
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
 * Part of Pocket Flow architecture - reads model slice, updates persistent slice (metrics, toolState).
 */
class ResponseProcessNode<C> extends BaseNode<ResponseCycleShared<C>> {
  async exec(
    context: ResponseCycleShared<C>,
  ): Promise<ProcessResult | { skipped: true }> {
    const { options, store } = context;
    if (store.runtime.shouldStop || !store.model.responseObject) {
      return { skipped: true };
    }

    const [newResponse, responseUsage, stopReason] =
      options.modelHandler.extractResponse(
        store.model.responseObject,
        options.agentSetting.endTag,
      );

    const groupId = options.logger.getActiveGroupId();

    if (newResponse) {
      options.logger.debug(
        `Model response: ${newResponse.slice(0, 100)}`,
        groupId,
      );
    }

    if (store.model.responseTime !== undefined) {
      store.persistent.stateRound.updateResponseTime(store.model.responseTime);
      options.logger.debug(
        `Response time: ${store.model.responseTime.toFixed(2)}s`,
        groupId,
      );
    }

    options.logger.debug(`Stop reason: ${stopReason}`, groupId);
    options.logger.debug(
      `Token usage: ${JSON.stringify(responseUsage)}`,
      groupId,
    );

    const thinkingContent = options.modelHandler.processThinkingBlock(
      store.model.responseObject,
      groupId,
      store.persistent.toolState,
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
      store.model.responseTime ?? 0,
    );
    store.persistent.stateRound.updateTokenCounts(apiUsage);
    store.persistent.stateGlobal.updateFromCurrRound(
      store.persistent.stateRound,
    );

    const repetitionResult = checkForMassiveRepetition(
      store.persistent.toolState.lastResponse,
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
        JSON.stringify(messageToSkeleton(store.persistent.messages), null, 2),
        groupId,
      );
    }

    let processedResponse: string | undefined;
    let bestConnector: string | undefined;
    if (newResponse) {
      processedResponse = replacementEngine.applyAll(newResponse);

      if (!repetitionResult.massiveRepetitionDetected) {
        const connector = await bestConnectionMethod(
          store.persistent.toolState.lastResponse.slice(-K_SLICE),
          processedResponse.slice(0, K_SLICE),
        );
        bestConnector = connector.connector;
        store.persistent.toolState.updateLastResponse(processedResponse);
        store.persistent.toolState.updateAccumulatedOutput(
          store.persistent.toolState.accumulatedOutput +
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
    shared: ResponseCycleShared<C>,
    execRes: ProcessResult | { skipped: true },
  ): Promise<string | undefined> {
    const { options, store } = shared;
    const groupId = options.logger.getActiveGroupId();

    if ('skipped' in execRes) {
      store.runtime.endTurn = false;
      return FlowTransition.COMPLETE;
    }

    store.model.stopReason = execRes.stopReason;
    store.model.processedResponse = execRes.processedResponse;

    if (execRes.repetitionDetected || !execRes.processedResponse) {
      store.runtime.endTurn = false;
      store.runtime.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    if (!store.runtime.outputExists) {
      options.logger.debug(
        `Creating new file: ${store.persistent.outputFile}`,
        groupId,
      );
      await WorkspaceFS.write(
        store.persistent.outputFile,
        execRes.processedResponse,
      );
      store.runtime.outputExists = true;
    } else {
      options.logger.debug(
        `Appending to existing file: ${store.persistent.outputFile}`,
        groupId,
      );
      await WorkspaceFS.appendFile(
        store.persistent.outputFile,
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
        store.persistent.messages,
        execRes.bestConnector ?? '',
        execRes.processedResponse,
        store.persistent.toolState,
      );
    } else {
      options.modelHandler.updateMessageContentWithoutPrefill(
        store.persistent.messages,
        execRes.bestConnector ?? '',
        execRes.processedResponse,
        store.persistent.toolState,
      );
    }

    return undefined;
  }
}

/**
 * Evaluates the processed response to decide whether the agent should end the turn,
 * stop entirely, or enqueue a continuation request.
 * Part of Pocket Flow architecture - reads model slice, updates runtime control and persistent slices.
 */
class ResponseContinuationNode<C> extends BaseNode<ResponseCycleShared<C>> {
  async exec(
    context: ResponseCycleShared<C>,
  ): Promise<
    | { shouldEndTurn: boolean; shouldStop: boolean; shouldContinue: boolean }
    | { skipped: true }
  > {
    const { options, store } = context;
    if (
      store.runtime.shouldStop ||
      !store.model.stopReason ||
      !store.model.processedResponse
    ) {
      return { skipped: true };
    }

    const interrupted = Boolean(await options.checkInterruption());
    if (interrupted) {
      return { shouldEndTurn: false, shouldStop: true, shouldContinue: false };
    }

    const [shouldEndTurn, shouldStop] =
      options.modelHandler.checkStopConditions(
        store.model.stopReason,
        store.model.processedResponse,
        store.persistent.stateRound,
        store.persistent.stateGlobal,
        options.agentSetting,
      );

    const shouldContinue = options.modelHandler.shouldContinue(
      store.model.stopReason,
      store.model.processedResponse,
      options.agentSetting,
    );

    return { shouldEndTurn, shouldStop, shouldContinue };
  }

  async post(
    shared: ResponseCycleShared<C>,
    execRes:
      | { shouldEndTurn: boolean; shouldStop: boolean; shouldContinue: boolean }
      | { skipped: true },
  ): Promise<string | undefined> {
    const { options, store } = shared;
    const groupId = options.logger.getActiveGroupId();

    if ('skipped' in execRes) {
      store.runtime.endTurn = false;
      store.runtime.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    store.runtime.endTurn = execRes.shouldEndTurn;
    store.runtime.shouldStop = execRes.shouldStop;

    if (execRes.shouldStop) {
      return FlowTransition.COMPLETE;
    }

    store.persistent.stateRound.incrementContinuation();
    options.logger.info(
      `Starting continuation #${store.persistent.stateRound.continuationCount}`,
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
        store.persistent.messages,
        store.persistent.stateRound,
        store.persistent.toolState,
        options.agentSetting,
        options.agentConfig,
      );
    } else {
      options.modelHandler.addContinueMessageWithoutPrefill(
        store.persistent.messages,
        store.persistent.stateRound,
        store.persistent.toolState,
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
