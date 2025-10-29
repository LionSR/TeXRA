// Local imports - core flow primitives
import { BaseNode, Flow } from '@agent/node';

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
  groupId?: string;
}

interface DebugFileOptions {
  continuationCount: number;
  outputFile: string;
}

async function saveDebugObjectIfConfigured(
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

function resetResponseCycleState(cycle: ResponseCycleState): void {
  cycle.shouldStop = false;
  cycle.endTurn = false;
  cycle.responseObject = undefined;
  cycle.responseTime = undefined;
  cycle.stopReason = undefined;
  cycle.processedResponse = undefined;
}

export interface ResponseCycleState {
  messages: ProviderMessage[];
  stateRound: AgentStateRound;
  stateGlobal: AgentStateGlobal;
  toolState: ToolState;
  outputFile: string;
  roundGroupId?: string;
  executionId?: ExecutionId;
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

export interface ResponseCycleShared<C = unknown> {
  options: ResponseCycleOptions<C>;
  cycle: ResponseCycleState;
}

interface ResponseExecutionContext<C> {
  options: ResponseCycleOptions<C>;
  cycle: ResponseCycleState;
}

class ResponsePrepNode<C> extends BaseNode<ResponseCycleShared<C>> {
  async prep(shared: ResponseCycleShared<C>): Promise<{
    interrupted: boolean;
    exists: boolean;
    systemPrompt?: string;
    debugContext?: DebugContext;
    debugFileOptions?: DebugFileOptions;
  }> {
    const { options, cycle } = shared;
    const { agentPrompt, userVars, logger, agentConfig } = options;
    const interrupted = Boolean(await options.checkInterruption());
    const exists = await WorkspaceFS.exists(cycle.outputFile);
    const systemPrompt = interrupted
      ? undefined
      : await getSystemPromptWithRules(agentPrompt.systemPrompt, userVars);

    const debugContext: DebugContext | undefined = interrupted
      ? undefined
      : {
          logger,
          modelName: agentConfig.model,
          executionId: cycle.executionId,
          groupId: cycle.roundGroupId,
        };

    const debugFileOptions: DebugFileOptions | undefined = interrupted
      ? undefined
      : {
          continuationCount: cycle.stateRound.continuationCount,
          outputFile: cycle.outputFile,
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
    _shared: ResponseCycleShared<C>,
    prepRes: {
      interrupted: boolean;
      exists: boolean;
      systemPrompt?: string;
      debugContext?: DebugContext;
      debugFileOptions?: DebugFileOptions;
    },
  ): Promise<string | undefined> {
    const { cycle } = _shared;
    if (prepRes.interrupted) {
      cycle.shouldStop = true;
      return 'complete';
    }

    cycle.outputExists = prepRes.exists;
    cycle.systemPrompt = prepRes.systemPrompt;
    cycle.debugContext = prepRes.debugContext;
    cycle.debugFileOptions = prepRes.debugFileOptions;
    cycle.startTime = Date.now();
    resetResponseCycleState(cycle);

    await saveDebugObjectIfConfigured(
      cycle.debugContext,
      cycle.debugFileOptions,
      cycle.messages,
      'messages',
    );

    return undefined;
  }
}

class ResponseModelInvocationNode<C> extends BaseNode<ResponseCycleShared<C>> {
  async prep(shared: ResponseCycleShared<C>): Promise<ResponseExecutionContext<C>> {
    return {
      options: shared.options,
      cycle: shared.cycle,
    };
  }

  async exec(
    context: ResponseExecutionContext<C>,
  ): Promise<{ skipped: true } | { response: unknown; responseTime?: number }> {
    const { options, cycle } = context;
    if (cycle.shouldStop) {
      return { skipped: true };
    }

    const abortController = new AbortController();
    options.setAbortController(abortController);
    options.modelHandler.setOutputStreaming(false);

    let response: unknown;
    try {
      response = await options.modelHandler.createResponse(
        options.client,
        cycle.messages,
        options.agentSetting.temperature || 0.0,
        cycle.systemPrompt,
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
      options.logger.error(message, cycle.roundGroupId);
      throw error;
    } finally {
      options.setAbortController(null);
    }

    const responseTime = cycle.startTime
      ? (Date.now() - cycle.startTime) / 1000
      : undefined;

    return { response, responseTime };
  }

  async post(
    _shared: ResponseCycleShared<C>,
    prepRes: ResponseExecutionContext<C>,
    execRes: { skipped: true } | { response: unknown; responseTime?: number },
  ): Promise<string | undefined> {
    const { options, cycle } = prepRes;

    if ('skipped' in execRes) {
      return 'complete';
    }

    cycle.responseObject = execRes.response;
    cycle.responseTime = execRes.responseTime;

    await saveDebugObjectIfConfigured(
      cycle.debugContext,
      cycle.debugFileOptions,
      execRes.response,
      'response',
    );

    if (!execRes.response) {
      options.logger.warn(
        'Model response was aborted or returned no data; output may be incomplete.',
        cycle.roundGroupId,
      );
      cycle.shouldStop = true;
      return 'complete';
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

class ResponseProcessNode<C> extends BaseNode<ResponseCycleShared<C>> {
  async prep(shared: ResponseCycleShared<C>): Promise<ResponseExecutionContext<C>> {
    return {
      options: shared.options,
      cycle: shared.cycle,
    };
  }

  async exec(
    context: ResponseExecutionContext<C>,
  ): Promise<ProcessResult | { skipped: true }> {
    const { options, cycle } = context;
    if (cycle.shouldStop || !cycle.responseObject) {
      return { skipped: true };
    }

    const [newResponse, responseUsage, stopReason] =
      options.modelHandler.extractResponse(
        cycle.responseObject,
        options.agentSetting.endTag,
      );

    if (newResponse) {
      options.logger.debug(
        `Model response: ${newResponse.slice(0, 100)}`,
        cycle.roundGroupId,
      );
    }

    if (cycle.responseTime !== undefined) {
      cycle.stateRound.updateResponseTime(cycle.responseTime);
      options.logger.debug(
        `Response time: ${cycle.responseTime.toFixed(2)}s`,
        cycle.roundGroupId,
      );
    }

    options.logger.debug(`Stop reason: ${stopReason}`, cycle.roundGroupId);
    options.logger.debug(
      `Token usage: ${JSON.stringify(responseUsage)}`,
      cycle.roundGroupId,
    );

    const thinkingContent = options.modelHandler.processThinkingBlock(
      cycle.responseObject,
      cycle.roundGroupId,
      cycle.toolState,
    );
    const useStreaming = options.modelHandler.getStreamingConfig();

    if (thinkingContent && !useStreaming) {
      const formatted = await xmlUtils.formatContent(thinkingContent);
      if (formatted.trim().length > 0) {
        options.logger.info(
          formatted,
          cycle.roundGroupId,
          MESSAGE_TYPES.THINKING,
        );
      }
    }

    const scratchpad = await xmlUtils.extractScratchpad(
      newResponse,
      'scratchpad',
    );
    if (scratchpad) {
      options.logger.info(
        scratchpad,
        cycle.roundGroupId,
        MESSAGE_TYPES.SCRATCHPAD,
      );
    }

    if (newResponse && !useStreaming) {
      const formattedResponse = await xmlUtils.formatContent(newResponse);
      options.logger.info(
        formattedResponse,
        cycle.roundGroupId,
        MESSAGE_TYPES.INTERNAL,
      );
    }

    const apiUsage = options.modelHandler.computeResponseUsage(
      responseUsage,
      cycle.responseTime ?? 0,
    );
    cycle.stateRound.updateTokenCounts(apiUsage);
    cycle.stateGlobal.updateFromCurrRound(cycle.stateRound);

    const repetitionResult = checkForMassiveRepetition(
      cycle.toolState.lastResponse,
      newResponse,
    );

    if (repetitionResult.massiveRepetitionDetected && newResponse) {
      options.logger.error(
        `The new response is (first ${REPETITION_DETECTION_THRESHOLD} chars): ${newResponse.substring(0, REPETITION_DETECTION_THRESHOLD)}`,
        cycle.roundGroupId,
      );
      options.logger.error(
        'Massive repetition detected - skipping this response',
        cycle.roundGroupId,
      );
      options.logger.error(
        'Message structure when repetition detected:',
        cycle.roundGroupId,
      );
      options.logger.error(
        JSON.stringify(messageToSkeleton(cycle.messages), null, 2),
        cycle.roundGroupId,
      );
    }

    let processedResponse: string | undefined;
    let bestConnector: string | undefined;
    if (newResponse) {
      processedResponse = replacementEngine.applyAll(newResponse);
      const connector = await bestConnectionMethod(
        cycle.toolState.lastResponse.slice(-K_SLICE),
        processedResponse.slice(0, K_SLICE),
      );
      bestConnector = connector.connector;
      cycle.toolState.updateLastResponse(processedResponse);
      cycle.toolState.updateAccumulatedOutput(
        cycle.toolState.accumulatedOutput +
          (bestConnector ?? '') +
          processedResponse,
      );
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
    prepRes: ResponseExecutionContext<C>,
    execRes: ProcessResult | { skipped: true },
  ): Promise<string | undefined> {
    const { options, cycle } = prepRes;

    if ('skipped' in execRes) {
      return 'complete';
    }

    cycle.stopReason = execRes.stopReason;
    cycle.processedResponse = execRes.processedResponse;

    if (execRes.repetitionDetected || !execRes.processedResponse) {
      cycle.shouldStop = true;
      return 'complete';
    }

    if (!cycle.outputExists) {
      options.logger.debug(
        `Creating new file: ${cycle.outputFile}`,
        cycle.roundGroupId,
      );
      await WorkspaceFS.write(cycle.outputFile, execRes.processedResponse);
      cycle.outputExists = true;
    } else {
      options.logger.debug(
        `Appending to existing file: ${cycle.outputFile}`,
        cycle.roundGroupId,
      );
      await WorkspaceFS.appendFile(
        cycle.outputFile,
        (execRes.bestConnector ?? '') + execRes.processedResponse,
      );
    }

    options.logger.debug('Response preview:', cycle.roundGroupId);
    options.logger.debug(
      `First ${K_SLICE} chars:\n${execRes.processedResponse.slice(0, K_SLICE)}`,
      cycle.roundGroupId,
    );
    options.logger.debug(
      `Last ${K_SLICE} chars:\n${execRes.processedResponse.slice(-K_SLICE)}`,
      cycle.roundGroupId,
    );

    if (options.modelHandler.capabilities.supportsAssistantPrefill) {
      options.modelHandler.updateMessageContentWithPrefill(
        cycle.messages,
        execRes.bestConnector ?? '',
        execRes.processedResponse,
        cycle.toolState,
      );
    } else {
      options.modelHandler.updateMessageContentWithoutPrefill(
        cycle.messages,
        execRes.bestConnector ?? '',
        execRes.processedResponse,
        cycle.toolState,
      );
    }

    return undefined;
  }
}

class ResponseContinuationNode<C> extends BaseNode<ResponseCycleShared<C>> {
  async prep(shared: ResponseCycleShared<C>): Promise<ResponseExecutionContext<C>> {
    return {
      options: shared.options,
      cycle: shared.cycle,
    };
  }

  async exec(
    context: ResponseExecutionContext<C>,
  ): Promise<
    | { shouldEndTurn: boolean; shouldStop: boolean; shouldContinue: boolean }
    | { skipped: true }
  > {
    const { options, cycle } = context;
    if (cycle.shouldStop || !cycle.stopReason || !cycle.processedResponse) {
      return { skipped: true };
    }

    const [shouldEndTurn, shouldStop] =
      options.modelHandler.checkStopConditions(
        cycle.stopReason,
        cycle.processedResponse,
        cycle.stateRound,
        cycle.stateGlobal,
        options.agentSetting,
      );

    const shouldContinue = options.modelHandler.shouldContinue(
      cycle.stopReason,
      cycle.processedResponse,
      options.agentSetting,
    );

    return { shouldEndTurn, shouldStop, shouldContinue };
  }

  async post(
    shared: ResponseCycleShared<C>,
    prepRes: ResponseExecutionContext<C>,
    execRes:
      | { shouldEndTurn: boolean; shouldStop: boolean; shouldContinue: boolean }
      | { skipped: true },
  ): Promise<string | undefined> {
    const { options, cycle } = prepRes;

    if ('skipped' in execRes) {
      cycle.shouldStop = true;
      return 'complete';
    }

    cycle.endTurn = execRes.shouldEndTurn;
    cycle.shouldStop = execRes.shouldStop;

    if (execRes.shouldStop) {
      return 'complete';
    }

    cycle.stateRound.incrementContinuation();
    options.logger.info(
      `Starting continuation #${cycle.stateRound.continuationCount}`,
      cycle.roundGroupId,
      MESSAGE_TYPES.PROGRESS_STATUS,
    );

    if (!execRes.shouldContinue) {
      return 'complete';
    }

    options.logger.debug(
      'Should continue - adding continuation message to conversation',
      cycle.roundGroupId,
    );

    if (options.modelHandler.capabilities.supportsAssistantPrefill) {
      options.modelHandler.addContinueMessageWithPrefill(
        cycle.messages,
        cycle.stateRound,
        cycle.toolState,
        options.agentSetting,
        options.agentConfig,
      );
    } else {
      options.modelHandler.addContinueMessageWithoutPrefill(
        cycle.messages,
        cycle.stateRound,
        cycle.toolState,
        options.agentSetting,
        options.agentConfig,
      );
    }

    return 'continue';
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

  continuationNode.on('continue', prepNode);

  return new Flow<ResponseCycleShared<C>>(prepNode);
}
