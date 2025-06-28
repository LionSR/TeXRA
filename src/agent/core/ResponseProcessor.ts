// Third-party imports
// (none needed)

// Local imports - log
import { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';

// Local imports - agent components
import { AgentConfig } from './AgentConfig';
import { AgentSetting } from './AgentDataclass';
import { AgentStateRound, AgentStateGlobal } from './AgentState';
import { ToolState } from './ToolState';
import type { IModelHandler } from '../modelHandlers';
import { 
  MessageManager, 
  ResponseUpdateParams, 
  ContinuationParams 
} from './MessageManager';

// Local imports - utilities
import { WorkspaceFS } from '@utils/files';
import { getConfig } from '@utils/config';
import { checkForMassiveRepetition } from '@agent/utils/text/repetitionUtils';
import { messageToSkeleton } from '@agent/utils/messageSkeletonUtils';
import { bestConnectionMethod } from '@latex';
import { getSystemPromptWithRules } from '@agent/utils/promptHelpers';
import replacementEngine from '@replacement/engine';
import xmlUtils from '@utils/text/xmlUtils';

// Shared constants
import { K_SLICE, REPETITION_DETECTION_THRESHOLD } from '@utils/config';

/**
 * Configuration for a response processing request
 */
export interface ResponseRequest {
  messages: any[];
  outputFile: string;
  systemPrompt: string;
  userVars: Record<string, any>;
  client: any;
  agentSetting: AgentSetting;
  agentConfig: AgentConfig;
  logGroupId?: string;
}

/**
 * Context needed for response processing
 */
export interface ProcessingContext {
  checkInterruption: () => boolean;
  setAbortController: (controller: AbortController | null) => void;
  logger: AgentLogger;
}

/**
 * Result of response processing
 */
export interface ResponseResult {
  stateRound: AgentStateRound;
  stateGlobal: AgentStateGlobal;
  toolState: ToolState;
  endTurn: boolean;
}

/**
 * Handles the core response cycle logic that's common to ALL agents.
 * This class encapsulates the essential response processing that's needed by
 * reflection agents, tool use agents, and any future agent types.
 */
export class ResponseProcessor {
  constructor(
    private modelHandler: IModelHandler,
    private messageManager: MessageManager,
    private logger: AgentLogger,
  ) {}

  /**
   * Processes a complete response cycle with model interaction.
   * This is the core logic extracted from BaseReflectionAgent.processResponseCycle
   * that can be used by any agent type.
   */
  async processResponseCycle(
    request: ResponseRequest,
    context: ProcessingContext,
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    toolState: ToolState,
  ): Promise<ResponseResult> {
    const { messages, outputFile, agentSetting, agentConfig, logGroupId } = request;

    try {
      let endTurn = false;
      while (!endTurn) {
        // Check for interruption before each cycle
        if (context.checkInterruption()) {
          break;
        }

        const exists = await WorkspaceFS.exists(outputFile);
        const startTime = Date.now();
        const systemPrompt = await getSystemPromptWithRules(
          request.systemPrompt,
          request.userVars,
        );

        // Save message object to file for debugging if enabled in settings
        const shouldSaveMessageObjects = getConfig(
          'debug.saveMessageObjects',
          false,
        );
        if (shouldSaveMessageObjects) {
          await this.saveDebugMessages(messages, outputFile, stateRound, logGroupId);
        }

        // Create abort controller and make model request
        const abortController = new AbortController();
        context.setAbortController(abortController);
        let responseObject;
        
        try {
          responseObject = await this.modelHandler.createResponse(
            request.client,
            messages,
            agentSetting.temperature || 0.0,
            systemPrompt,
            agentSetting.endTag,
            abortController.signal,
            this.modelHandler.capabilities.supportsFunctionCalling
              ? agentSetting.tools
              : undefined,
          );
        } finally {
          context.setAbortController(null);
        }

        if (!responseObject) {
          this.logger.warn(
            'Model response was aborted or returned no data; output may be incomplete.',
            logGroupId,
          );
          break;
        }

        const responseTime = (Date.now() - startTime) / 1000;
        stateRound.updateResponseTime(responseTime);
        this.logger.debug(
          `Response time: ${responseTime.toFixed(2)}s`,
          logGroupId,
        );

        // Extract and validate response
        const [newResponse, responseUsage, stopReason] =
          this.modelHandler.extractResponse(responseObject, agentSetting.endTag);

        this.logger.debug(`Stop reason: ${stopReason}`, logGroupId);
        this.logger.debug(
          `Token usage: ${JSON.stringify(responseUsage)}`,
          logGroupId,
        );

        // Process thinking and scratchpad content
        await this.processThinkingAndScratchpad(responseObject, newResponse, toolState, logGroupId);

        // Compute statistics and update states
        const APIUsage = this.modelHandler.computeResponseUsage(
          responseUsage,
          responseTime,
        );
        stateRound.updateTokenCounts(APIUsage);
        stateGlobal.updateFromCurrRound(stateRound);

        // Check for massive repetition
        if (this.checkMassiveRepetition(toolState.lastResponse, newResponse, messages, logGroupId)) {
          break;
        }

        // Process and connect response
        const processedResponse = replacementEngine.applyAll(newResponse);
        toolState.updateLastResponse(processedResponse);

        const result = await bestConnectionMethod(
          toolState.lastResponse.slice(-K_SLICE),
          processedResponse.slice(0, K_SLICE),
        );
        const bestConnector = result.connector;

        // Update state and file
        toolState.updateAccumulatedOutput(
          toolState.accumulatedOutput + bestConnector + processedResponse,
        );

        await this.writeOrAppendOutput(
          outputFile, 
          processedResponse, 
          bestConnector, 
          exists, 
          logGroupId
        );

        // Log response preview
        this.logResponsePreview(processedResponse, logGroupId);

        // Update message content
        this.updateMessageContent(messages, bestConnector, processedResponse, toolState);

        // Check stop conditions
        const [shouldEndTurn, shouldStop] = this.modelHandler.checkStopConditions(
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

        // Handle continuation
        stateRound.incrementContinuation();
        this.logger.info(
          `Starting continuation #${stateRound.continuationCount}`,
          logGroupId,
        );

        // Check if model should continue generating
        if (this.shouldContinueGeneration(stopReason, processedResponse, agentSetting)) {
          this.addContinuationMessage(messages, stateRound, toolState, agentSetting, agentConfig, logGroupId);
          continue;
        }
      }

      return {
        stateRound,
        stateGlobal,
        toolState,
        endTurn,
      };
    } catch (error) {
      throw error;
    }
  }

  private async saveDebugMessages(
    messages: any[],
    outputFile: string,
    stateRound: AgentStateRound,
    logGroupId?: string,
  ): Promise<void> {
    const outputFileBaseName = outputFile.replace('.xml', '');
    const debugFilePath = `${outputFileBaseName}_cont${stateRound.continuationCount}.json`;
    try {
      await WorkspaceFS.writeFile(
        debugFilePath,
        JSON.stringify(messages, null, 2),
      );
      this.logger.info(
        `Saved message object to ${debugFilePath}`,
        logGroupId,
      );
    } catch (error) {
      this.logger.error(
        `Failed to save message object: ${error}`,
        logGroupId,
      );
    }
  }

  private async processThinkingAndScratchpad(
    responseObject: any,
    newResponse: string,
    toolState: ToolState,
    logGroupId?: string,
  ): Promise<void> {
    // Extract thinking blocks directly from the response object
    const thinkingContent = this.modelHandler.processThinkingBlock(
      responseObject,
      logGroupId,
      toolState,
    );

    if (thinkingContent) {
      const formatted = await xmlUtils.formatContent(thinkingContent);
      this.logger.info(formatted, logGroupId, MESSAGE_TYPES.THINKING);
    }

    // Extract scratchpad content directly from the response text
    const scratchpad = await xmlUtils.extractScratchpad(
      newResponse,
      'scratchpad',
    );
    if (scratchpad) {
      this.logger.info(scratchpad, logGroupId, MESSAGE_TYPES.SCRATCHPAD);
    }
  }

  private checkMassiveRepetition(
    lastResponse: string,
    newResponse: string,
    messages: any[],
    logGroupId?: string,
  ): boolean {
    const repetitionResult = checkForMassiveRepetition(lastResponse, newResponse);
    if (repetitionResult.massiveRepetitionDetected) {
      this.logger.error(
        `The new response is (first ${REPETITION_DETECTION_THRESHOLD} chars): ${newResponse.substring(0, REPETITION_DETECTION_THRESHOLD)}`,
        logGroupId,
      );
      this.logger.error(
        `Massive repetition detected - skipping this response`,
        logGroupId,
      );

      // Debug information - print message skeleton to help diagnose the problem
      this.logger.error(
        `Message structure when repetition detected:`,
        logGroupId,
      );
      this.logger.error(
        JSON.stringify(messageToSkeleton(messages), null, 2),
        logGroupId,
      );
      return true;
    }
    return false;
  }

  private async writeOrAppendOutput(
    outputFile: string,
    processedResponse: string,
    bestConnector: string,
    exists: boolean,
    logGroupId?: string,
  ): Promise<void> {
    if (!exists) {
      this.logger.debug(`Creating new file: ${outputFile}`, logGroupId);
      await WorkspaceFS.writeFile(outputFile, processedResponse);
    } else {
      this.logger.debug(
        `Appending to existing file: ${outputFile}`,
        logGroupId,
      );
      await WorkspaceFS.appendFile(
        outputFile,
        bestConnector + processedResponse,
      );
    }
  }

  private logResponsePreview(processedResponse: string, logGroupId?: string): void {
    this.logger.debug(`Response preview:`, logGroupId);
    this.logger.debug(
      `First ${K_SLICE} chars:\n${processedResponse.slice(0, K_SLICE)}`,
      logGroupId,
    );
    this.logger.debug(
      `Last ${K_SLICE} chars:\n${processedResponse.slice(-K_SLICE)}`,
      logGroupId,
    );
  }

  private updateMessageContent(
    messages: any[],
    bestConnector: string,
    processedResponse: string,
    toolState: ToolState,
  ): void {
    const updateParams: ResponseUpdateParams = {
      bestConnector,
      newResponse: processedResponse,
      toolState,
    };
    this.messageManager.updateWithResponse(messages, updateParams);
  }

  private shouldContinueGeneration(
    stopReason: any,
    processedResponse: string,
    agentSetting: AgentSetting,
  ): boolean {
    return this.messageManager.shouldContinueGeneration(
      stopReason,
      processedResponse,
      agentSetting,
    );
  }

  private addContinuationMessage(
    messages: any[],
    stateRound: AgentStateRound,
    toolState: ToolState,
    agentSetting: AgentSetting,
    agentConfig: AgentConfig,
    logGroupId?: string,
  ): void {
    const continuationParams: ContinuationParams = {
      stateRound,
      toolState,
      agentSetting,
      agentConfig,
    };
    this.messageManager.addContinuationMessage(messages, continuationParams, logGroupId);
  }
}