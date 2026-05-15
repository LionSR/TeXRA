// Third-party imports

// Local imports - agent
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { AgentSetting } from '@agent/core/AgentDataclass';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import type { MediaEntry } from '@agent/utils/mediaTypes';

// Local imports - tools and utils
import type { ToolFileAttachment } from '@tools/result';
import type { FileLocation } from '@utils/files';

// Local imports - model handlers
import { ModelHandler } from './ModelHandler';
import type { ModelConfig } from 'llm-zoo';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type {
  CreateResponseOptions,
  CreateResponseResult,
  ExtractResponseResult,
  SdkToolCall,
} from './types/IModelHandler';
import type { ProviderStopReason } from './types/StopReasonTypes';
import type { ToolResultPayload } from './utils/toolAttachmentUtils';

interface ValidationResponse {
  text: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  stopReason: ProviderStopReason;
}

const VALIDATION_OUTPUT = `\\section{Validated CLI Runtime}

This document was produced by the internal TeXRA CLI validation model handler.
`;

/**
 * Internal model handler used only by the CLI packaged-runtime validation gate.
 *
 * This handler is intentionally below `executeAgent()`: the CLI still parses
 * arguments, initializes the platform, calls the real shared runtime, and lets
 * the workflow flow write and extract output files. It is not a user-visible
 * model provider and must only be enabled by the package validation script.
 */
export class ModelHandlerValidation extends ModelHandler<
  ChatCompletionMessageParam,
  ValidationResponse['usage'],
  ValidationResponse['usage'],
  SdkToolCall,
  unknown,
  ValidationResponse
> {
  constructor(config: ModelConfig) {
    super(config);
    this.capabilities.supportsVision = false;
    this.capabilities.supportsFunctionCalling = false;
    this.capabilities.supportsAssistantPrefill = false;
  }

  async getClient(): Promise<unknown> {
    return {};
  }

  async createResponse(
    _options: CreateResponseOptions<ChatCompletionMessageParam, unknown>,
  ): Promise<
    CreateResponseResult<ValidationResponse, ChatCompletionMessageParam>
  > {
    return {
      response: {
        text: `<documents><document name="paper.polished.tex">${VALIDATION_OUTPUT}</document></documents>`,
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
        },
        stopReason: 'STOP',
      },
    };
  }

  async initializeMessages(
    userPrefix: string,
    userRequest: string,
  ): Promise<ChatCompletionMessageParam[]> {
    return [{ role: 'user', content: `${userPrefix}\n\n${userRequest}` }];
  }

  async createRoundMessages(
    messages: ChatCompletionMessageParam[],
    userMessage: string,
  ): Promise<ChatCompletionMessageParam[]> {
    return [...messages, { role: 'user', content: userMessage }];
  }

  createMediaContent(_mediaMessage: MediaEntry[]): unknown[] {
    return [];
  }

  extractResponse(responseObject: ValidationResponse): ExtractResponseResult {
    return {
      text: responseObject.text,
      usage: responseObject.usage,
      stopReason: responseObject.stopReason,
    };
  }

  addContinueMessageWithPrefill(): void {
    // The validation model always produces a complete response.
  }

  addContinueMessageWithoutPrefill(): void {
    // The validation model always produces a complete response.
  }

  async initializeOutputAndPrefill(
    _agentConfig: AgentConfig,
    _agentSetting: AgentSetting,
    messages: ChatCompletionMessageParam[],
    _workspaceState: AgentWorkspaceState,
    _outputLocation: FileLocation,
    _prefill: string,
  ): Promise<[boolean, ChatCompletionMessageParam[]]> {
    return [false, messages];
  }

  computePrice(_responseUsage: ValidationResponse['usage']): number {
    return 0;
  }

  normalizeUsage(
    rawUsage: ValidationResponse['usage'],
    responseTimeMs: number,
  ): NormalizedUsage {
    return {
      inputTokens: rawUsage.prompt_tokens,
      outputTokens: rawUsage.completion_tokens,
      cost: 0,
      responseTimeMs,
      provider: 'unknown',
    };
  }

  updateMessageContentWithPrefill(
    messages: ChatCompletionMessageParam[],
    _bestConnector: string,
    newResponse: string,
  ): void {
    messages.push(this.createAssistantMessage(newResponse));
  }

  updateMessageContentWithoutPrefill(
    messages: ChatCompletionMessageParam[],
    _bestConnector: string,
    newResponse: string,
  ): void {
    messages.push(this.createAssistantMessage(newResponse));
  }

  shouldContinue(
    _stopReason: ProviderStopReason,
    _newResponse: string,
    _agentSetting: AgentSetting,
  ): boolean {
    return false;
  }

  processThinkingBlock(
    _responseObject: ValidationResponse,
    _workspaceState?: AgentWorkspaceState,
  ): string | null {
    return null;
  }

  extractToolUse(_responseObject: ValidationResponse): SdkToolCall[] {
    return [];
  }

  async createToolUseFollowUpMessages(
    _client: unknown,
    _call: SdkToolCall,
    result: ToolResultPayload,
    _attachments: ToolFileAttachment[],
    _workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<ChatCompletionMessageParam[]> {
    return [
      {
        role: 'tool',
        tool_call_id: 'validation-tool-call',
        content: text
          ? `${text}\n${JSON.stringify(result)}`
          : JSON.stringify(result),
      },
    ];
  }

  async createUserFollowUpMessages(
    messages: ChatCompletionMessageParam[],
    userMessage: string,
  ): Promise<ChatCompletionMessageParam[]> {
    return [...messages, { role: 'user', content: userMessage }];
  }

  createAssistantMessage(text: string): ChatCompletionMessageParam {
    return { role: 'assistant', content: text };
  }

  prependTextToUserMessage(
    messages: ChatCompletionMessageParam[],
    text: string,
  ): void {
    const last = messages.at(-1);
    if (!last || last.role !== 'user' || typeof last.content !== 'string') {
      messages.push({ role: 'user', content: text });
      return;
    }
    last.content = `${text}\n${last.content}`;
  }

  async addMediaToUserMessage(
    _messages: ChatCompletionMessageParam[],
    _mediaFiles: FileLocation[],
  ): Promise<void> {
    // The validation model is text-only.
  }
}
