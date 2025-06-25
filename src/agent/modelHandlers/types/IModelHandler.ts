import type { AgentConfig } from '../core/AgentConfig';
import type { AgentSetting } from '../core/AgentDataclass';
import type { AgentStateRound } from '../core/AgentState';
import type { ToolState } from '../core/ToolState';
import type { MediaEntry } from '@agent/utils/mediaTypes';
import type { ModelConfig, ModelCapabilities } from '@model/ModelConfig';
import type { ProviderStopReason } from './StopReasonTypes';

/**
 * Contract implemented by all model handlers.
 */
export interface IModelHandler {
  /** Model configuration */
  config: ModelConfig;
  /** Capability information for the model */
  capabilities: ModelCapabilities;
  /** Max number of continue calls per round */
  continueLimit: number;
  /** Max input tokens allowed */
  inputTokenLimit: number;
  /** Factor for output token limit relative to input */
  maxOutputTokensFactor: number;

  /** Whether the provider uses an OpenAI compatible API */
  readonly isOpenaiCompatible: boolean;
  /** True if the model is from Anthropic */
  readonly isAnthropic: boolean;
  /** True if the model is from OpenAI */
  readonly isOpenai: boolean;
  /** True if the model is from Google */
  readonly isGoogle: boolean;
  /** True if the model is a full O-Reasoning model */
  readonly isOReasoningModelFull: boolean;
  /** True if the model is any O-Reasoning model */
  readonly isOReasoningModel: boolean;

  // Abstract methods from ModelHandler
  getClient(): Promise<any>;
  createResponse(
    client: any,
    messages: any[],
    temperature: number,
    systemPrompt?: string,
    endTag?: string,
    signal?: AbortSignal,
  ): Promise<any>;
  initializeMessages(
    userPrefix: string,
    userRequest: string,
    mediaFiles?: string[],
    systemPrompt?: string,
  ): Promise<any[]>;
  createRoundMessages(
    messages: any[],
    userMessage: string,
    mediaFiles?: string[],
  ): Promise<any[]>;
  createMediaContent(mediaMessage: MediaEntry[]): any[];
  extractResponse(
    responseObject: any,
    endTag: string,
  ): [string, any, ProviderStopReason];
  addContinueMessageWithPrefill(
    messages: any[],
    stateRound: AgentStateRound,
    toolState: ToolState,
    agentSetting: AgentSetting,
    agentConfig: AgentConfig,
  ): void;
  addContinueMessageWithoutPrefill(
    messages: any[],
    stateRound: AgentStateRound,
    toolState: ToolState,
    agentSetting: AgentSetting,
    agentConfig: AgentConfig,
  ): void;
  initializeOutputAndPrefill(
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    messages: any[],
    toolState: ToolState,
    outputFile: string,
    prefill: string,
    groupId?: string,
  ): Promise<[boolean, any[]]>;
  computePrice(responseUsage: any): number;
  computeResponseUsage(responseUsage: any, responseTime: number): any;
  updateMessageContentWithPrefill(
    messages: any[],
    bestConnector: string,
    newResponse: string,
    toolState: ToolState,
  ): void;
  updateMessageContentWithoutPrefill(
    messages: any[],
    bestConnector: string,
    newResponse: string,
    toolState: ToolState,
  ): void;
  shouldContinue(
    stopReason: ProviderStopReason,
    newResponse: string,
    agentSetting: AgentSetting,
  ): boolean;
  processThinkingBlock(
    responseObject: any,
    groupId?: string,
    toolState?: ToolState,
  ): string | null;
}
