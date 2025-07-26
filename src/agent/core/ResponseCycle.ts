// Standard library imports
import * as path from 'path';

// Third-party imports
// (none needed)

// Local imports - log
import { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';

// Local imports - latex utils
import { bestConnectionMethod } from '@latex';

// Local imports - utilities
import { WorkspaceFS } from '@utils/files';
import { StorageFS } from '@utils/files';
import { getRunDir, TASK_RUNS_DIR } from '@utils/files/taskRunStorage';
import { getSystemPromptWithRules } from '@agent/utils/promptHelpers';
import { messageToSkeleton } from '@agent/utils/messageSkeletonUtils';
import { checkForMassiveRepetition } from '@agent/utils/text/repetitionUtils';
import replacementEngine from '@replacement/engine';
import xmlUtils from '@utils/text/xmlUtils';
import type { ExecutionId } from '@agent/types/IdentifierTypes';

// Local imports - agent components
import type { AgentConfig } from './AgentConfig';
import type { AgentSetting, AgentPrompt } from './AgentDataclass';
import { AgentStateRound, AgentStateGlobal } from './AgentState';
import { ToolState } from './ToolState';
import type { IModelHandler } from '@agent/modelHandlers';

// Shared constants
import { K_SLICE, REPETITION_DETECTION_THRESHOLD } from '@utils/config';
import { getConfig } from '@utils/config';

/**
 * Options required to run a single response cycle.
 */
export interface ResponseCycleOptions {
  modelHandler: IModelHandler;
  agentSetting: AgentSetting;
  agentConfig: AgentConfig;
  agentPrompt: AgentPrompt;
  userVars: Record<string, any>;
  logger: AgentLogger;
  client: any;
  checkInterruption: () => Promise<boolean> | boolean;
  setAbortController: (ctrl: AbortController | null) => void;
}

/**
 * Executes a response cycle.
 * @returns Tuple of [round state, global state, tool state, completion flag]
 */
export async function runResponseCycle(
  options: ResponseCycleOptions,
  messages: any[],
  stateRound: AgentStateRound,
  stateGlobal: AgentStateGlobal,
  toolState: ToolState,
  outputFile: string,
  roundGroupId?: string,
  executionId?: ExecutionId,
): Promise<[AgentStateRound, AgentStateGlobal, ToolState, boolean]> {
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

    const shouldSaveMessageObjects = getConfig(
      'debug.saveMessageObjects',
      false,
    );
    if (shouldSaveMessageObjects) {
      const outputFileBaseName = path.basename(outputFile, '.xml');
      const debugFileName = `${outputFileBaseName}_cont${stateRound.continuationCount}.json`;
      const debugFilePath = executionId
        ? path.join(getRunDir(executionId), debugFileName)
        : WorkspaceFS.fullPath(debugFileName);
      try {
        if (executionId) {
          await StorageFS.write(
            debugFilePath,
            JSON.stringify(messages, null, 2),
          );
          logger.info(`Saved message object to ${debugFilePath}`, taskGroupId);
        } else {
          await WorkspaceFS.writeFile(
            WorkspaceFS.relativePath(debugFilePath),
            JSON.stringify(messages, null, 2),
          );
          logger.info(`Saved message object to ${debugFilePath}`, taskGroupId);
        }
      } catch (error) {
        logger.error(`Failed to save message object: ${error}`, taskGroupId);
      }
    }

    const abortController = new AbortController();
    setAbortController(abortController);
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
      setAbortController(null);
    }
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

    if (thinkingContent) {
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
      await WorkspaceFS.writeFile(outputFile, processedResponse);
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

  return [stateRound, stateGlobal, toolState, endTurn];
}
