// Local imports - agent

// Local imports - agent components
import type { AgentConfig } from './AgentConfig';
import type { AgentSetting, AgentPrompt } from './AgentDataclass';
import { AgentStateRound, AgentStateGlobal } from './AgentState';
import { ToolState } from './ToolState';
import type { IModelHandler } from '@agent/modelHandlers';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { ExecutionId } from '@agent/types/IdentifierTypes';
import { maybeSaveDebugObject } from '@agent/utils/debugMessageSaver';
import { messageToSkeleton } from '@agent/utils/messageSkeletonUtils';
import { getSystemPromptWithRules } from '@agent/utils/promptHelpers';
import { checkForMassiveRepetition } from '@agent/utils/text/repetitionUtils';
import { BaseNode } from '@agent/node';

// Local imports - latex utils
import { bestConnectionMethod } from '@latex';
// Standard library imports

// Third-party imports
// (none needed)

// Local imports - log
import { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import replacementEngine from '@replacement/engine';

// Shared constants
import { K_SLICE, REPETITION_DETECTION_THRESHOLD } from '@utils/config';

// Local imports - utilities
import { WorkspaceFS } from '@utils/files';
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

interface ResponseIterationResult {
  endTurn: boolean;
  shouldStop: boolean;
}

interface ResponseIterationSharedContext<C> {
  messages: ProviderMessage[];
  stateRound: AgentStateRound;
  stateGlobal: AgentStateGlobal;
  toolState: ToolState;
  outputFile: string;
  roundGroupId?: string;
  iterationResult?: ResponseIterationResult;
}

interface DebugContext {
  logger: AgentLogger;
  modelName: string;
  executionId?: ExecutionId;
  groupId?: string;
}

interface DebugFileOptions {
  continuationCount: number;
  outputFile: string;
}

interface ResponseIterationPrepResult {
  exists: boolean;
  startTime: number;
  systemPrompt: string;
  debugContext: DebugContext;
  debugFileOptions: DebugFileOptions;
  abortController: AbortController;
}

function createResponseIterationNode<C>(
  options: ResponseCycleOptions<C>,
  executionId?: ExecutionId,
): BaseNode<ResponseIterationSharedContext<C>> {
  const {
    modelHandler,
    agentSetting,
    agentConfig,
    agentPrompt,
    userVars,
    logger,
    client,
  } = options;

  return new (class extends BaseNode<ResponseIterationSharedContext<C>> {
    private shared!: ResponseIterationSharedContext<C>;

    async prep(
      shared: ResponseIterationSharedContext<C>,
    ): Promise<ResponseIterationPrepResult> {
      this.shared = shared;
      shared.iterationResult = undefined;

      const exists = await WorkspaceFS.exists(shared.outputFile);
      const startTime = Date.now();
      const systemPrompt = await getSystemPromptWithRules(
        agentPrompt.systemPrompt,
        userVars,
      );

      const debugContext: DebugContext = {
        logger,
        modelName: agentConfig.model,
        executionId,
        groupId: shared.roundGroupId,
      };
      const debugFileOptions: DebugFileOptions = {
        continuationCount: shared.stateRound.continuationCount,
        outputFile: shared.outputFile,
      };

      await maybeSaveDebugObject({
        object: shared.messages,
        objectType: 'messages',
        context: debugContext,
        fileOptions: debugFileOptions,
      });

      const abortController = new AbortController();
      options.setAbortController(abortController);
      modelHandler.setOutputStreaming(false);

      return {
        exists,
        startTime,
        systemPrompt,
        debugContext,
        debugFileOptions,
        abortController,
      };
    }

    async exec(prepRes: ResponseIterationPrepResult): Promise<any> {
      const { abortController, systemPrompt, debugContext, debugFileOptions } =
        prepRes;
      let responseObject: any;
      try {
        responseObject = await modelHandler.createResponse(
          client,
          this.shared.messages,
          agentSetting.temperature || 0.0,
          systemPrompt,
          agentSetting.endTag,
          abortController.signal,
          modelHandler.capabilities.supportsFunctionCalling
            ? agentSetting.tools
            : undefined,
        );
        return responseObject;
      } finally {
        await maybeSaveDebugObject({
          object: responseObject,
          objectType: 'response',
          context: debugContext,
          fileOptions: debugFileOptions,
        });
        options.setAbortController(null);
      }
    }

    async post(
      shared: ResponseIterationSharedContext<C>,
      prepRes: ResponseIterationPrepResult,
      responseObject: any,
    ): Promise<string | undefined> {
      await maybeSaveDebugObject({
        object: responseObject,
        objectType: 'response',
        context: prepRes.debugContext,
        fileOptions: prepRes.debugFileOptions,
      });

      const taskGroupId = shared.roundGroupId;

      if (!responseObject) {
        logger.warn(
          'Model response was aborted or returned no data; output may be incomplete.',
          taskGroupId,
        );
        shared.iterationResult = { endTurn: false, shouldStop: true };
        return 'default';
      }

      const responseTime = (Date.now() - prepRes.startTime) / 1000;
      shared.stateRound.updateResponseTime(responseTime);
      logger.debug(`Response time: ${responseTime.toFixed(2)}s`, taskGroupId);

      const [newResponse, responseUsage, stopReason] =
        modelHandler.extractResponse(responseObject, agentSetting.endTag);

      logger.debug(`Stop reason: ${stopReason}`, taskGroupId);
      logger.debug(
        `Token usage: ${JSON.stringify(responseUsage)}`,
        taskGroupId,
      );

      const thinkingContent = modelHandler.processThinkingBlock(
        responseObject,
        taskGroupId,
        shared.toolState,
      );
      const useStreaming = modelHandler.getStreamingConfig();

      if (newResponse) {
        logger.debug(
          `Model response: ${newResponse.slice(0, 100)}`,
          taskGroupId,
        );
        if (!useStreaming) {
          const formattedResponse = await xmlUtils.formatContent(newResponse);
          logger.info(
            formattedResponse,
            taskGroupId,
            MESSAGE_TYPES.MODEL_RESPONSE,
          );
        }
      }

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
      shared.stateRound.updateTokenCounts(APIUsage);
      shared.stateGlobal.updateFromCurrRound(shared.stateRound);

      const repetitionResult = checkForMassiveRepetition(
        shared.toolState.lastResponse,
        newResponse,
      );
      if (repetitionResult.massiveRepetitionDetected) {
        logger.error(
          `The new response is (first ${REPETITION_DETECTION_THRESHOLD} chars): ${newResponse.substring(
            0,
            REPETITION_DETECTION_THRESHOLD,
          )}`,
          taskGroupId,
        );
        logger.error(
          'Massive repetition detected - skipping this response',
          taskGroupId,
        );
        logger.error(
          'Message structure when repetition detected:',
          taskGroupId,
        );
        logger.error(
          JSON.stringify(messageToSkeleton(shared.messages), null, 2),
          taskGroupId,
        );
        shared.iterationResult = { endTurn: false, shouldStop: true };
        return 'default';
      }

      const processedResponse = replacementEngine.applyAll(newResponse);
      shared.toolState.updateLastResponse(processedResponse);

      const result = await bestConnectionMethod(
        shared.toolState.lastResponse.slice(-K_SLICE),
        processedResponse.slice(0, K_SLICE),
      );
      const bestConnector = result.connector;

      shared.toolState.updateAccumulatedOutput(
        shared.toolState.accumulatedOutput + bestConnector + processedResponse,
      );

      if (!prepRes.exists) {
        logger.debug(`Creating new file: ${shared.outputFile}`, taskGroupId);
        await WorkspaceFS.write(shared.outputFile, processedResponse);
      } else {
        logger.debug(
          `Appending to existing file: ${shared.outputFile}`,
          taskGroupId,
        );
        await WorkspaceFS.appendFile(
          shared.outputFile,
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
          shared.messages,
          bestConnector,
          processedResponse,
          shared.toolState,
        );
      } else {
        modelHandler.updateMessageContentWithoutPrefill(
          shared.messages,
          bestConnector,
          processedResponse,
          shared.toolState,
        );
      }

      const [shouldEndTurn, shouldStop] = modelHandler.checkStopConditions(
        stopReason,
        processedResponse,
        shared.stateRound,
        shared.stateGlobal,
        agentSetting,
      );
      shared.iterationResult = { endTurn: shouldEndTurn, shouldStop };
      if (shouldStop) {
        return 'default';
      }

      shared.stateRound.incrementContinuation();
      logger.info(
        `Starting continuation #${shared.stateRound.continuationCount}`,
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
            shared.messages,
            shared.stateRound,
            shared.toolState,
            agentSetting,
            agentConfig,
          );
        } else {
          modelHandler.addContinueMessageWithoutPrefill(
            shared.messages,
            shared.stateRound,
            shared.toolState,
            agentSetting,
            agentConfig,
          );
        }
      }

      return 'default';
    }
  })();
}

/**
 * Executes a response cycle.
 * @returns Tuple of [round state, global state, tool state, completion flag]
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
): Promise<[AgentStateRound, AgentStateGlobal, ToolState, boolean]> {
  const { checkInterruption } = options;
  const shared: ResponseIterationSharedContext<C> = {
    messages,
    stateRound,
    stateGlobal,
    toolState,
    outputFile,
    roundGroupId,
  };
  const iterationNode = createResponseIterationNode(options, executionId);

  let endTurn = false;
  while (!endTurn) {
    if (await checkInterruption()) {
      break;
    }

    await iterationNode.run(shared);
    const iteration = shared.iterationResult;
    if (!iteration) {
      break;
    }

    endTurn = iteration.endTurn;
    if (iteration.shouldStop) {
      break;
    }
  }

  return [shared.stateRound, shared.stateGlobal, shared.toolState, endTurn];
}
