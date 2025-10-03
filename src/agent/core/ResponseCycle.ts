// Local imports - agent components
import type { AgentConfig } from './AgentConfig';
import type { AgentSetting, AgentPrompt } from './AgentDataclass';
import { AgentStateRound, AgentStateGlobal } from './AgentState';
import { ToolState } from './ToolState';

// Local imports - agent utilities
import type { IModelHandler } from '@agent/modelHandlers';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { ExecutionId } from '@agent/types/IdentifierTypes';
import { maybeSaveDebugObject } from '@agent/utils/debugMessageSaver';
import { messageToSkeleton } from '@agent/utils/messageSkeletonUtils';
import { getSystemPromptWithRules } from '@agent/utils/promptHelpers';
import { checkForMassiveRepetition } from '@agent/utils/text/repetitionUtils';

// Local imports - latex utilities
import { bestConnectionMethod } from '@latex';

// Local imports - logging
import { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import replacementEngine from '@replacement/engine';

// Shared constants
import { K_SLICE, REPETITION_DETECTION_THRESHOLD } from '@utils/config';

// Local imports - filesystem utilities
import { WorkspaceFS } from '@utils/files';
import { getRunDir, TASK_RUNS_DIR } from '@utils/files/taskRunStorage';
import xmlUtils from '@utils/text/xmlUtils';

/**
 * Options required to run a single response cycle.
 */
export interface ResponseCycleOptions<C = unknown> {
  modelHandler: IModelHandler<any, any, any, any, C>;
  agentSetting: AgentSetting;
  agentConfig: AgentConfig;
  agentPrompt: AgentPrompt;
  userVars: Record<string, any>;
  logger: AgentLogger;
  client: C;
  checkInterruption: () => Promise<boolean> | boolean;
  setAbortController: (ctrl: AbortController | null) => void;
}

/**
 * Executes a response cycle.
 * @returns Tuple of [round state, global state, tool state, endTurn, shouldStop]
 */
export async function runResponseCycle<C = unknown>(
  options: ResponseCycleOptions<C>,
  messages: ProviderMessage[],
  stateRound: AgentStateRound,
  stateGlobal: AgentStateGlobal,
  toolState: ToolState,
  outputFile: string,
  roundGroupId?: string,
  executionId?: ExecutionId,
): Promise<[AgentStateRound, AgentStateGlobal, ToolState, boolean, boolean]> {
  const {
    modelHandler,
    agentSetting,
    agentConfig,
    agentPrompt,
    userVars,
    logger,
    client,
    checkInterruption,
    setAbortController,
  } = options;

  const taskGroupId = roundGroupId;

  let endTurn = false;
  let conversationStopped = false;
  while (!endTurn) {
    if (await checkInterruption()) {
      break;
    }

    const exists = await WorkspaceFS.exists(outputFile);
    const startTime = Date.now();
    const systemPrompt = await getSystemPromptWithRules(
      agentPrompt.systemPrompt,
      userVars,
    );

    // Common debug save parameters
    const debugContext = {
      logger,
      modelName: agentConfig.model,
      executionId,
      groupId: taskGroupId,
    };
    const debugFileOptions = {
      continuationCount: stateRound.continuationCount,
      outputFile,
    };

    await maybeSaveDebugObject({
      object: messages,
      objectType: 'messages',
      context: debugContext,
      fileOptions: debugFileOptions,
    });

    const abortController = new AbortController();
    setAbortController(abortController);
    modelHandler.setOutputStreaming(false);
    let responseObject;
    try {
      responseObject = await modelHandler.createResponse(
        client,
        messages,
        agentSetting.temperature || 0.0,
        systemPrompt,
        agentSetting.endTag,
        abortController.signal,
        modelHandler.capabilities.supportsFunctionCalling
          ? agentSetting.tools
          : undefined,
      );
    } finally {
      await maybeSaveDebugObject({
        object: responseObject,
        objectType: 'response',
        context: debugContext,
        fileOptions: debugFileOptions,
      });
      setAbortController(null);
    }
    await maybeSaveDebugObject({
      object: responseObject,
      objectType: 'response',
      context: debugContext,
      fileOptions: debugFileOptions,
    });
    if (!responseObject) {
      logger.warn(
        'Model response was aborted or returned no data; output may be incomplete.',
        taskGroupId,
      );
      break;
    }
    const responseTime = (Date.now() - startTime) / 1000;
    stateRound.updateResponseTime(responseTime);
    logger.debug(`Response time: ${responseTime.toFixed(2)}s`, taskGroupId);

    const [newResponse, responseUsage, stopReason] =
      modelHandler.extractResponse(responseObject, agentSetting.endTag);

    logger.debug(`Stop reason: ${stopReason}`, taskGroupId);
    logger.debug(`Token usage: ${JSON.stringify(responseUsage)}`, taskGroupId);

    const thinkingContent = modelHandler.processThinkingBlock(
      responseObject,
      taskGroupId,
      toolState,
    );
    const useStreaming = modelHandler.getStreamingConfig();

    if (newResponse) {
      logger.debug(`Model response: ${newResponse.slice(0, 100)}`, taskGroupId);
      if (!useStreaming) {
        const formattedResponse = await xmlUtils.formatContent(newResponse);
        logger.info(
          formattedResponse,
          taskGroupId,
          MESSAGE_TYPES.MODEL_RESPONSE,
        );
      }
    }

    // Only log thinking content for non-streaming responses
    // Streaming responses display thinking content progressively via createThinkingStream()
    // so we avoid duplicate logging here
    if (thinkingContent && !useStreaming) {
      const formatted = await xmlUtils.formatContent(thinkingContent);
      logger.info(formatted, taskGroupId, MESSAGE_TYPES.THINKING);
    }

    const scratchpad = await xmlUtils.extractScratchpad(
      newResponse,
      'scratchpad',
    );
    if (scratchpad) {
      logger.info(scratchpad, taskGroupId, MESSAGE_TYPES.SCRATCHPAD);
    }

    const APIUsage = modelHandler.computeResponseUsage(
      responseUsage,
      responseTime,
    );
    stateRound.updateTokenCounts(APIUsage);
    stateGlobal.updateFromCurrRound(stateRound);

    const repetitionResult = checkForMassiveRepetition(
      toolState.lastResponse,
      newResponse,
    );
    if (repetitionResult.massiveRepetitionDetected) {
      logger.error(
        `The new response is (first ${REPETITION_DETECTION_THRESHOLD} chars): ${newResponse.substring(0, REPETITION_DETECTION_THRESHOLD)}`,
        taskGroupId,
      );
      logger.error(
        'Massive repetition detected - skipping this response',
        taskGroupId,
      );
      logger.error('Message structure when repetition detected:', taskGroupId);
      logger.error(
        JSON.stringify(messageToSkeleton(messages), null, 2),
        taskGroupId,
      );
      break;
    }

    const processedResponse = replacementEngine.applyAll(newResponse);
    toolState.updateLastResponse(processedResponse);

    const result = await bestConnectionMethod(
      toolState.lastResponse.slice(-K_SLICE),
      processedResponse.slice(0, K_SLICE),
    );
    const bestConnector = result.connector;

    toolState.updateAccumulatedOutput(
      toolState.accumulatedOutput + bestConnector + processedResponse,
    );

    if (!exists) {
      logger.debug(`Creating new file: ${outputFile}`, taskGroupId);
      await WorkspaceFS.write(outputFile, processedResponse);
    } else {
      logger.debug(`Appending to existing file: ${outputFile}`, taskGroupId);
      await WorkspaceFS.appendFile(
        outputFile,
        bestConnector + processedResponse,
      );
    }

    logger.debug('Response preview:', taskGroupId);
    logger.debug(
      `First ${K_SLICE} chars:\n${processedResponse.slice(0, K_SLICE)}`,
      taskGroupId,
    );
    logger.debug(
      `Last ${K_SLICE} chars:\n${processedResponse.slice(-K_SLICE)}`,
      taskGroupId,
    );

    if (modelHandler.capabilities.supportsAssistantPrefill) {
      modelHandler.updateMessageContentWithPrefill(
        messages,
        bestConnector,
        processedResponse,
        toolState,
      );
    } else {
      modelHandler.updateMessageContentWithoutPrefill(
        messages,
        bestConnector,
        processedResponse,
        toolState,
      );
    }

    const [shouldEndTurn, shouldStop] = modelHandler.checkStopConditions(
      stopReason,
      processedResponse,
      stateRound,
      stateGlobal,
      agentSetting,
    );
    endTurn = shouldEndTurn;
    if (shouldStop) {
      conversationStopped = true;
      break;
    }

    stateRound.incrementContinuation();
    logger.info(
      `Starting continuation #${stateRound.continuationCount}`,
      taskGroupId,
    );

    if (
      modelHandler.shouldContinue(stopReason, processedResponse, agentSetting)
    ) {
      logger.debug(
        'Should continue - adding continuation message to conversation',
        taskGroupId,
      );
      if (modelHandler.capabilities.supportsAssistantPrefill) {
        modelHandler.addContinueMessageWithPrefill(
          messages,
          stateRound,
          toolState,
          agentSetting,
          agentConfig,
        );
        continue;
      } else {
        modelHandler.addContinueMessageWithoutPrefill(
          messages,
          stateRound,
          toolState,
          agentSetting,
          agentConfig,
        );
        continue;
      }
    }
  }

  return [stateRound, stateGlobal, toolState, endTurn, conversationStopped];
}
