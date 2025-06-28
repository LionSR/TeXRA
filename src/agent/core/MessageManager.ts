// Local imports - agent components
import { AgentConfig } from './AgentConfig';
import { AgentSetting } from './AgentDataclass';
import { AgentStateRound } from './AgentState';
import { ToolState } from './ToolState';
import type { IModelHandler } from '../modelHandlers';



// Local imports - log
import { AgentLogger } from '@logger/AgentLogger';

/**
 * Parameters for initializing conversation messages
 */
export interface MessageInitParams {
  userPrefix: string;
  userRequest: string;
  mediaFiles?: string[];
  systemPrompt?: string;
}

/**
 * Parameters for adding round messages
 */
export interface RoundMessageParams {
  userMessage: string;
  mediaFiles?: string[];
}

/**
 * Parameters for continuation messages
 */
export interface ContinuationParams {
  stateRound: AgentStateRound;
  toolState: ToolState;
  agentSetting: AgentSetting;
  agentConfig: AgentConfig;
}

/**
 * Parameters for updating messages with response
 */
export interface ResponseUpdateParams {
  bestConnector: string;
  newResponse: string;
  toolState: ToolState;
}

/**
 * Handles message construction, updates, and lifecycle.
 * Works with any agent type and centralizes all message operations
 * that were previously scattered across ModelHandler implementations.
 */
export class MessageManager {
  constructor(
    private modelHandler: IModelHandler,
    private logger: AgentLogger,
  ) {}

  /**
   * Initializes conversation messages for the first round
   */
  async initializeMessages(params: MessageInitParams): Promise<any[]> {
    return await this.modelHandler.initializeMessages(
      params.userPrefix,
      params.userRequest,
      params.mediaFiles,
      params.systemPrompt,
    );
  }

  /**
   * Adds messages for a follow-up conversation round
   */
  async addRoundMessage(
    messages: any[],
    params: RoundMessageParams,
  ): Promise<any[]> {
    return await this.modelHandler.createRoundMessages(
      messages,
      params.userMessage,
      params.mediaFiles,
    );
  }

  /**
   * Updates message content with model response
   * Handles both prefill and non-prefill model types
   */
  updateWithResponse(
    messages: any[],
    params: ResponseUpdateParams,
  ): void {
    if (this.modelHandler.capabilities.supportsAssistantPrefill) {
      this.modelHandler.updateMessageContentWithPrefill(
        messages,
        params.bestConnector,
        params.newResponse,
        params.toolState,
      );
    } else {
      this.modelHandler.updateMessageContentWithoutPrefill(
        messages,
        params.bestConnector,
        params.newResponse,
        params.toolState,
      );
    }
  }

  /**
   * Adds continuation message when response is truncated
   * Handles both prefill and non-prefill model types
   */
  addContinuationMessage(
    messages: any[],
    params: ContinuationParams,
  ): void {
    this.logger.debug(
      `Adding continuation message to conversation`,
    );
    
    if (this.modelHandler.capabilities.supportsAssistantPrefill) {
      this.modelHandler.addContinueMessageWithPrefill(
        messages,
        params.stateRound,
        params.toolState,
        params.agentSetting,
        params.agentConfig,
      );
    } else {
      this.modelHandler.addContinueMessageWithoutPrefill(
        messages,
        params.stateRound,
        params.toolState,
        params.agentSetting,
        params.agentConfig,
      );
    }
  }

  /**
   * Determines if the model should continue generating
   */
  shouldContinueGeneration(
    stopReason: any,
    processedResponse: string,
    agentSetting: AgentSetting,
  ): boolean {
    return this.modelHandler.shouldContinue(
      stopReason,
      processedResponse,
      agentSetting,
    );
  }

  /**
   * Gets the model's capabilities for message handling decisions
   */
  get capabilities() {
    return this.modelHandler.capabilities;
  }
}