// Local imports - latex utils
import { bestConnectionMethod } from '@latex';
import { K_SLICE, REPETITION_DETECTION_THRESHOLD } from '@utils/config';
import { WorkspaceFS } from '@utils/files';
import { getConfig } from '@utils/config';
import { checkForMassiveRepetition } from '@utils/text/repetitionUtils';
import xmlUtils from '@utils/text/xmlUtils';
import replacementEngine from '@replacement/engine';
import { createInfoSpan } from '@agent/modelHandlers/streamUtils';
import { messageToSkeleton } from '@agent/utils/messageUtils';

// Local imports - agent components
import { AgentSetting } from '@agent/core/AgentDataclass';
import { AgentStateRound, AgentStateGlobal } from '@agent/core/AgentState';
import { ToolState } from '@agent/core/ToolState';
import { ModelHandler } from '@agent/modelHandlers';
import { AgentConfig } from '@agent/core/AgentConfig';
import { AgentLogger } from '@logger/AgentLogger';

/**
 * Handles low level response cycles with the model API.
 */
export class ResponseProcessor {
  private abortController: AbortController | null = null;

  constructor(
    private modelHandler: ModelHandler,
    private agentConfig: AgentConfig,
    private agentSetting: AgentSetting,
    private logger: AgentLogger,
    private getSystemPrompt: () => Promise<string>,
    private checkInterruption: () => Promise<boolean>,
  ) {}

  /**
   * Runs a single response cycle until the model indicates the turn is finished.
   */
  public async process(
    client: any,
    messages: any[],
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    toolState: ToolState,
    outputFile: string,
    roundGroupId?: string,
  ): Promise<[AgentStateRound, AgentStateGlobal, ToolState, boolean]> {
    const logGroupId = roundGroupId;
    let endTurn = false;

    while (!endTurn) {
      if (await this.checkInterruption()) {
        break;
      }

      const exists = await WorkspaceFS.exists(outputFile);
      const startTime = Date.now();
      const systemPrompt = await this.getSystemPrompt();

      const shouldSaveMessageObjects = getConfig(
        'debug.saveMessageObjects',
        false,
      );
      if (shouldSaveMessageObjects) {
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

      this.abortController = new AbortController();
      let responseObject: any;
      try {
        responseObject = await this.modelHandler.createResponse(
          client,
          messages,
          this.agentSetting.temperature || 0.0,
          systemPrompt,
          this.agentSetting.endTag,
          this.abortController.signal,
        );
      } finally {
        this.abortController = null;
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

      const [newResponse, responseUsage, stopReason] =
        this.modelHandler.extractResponse(
          responseObject,
          this.agentSetting.endTag,
        );

      this.logger.debug(`Stop reason: ${stopReason}`, logGroupId);
      this.logger.debug(
        `Token usage: ${JSON.stringify(responseUsage)}`,
        logGroupId,
      );

      const thinkingContent = this.modelHandler.processThinkingBlock(
        responseObject,
        logGroupId,
        toolState,
      );

      if (thinkingContent) {
        const formatted = await xmlUtils.formatContent(thinkingContent);
        this.logger.info(createInfoSpan(formatted, 'thinking'), logGroupId);
      }

      const scratchpad = await xmlUtils.extractScratchpad(
        newResponse,
        'scratchpad',
      );
      if (scratchpad) {
        this.logger.info(createInfoSpan(scratchpad, 'scratchpad'), logGroupId);
      }

      const APIUsage = this.modelHandler.computeResponseUsage(
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
        this.logger.error(
          `The new response is (first ${REPETITION_DETECTION_THRESHOLD} chars): ${newResponse.substring(0, REPETITION_DETECTION_THRESHOLD)}`,
          logGroupId,
        );
        this.logger.error(
          'Massive repetition detected - skipping this response',
          logGroupId,
        );
        this.logger.error(
          'Message structure when repetition detected:',
          logGroupId,
        );
        this.logger.error(
          JSON.stringify(messageToSkeleton(messages), null, 2),
          logGroupId,
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

      this.logger.debug('Response preview:', logGroupId);
      this.logger.debug(
        `First ${K_SLICE} chars:\n${processedResponse.slice(0, K_SLICE)}`,
        logGroupId,
      );
      this.logger.debug(
        `Last ${K_SLICE} chars:\n${processedResponse.slice(-K_SLICE)}`,
        logGroupId,
      );

      if (this.modelHandler.capabilities.supportsAssistantPrefill) {
        this.modelHandler.updateMessageContentWithPrefill(
          messages,
          bestConnector,
          processedResponse,
          toolState,
        );
      } else {
        this.modelHandler.updateMessageContentWithoutPrefill(
          messages,
          bestConnector,
          processedResponse,
          toolState,
        );
      }

      const [shouldEndTurn, shouldStop] = this.modelHandler.checkStopConditions(
        stopReason,
        processedResponse,
        stateRound,
        stateGlobal,
        this.agentSetting,
      );
      endTurn = shouldEndTurn;
      if (shouldStop) {
        break;
      }

      stateRound.incrementContinuation();
      this.logger.info(
        `Starting continuation #${stateRound.continuationCount}`,
        logGroupId,
      );

      if (
        this.modelHandler.shouldContinue(
          stopReason,
          processedResponse,
          this.agentSetting,
        )
      ) {
        this.logger.debug(
          'Should continue - adding continuation message to conversation',
          logGroupId,
        );
        if (this.modelHandler.capabilities.supportsAssistantPrefill) {
          this.modelHandler.addContinueMessageWithPrefill(
            messages,
            stateRound,
            toolState,
            this.agentSetting,
            this.agentConfig,
          );
          continue;
        } else {
          this.modelHandler.addContinueMessageWithoutPrefill(
            messages,
            stateRound,
            toolState,
            this.agentSetting,
            this.agentConfig,
          );
          continue;
        }
      }
    }

    return [stateRound, stateGlobal, toolState, endTurn];
  }
}
