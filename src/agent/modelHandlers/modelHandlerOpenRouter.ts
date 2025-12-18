/**
 * Native OpenRouter model handler using the official @openrouter/sdk.
 * Provides type-safe integration with OpenRouter's API for accessing 300+ language models.
 *
 * @see https://openrouter.ai/docs/typescript-sdk
 */

// Third-party imports - OpenRouter SDK
import { OpenRouter } from '@openrouter/sdk';
import { toJSONSchema } from 'zod';

// ============================================================================
// OpenRouter SDK Types
// Types are defined inline due to moduleResolution constraints with ESM subpath exports.
// These mirror the SDK types from @openrouter/sdk/models and @openrouter/sdk/lib/event-streams.
// ============================================================================

/** SDK Message types */
type SystemMessage = { role: 'system'; content: string };

/** Content part types for multimodal messages */
type TextContentPart = { type: 'text'; text: string };
type ImageUrlContentPart = {
  type: 'image_url';
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
};
type ContentPart = TextContentPart | ImageUrlContentPart;

type UserMessage = {
  role: 'user';
  content: string | ContentPart[];
};
/** Assistant message content part (for prefill support with Claude via OpenRouter) */
type AssistantContentPart = { type: 'text'; text: string };

type AssistantMessage = {
  role: 'assistant';
  /** Content can be string, array of content parts (for Claude prefill), or null */
  content?: string | AssistantContentPart[] | null;
  reasoning?: string | null;
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
};
type Message = SystemMessage | UserMessage | AssistantMessage;

/** SDK Token usage */
interface ChatGenerationTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  completionTokensDetails?: { reasoningTokens?: number | null } | null;
  promptTokensDetails?: { cachedTokens?: number } | null;
}

/** SDK Response types */
interface ChatResponseChoice {
  index: number;
  finishReason: string | null;
  message: AssistantMessage;
}

interface ChatResponse {
  id: string;
  choices: ChatResponseChoice[];
  created: number;
  model: string;
  object: 'chat.completion';
  usage?: ChatGenerationTokenUsage;
}

/** SDK Streaming types */
interface ChatStreamingChoice {
  index: number;
  finishReason: string | null;
  delta: {
    role?: 'assistant';
    content?: string | null;
    reasoning?: string | null;
    toolCalls?: Array<{
      index?: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
    reasoningDetails?: unknown[];
  };
}

interface ChatStreamingResponseChunkData {
  id: string;
  choices: ChatStreamingChoice[];
  created: number;
  model: string;
  object: 'chat.completion.chunk';
  usage?: ChatGenerationTokenUsage;
}

/** SDK Tool definition */
interface ToolDefinitionJson {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** SDK Request parameters */
interface ChatGenerationParams {
  model?: string;
  messages: Message[];
  maxTokens?: number | null;
  temperature?: number | null;
  stop?: string | string[] | null;
  stream?: boolean;
  streamOptions?: { includeUsage?: boolean } | null;
  tools?: ToolDefinitionJson[];
  toolChoice?: 'auto' | 'none' | 'required';
  reasoning?: { effort?: string | null; enabled?: boolean };
  /** Include reasoning content in response (required for O1-style models) */
  includeReasoning?: boolean;
}

// Local imports - agent components
import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentSetting, hasEndTag } from '@agent/core/AgentDataclass';
import { ConversationRoundState } from '@agent/core/AgentState';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import { createContinuationMessage } from '@agent/utils/continuationMessage';
import type { MediaEntry } from '@agent/utils/mediaTypes';
import { calculateTokenPrice } from '@agent/utils/priceUtils';
import { SecretManager } from '@frontend/secretManager';

// Type imports
import type { ToolDefinition } from '@model';
import { cleanFileContent } from '@replacement/engine';
import type { ToolFileAttachment } from '@tools/result';
import { isNonEmptyString } from '@utils/core';
import type { FileLocation } from '@utils/files';
import { K_SLICE } from '@utils/config';
import { flexibleFS } from '@utils/files';
import xmlUtils from '@utils/text/xmlUtils';

// Local file imports
import { ModelHandler } from './ModelHandler';
import {
  formatAttachmentSummary,
  type ToolResultPayload,
} from './utils/toolAttachmentUtils';
import { executeRequest } from './utils/requestExecutor';
import type {
  CreateResponseOptions,
  ExtractResponseResult,
  OpenAIToolCall,
} from './types/IModelHandler';
import type { ProviderStopReason } from './types/StopReasonTypes';

// ============================================================================
// Type Aliases for SDK Types
// ============================================================================

/** Tool message type (not directly exported by SDK) */
type ToolResponseMessage = {
  role: 'tool';
  toolCallId: string;
  content: string;
};

/** Union of all OpenRouter message types */
type OpenRouterMessage = Message | ToolResponseMessage;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Map TeXRA ToolDefinition to OpenRouter's tool format.
 */
function toOpenRouterTools(tools: ToolDefinition[]): ToolDefinitionJson[] {
  return tools.map((tool) => {
    const params = tool.zodSchema
      ? (toJSONSchema(tool.zodSchema) as Record<string, unknown>)
      : (tool.parameters as Record<string, unknown> | undefined);

    return {
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: params,
      },
    };
  });
}

/**
 * OpenRouter reasoning_details array item types.
 * @see https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
 */
interface ReasoningDetailItem {
  type: 'reasoning.text' | 'reasoning.summary' | 'reasoning.encrypted';
  id?: string | null;
  text?: string;
  summary?: string;
  data?: string;
}

/**
 * Extracts text content from OpenRouter reasoning_details array.
 */
function extractTextFromReasoningDetails(
  details: ReasoningDetailItem[] | unknown,
): string {
  if (!Array.isArray(details)) {
    if (typeof details === 'string') return details;
    return '';
  }

  const textParts: string[] = [];
  for (const item of details) {
    if (!item || typeof item !== 'object') continue;

    const typedItem = item as ReasoningDetailItem;
    switch (typedItem.type) {
      case 'reasoning.text':
        if (typedItem.text) textParts.push(typedItem.text);
        break;
      case 'reasoning.summary':
        if (typedItem.summary) textParts.push(typedItem.summary);
        break;
      case 'reasoning.encrypted':
        break;
    }
  }

  return textParts.join('');
}

// ============================================================================
// Native OpenRouter Model Handler
// ============================================================================

/**
 * Handler for models accessed through OpenRouter using the native SDK.
 */
export class ModelHandlerOpenRouter extends ModelHandler<
  OpenRouterMessage,
  ChatGenerationTokenUsage | undefined,
  ChatGenerationTokenUsage | undefined,
  OpenAIToolCall,
  OpenRouter,
  ChatResponse
> {
  protected get usageProvider(): NormalizedUsage['provider'] {
    return 'openrouter';
  }

  /**
   * Creates a new OpenRouter client using the native SDK.
   */
  async getClient(): Promise<OpenRouter> {
    const apiKey = await this.getApiKey();
    this.logger.debug('Creating native OpenRouter client');

    return new OpenRouter({
      apiKey,
      xTitle: 'TeXRA.ai',
    });
  }

  /**
   * Retrieves OpenRouter API key.
   */
  public override async getApiKey(): Promise<string> {
    try {
      return await SecretManager.getApiKey('openRouter');
    } catch (err) {
      throw new Error(
        'Missing API key for OpenRouter. Please set it using the "Set API Key" command.',
      );
    }
  }

  /**
   * Creates a chat completion using OpenRouter's native SDK.
   */
  async createResponse(
    options: CreateResponseOptions<OpenRouterMessage, OpenRouter>,
  ): Promise<ChatResponse> {
    const { client, messages, temperature, endTag, signal, tools } = options;
    const useStreaming = this.getStreamingConfig();

    // Build request parameters - cast messages to SDK Message type
    const params: ChatGenerationParams = {
      model: this.config.openrouterFullName ?? this.config.fullName,
      messages: messages as Message[],
      maxTokens: this.config.maxOutputTokens,
      temperature: temperature ?? undefined,
    };

    // Add reasoning parameters if supported
    if (this.config.capabilities.supportsReasoning) {
      if (
        this.config.capabilities.supportsReasoningEffort &&
        this.config.capabilities.reasoningEffort
      ) {
        // O1-style models: use effort level + includeReasoning flag
        params.reasoning = {
          effort: this.validateReasoningEffort(
            this.config.capabilities.reasoningEffort,
          ) as ChatGenerationParams['reasoning'] extends { effort?: infer E }
            ? E
            : never,
        };
        params.includeReasoning = true;
      } else {
        // DeepSeek-style models: use enabled flag
        params.reasoning = { enabled: true };
      }
    }

    // Add tools if provided
    if (tools && tools.length > 0) {
      params.tools = toOpenRouterTools(tools);
      params.toolChoice = 'auto';
    }

    // Add stop sequence if provided
    if (endTag) {
      params.stop = [endTag];
    }

    if (useStreaming) {
      params.stream = true;
      params.streamOptions = { includeUsage: true };

      // Use 'any' to bypass SDK's strict internal types at the API boundary
      const stream = await executeRequest(
        {
          model: this.config.name,
          operation: 'openrouter.chat.stream',
          signal,
        },
        () =>
          (client.chat.send as any)({
            ...params,
            stream: true,
          }) as Promise<AsyncIterable<ChatStreamingResponseChunkData>>,
      );

      const thinking = this.createThinkingStream();
      const output = this.isOutputStreamingEnabled()
        ? this.createOutputStream()
        : undefined;

      let finalResponse: ChatResponse | null = null;
      let accumulatedContent = '';
      let accumulatedReasoning = '';
      let accumulatedUsage: ChatGenerationTokenUsage | undefined;
      // Track tool calls by index - streaming sends id/name first, then arguments in subsequent chunks
      const toolCallsMap = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();

      for await (const chunk of stream) {
        const choice = chunk.choices[0] as ChatStreamingChoice | undefined;
        if (!choice) continue;

        // Extract content delta
        const contentDelta = choice.delta?.content ?? '';
        if (contentDelta) {
          accumulatedContent += contentDelta;
          output?.append(contentDelta);
        }

        // Extract reasoning delta
        const reasoningDelta =
          (choice.delta as { reasoning?: string })?.reasoning ??
          extractTextFromReasoningDetails(
            (choice.delta as { reasoningDetails?: unknown })?.reasoningDetails,
          );
        if (reasoningDelta) {
          accumulatedReasoning += reasoningDelta;
          thinking.append(reasoningDelta);
        }

        // Accumulate tool calls by index - streaming sends parts incrementally
        if (choice.delta?.toolCalls) {
          for (const tc of choice.delta.toolCalls) {
            const idx = tc.index ?? 0;
            const existing = toolCallsMap.get(idx);
            if (existing) {
              // Append arguments to existing tool call
              if (tc.function?.arguments) {
                existing.arguments += tc.function.arguments;
              }
              // Update id/name if provided (shouldn't happen, but handle gracefully)
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name = tc.function.name;
            } else {
              // Create new tool call entry
              toolCallsMap.set(idx, {
                id: tc.id ?? '',
                name: tc.function?.name ?? '',
                arguments: tc.function?.arguments ?? '',
              });
            }
          }
        }

        // Capture usage from final chunk
        if (chunk.usage) {
          accumulatedUsage = chunk.usage;
        }

        // Build final response from last chunk
        if (choice.finishReason) {
          // Convert toolCallsMap to array format, filtering out incomplete entries
          const accumulatedToolCalls: AssistantMessage['toolCalls'] = [];
          for (const [, tc] of toolCallsMap) {
            if (tc.id && tc.name) {
              accumulatedToolCalls.push({
                id: tc.id,
                type: 'function',
                function: {
                  name: tc.name,
                  arguments: tc.arguments || '{}',
                },
              });
            }
          }

          finalResponse = {
            id: chunk.id,
            choices: [
              {
                index: 0,
                finishReason: choice.finishReason,
                message: {
                  role: 'assistant',
                  content: accumulatedContent,
                  reasoning: accumulatedReasoning || undefined,
                  toolCalls:
                    accumulatedToolCalls.length > 0
                      ? accumulatedToolCalls
                      : undefined,
                },
              } as ChatResponseChoice,
            ],
            created: chunk.created,
            model: chunk.model,
            object: 'chat.completion',
            usage: accumulatedUsage,
          };
        }
      }

      // Finalize streams
      thinking.finalize(accumulatedReasoning || undefined);
      output?.finalize(accumulatedContent);

      if (!finalResponse) {
        throw new Error('No final response received from OpenRouter stream');
      }

      return finalResponse;
    } else {
      // Non-streaming request - use 'any' to bypass SDK's strict internal types
      return executeRequest(
        {
          model: this.config.name,
          operation: 'openrouter.chat.send',
          signal,
        },
        () =>
          (client.chat.send as any)({
            ...params,
            stream: false,
          }) as Promise<ChatResponse>,
      );
    }
  }

  /**
   * Initializes messages for the conversation.
   */
  async initializeMessages(
    userPrefix: string,
    userRequest: string,
    mediaFiles?: FileLocation[],
    systemPrompt?: string,
  ): Promise<OpenRouterMessage[]> {
    const messages: OpenRouterMessage[] = [];

    // Add system prompt
    if (systemPrompt) {
      messages.push({
        role: 'system',
        content: systemPrompt,
      } as SystemMessage);
    }

    // Build user content
    const userContent: ContentPart[] = [{ type: 'text', text: userPrefix }];

    // Add media if provided (including both text labels and image_url content)
    if (mediaFiles && this.config.capabilities.supportsVision) {
      const formattedMediaContent = await this.createMediaMessage(mediaFiles);
      for (const media of formattedMediaContent) {
        if (typeof media === 'object') {
          if ('text' in media && media.type === 'text') {
            userContent.push({ type: 'text', text: media.text as string });
          } else if ('image_url' in media && media.type === 'image_url') {
            userContent.push(media as ImageUrlContentPart);
          }
        }
      }
    }

    // Add user request
    userContent.push({ type: 'text', text: userRequest });

    messages.push({
      role: 'user',
      content: userContent,
    } as UserMessage);

    return messages;
  }

  /**
   * Creates messages for follow-up rounds.
   */
  async createRoundMessages(
    messages: OpenRouterMessage[],
    userMessage: string,
    _mediaFiles?: FileLocation[],
  ): Promise<OpenRouterMessage[]> {
    messages.push({
      role: 'user',
      content: userMessage,
    } as UserMessage);
    return messages;
  }

  /**
   * Creates follow-up messages from user.
   */
  async createUserFollowUpMessages(
    messages: OpenRouterMessage[],
    userMessage: string,
  ): Promise<OpenRouterMessage[]> {
    messages.push({
      role: 'user',
      content: userMessage,
    } as UserMessage);
    return messages;
  }

  /**
   * Creates an assistant message from text.
   */
  createAssistantMessage(text: string): OpenRouterMessage {
    return {
      role: 'assistant',
      content: text,
    } as AssistantMessage;
  }

  /**
   * Formats media content for OpenRouter.
   */
  createMediaContent(
    mediaMessage: MediaEntry[],
  ): Array<{ type: string; text?: string; image_url?: unknown }> {
    return mediaMessage.flatMap((media) => {
      if (media.media_category === 'image') {
        return [
          { type: 'text', text: `Image: ${media.file_name}` },
          {
            type: 'image_url',
            image_url: {
              url: `data:${media.media_type};base64,${media.data}`,
              detail: 'high',
            },
          },
        ];
      }
      return [];
    });
  }

  /**
   * Extracts response text and usage from the API response.
   */
  extractResponse(
    responseObject: ChatResponse,
    endTag: string,
  ): ExtractResponseResult {
    if (!responseObject.choices?.length) {
      throw new Error('Invalid response from OpenRouter: missing choices');
    }

    const choice = responseObject.choices[0];
    const stopReason = choice.finishReason ?? 'stop';
    let response = '';

    if (typeof choice.message.content === 'string') {
      response = choice.message.content.trim();
    }

    // Add end tag if response was stopped and tag isn't present
    if (stopReason === 'stop' && endTag && !response.includes(endTag)) {
      this.logger.debug(`Adding end tag to response: ${endTag}`);
      response = `${response}\n${endTag}`;
    }

    // Cast to ProviderUsage - the handler normalizes this in normalizeUsage()
    return {
      response,
      usage: responseObject.usage as unknown as ExtractResponseResult['usage'],
      stopReason: stopReason as ProviderStopReason,
    };
  }

  /**
   * Manages continuation with prefill support.
   */
  addContinueMessageWithPrefill(
    _messages: OpenRouterMessage[],
    _stateRound: ConversationRoundState,
    _workspaceState: AgentWorkspaceState,
    _agentSetting: AgentSetting,
    _agentConfig: AgentConfig,
  ): void {
    this.logger.debug('Skipping continuation - assistant prefill is supported');
  }

  /**
   * Manages continuation without prefill support.
   */
  addContinueMessageWithoutPrefill(
    messages: OpenRouterMessage[],
    _stateRound: ConversationRoundState,
    workspaceState: AgentWorkspaceState,
    agentSetting: AgentSetting,
    _agentConfig: AgentConfig,
  ): void {
    const prefillTokens = workspaceState.assembly.lastResponse.slice(-K_SLICE);
    const userMessageContinuation = createContinuationMessage(
      agentSetting.endTag,
      prefillTokens,
    );

    this.logger.debug(`Adding continuation message to conversation`);
    messages.push({
      role: 'user',
      content: userMessageContinuation,
    } as UserMessage);
  }

  /**
   * Initializes output file and handles prefill content.
   */
  async initializeOutputAndPrefill(
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    messages: OpenRouterMessage[],
    workspaceState: AgentWorkspaceState,
    outputLocation: FileLocation,
    prefill: string,
  ): Promise<[boolean, OpenRouterMessage[]]> {
    let endTurn = false;

    if (!(await flexibleFS.existsAndNonTrivial(outputLocation))) {
      const PseudoPrefillMsg = `Organize your response with xml tags. Start your response with:\n${prefill}`;
      const lastMessage = messages.at(-1);
      if (lastMessage && lastMessage.role === 'user') {
        const userMsg = lastMessage as UserMessage;
        if (typeof userMsg.content === 'string') {
          userMsg.content = `${userMsg.content}\n\n${PseudoPrefillMsg}`;
        } else if (Array.isArray(userMsg.content)) {
          (userMsg.content as Array<{ type: 'text'; text: string }>).push({
            type: 'text',
            text: PseudoPrefillMsg,
          });
        }
      }
      return [endTurn, messages];
    }

    // Get prefill from existing file
    let fileContent = await flexibleFS.read(outputLocation);
    fileContent = cleanFileContent(fileContent);

    const scratchpad = await xmlUtils.extractScratchpad(
      fileContent,
      'scratchpad',
    );
    if (scratchpad) {
      this.logger.logScratchpad(scratchpad);
    }

    await flexibleFS.write(outputLocation, fileContent);

    messages.push({
      role: 'assistant',
      content: fileContent,
    } as AssistantMessage);

    if (hasEndTag(agentSetting, fileContent)) {
      this.logger.debug('End tag detected - skipping continuation');
      endTurn = true;
      return [endTurn, messages];
    }

    this.logger.warn(
      'Output file exists but no end tag found - continuing from file',
    );
    if (fileContent.includes(prefill)) {
      workspaceState.assembly.updateAccumulatedOutput(fileContent);
    } else {
      workspaceState.assembly.updateAccumulatedOutput(prefill + fileContent);
      await flexibleFS.write(
        outputLocation,
        workspaceState.assembly.accumulatedOutput,
      );
    }
    const state = new ConversationRoundState(0);
    workspaceState.assembly.lastResponse =
      workspaceState.assembly.accumulatedOutput;
    this.addContinueMessageWithoutPrefill(
      messages,
      state,
      workspaceState,
      agentSetting,
      agentConfig,
    );

    endTurn = false;
    return [endTurn, messages];
  }

  /**
   * Computes cost based on token usage and model pricing.
   */
  computePrice(responseUsage: ChatGenerationTokenUsage | undefined): number {
    if (!responseUsage) return 0.0;

    const promptTokens = responseUsage.promptTokens ?? 0;
    const completionTokens = responseUsage.completionTokens ?? 0;

    let basePrice = calculateTokenPrice(
      promptTokens,
      completionTokens,
      this.config.inputPrice,
      this.config.outputPrice,
    );

    // Add reasoning token costs if present
    const reasoningTokens =
      responseUsage.completionTokensDetails?.reasoningTokens ?? 0;
    if (reasoningTokens) {
      basePrice += (reasoningTokens * this.config.outputPrice) / 1e6;
    }

    // Subtract cached token savings
    const cachedTokens = responseUsage.promptTokensDetails?.cachedTokens ?? 0;
    if (cachedTokens) {
      basePrice -=
        (cachedTokens *
          this.config.inputPrice *
          (1 - this.capabilities.cacheDiscountFactor)) /
        1e6;
    }

    return basePrice;
  }

  /**
   * Normalizes OpenRouter usage data into a unified format.
   */
  normalizeUsage(
    rawUsage: ChatGenerationTokenUsage | undefined,
    responseTimeMs: number,
  ): NormalizedUsage {
    if (!rawUsage) {
      return {
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        responseTimeMs,
        provider: this.usageProvider,
      };
    }

    const inputTokens = rawUsage.promptTokens ?? 0;
    const outputTokens = rawUsage.completionTokens ?? 0;
    const cachedTokens = rawUsage.promptTokensDetails?.cachedTokens ?? 0;
    const reasoningTokens =
      rawUsage.completionTokensDetails?.reasoningTokens ?? 0;
    const percentageCached =
      inputTokens > 0 ? (cachedTokens / inputTokens) * 100 : 0;

    return {
      inputTokens,
      outputTokens,
      cost: this.computePrice(rawUsage),
      responseTimeMs,
      provider: this.usageProvider,
      cachedInputTokens: cachedTokens || undefined,
      percentageCached: percentageCached > 0 ? percentageCached : undefined,
      reasoningTokens: reasoningTokens || undefined,
      _native: rawUsage,
    };
  }

  /**
   * Updates message content with prefill support.
   */
  updateMessageContentWithPrefill(
    messages: OpenRouterMessage[],
    bestConnector: string,
    newResponse: string,
    workspaceState: AgentWorkspaceState,
  ): void {
    const lastMessage = messages.at(-1);

    if (lastMessage?.role === 'assistant') {
      const assistantMsg = lastMessage as AssistantMessage;
      if (typeof assistantMsg.content === 'string') {
        assistantMsg.content =
          assistantMsg.content + bestConnector + newResponse;
      } else {
        assistantMsg.content = workspaceState.assembly.accumulatedOutput;
      }
    } else {
      messages.push({
        role: 'assistant',
        content: bestConnector + newResponse,
      } as AssistantMessage);
    }
  }

  /**
   * Updates message content without prefill support.
   */
  updateMessageContentWithoutPrefill(
    messages: OpenRouterMessage[],
    _bestConnector: string,
    _newResponse: string,
    workspaceState: AgentWorkspaceState,
  ): void {
    const lastMessage = messages.at(-1);
    const secondLastMessage = messages.at(-2);

    if (!lastMessage || lastMessage.role !== 'user') {
      this.logger.error('Last message is not a user message');
      return;
    }

    const userMsg = lastMessage as UserMessage;
    if (
      typeof userMsg.content === 'string' &&
      userMsg.content.includes('Your response got cut off')
    ) {
      if (secondLastMessage?.role === 'assistant') {
        (secondLastMessage as AssistantMessage).content =
          workspaceState.assembly.accumulatedOutput;
        messages.pop();
      }
    } else {
      messages.push({
        role: 'assistant',
        content: workspaceState.assembly.accumulatedOutput,
      } as AssistantMessage);
    }
  }

  /**
   * Determines if generation should continue based on response content.
   */
  shouldContinue(
    stopReason: ProviderStopReason,
    newResponse: string,
    agentSetting: AgentSetting,
  ): boolean {
    return stopReason === 'length' && !hasEndTag(agentSetting, newResponse);
  }

  /**
   * Processes thinking blocks from API response.
   */
  processThinkingBlock(
    responseObject: ChatResponse,
    workspaceState?: AgentWorkspaceState,
  ): string | null {
    const message = responseObject?.choices?.[0]?.message;
    if (!message) return null;

    // Try reasoning field first
    let reasoning = (message as AssistantMessage).reasoning;

    // Try reasoningDetails if reasoning is empty
    if (!reasoning) {
      const choice = responseObject.choices[0] as unknown as {
        reasoningDetails?: unknown;
      };
      const details = choice?.reasoningDetails;
      if (details) {
        reasoning = extractTextFromReasoningDetails(details);
      }
    }

    if (!isNonEmptyString(reasoning)) {
      return null;
    }

    if (workspaceState && !workspaceState.reasoning.thinkingAdded) {
      workspaceState.reasoning.thinkingBlocks = [
        { type: 'thinking', thinking: reasoning },
      ];
      workspaceState.reasoning.thinkingAdded = true;
    }

    this.logger.debug(
      `Reasoning content preview: ${reasoning.substring(0, K_SLICE)}...`,
    );
    return reasoning;
  }

  /**
   * Extracts tool calls from the response.
   */
  extractToolUse(responseObject: ChatResponse): OpenAIToolCall[] {
    const toolCalls = responseObject?.choices?.[0]?.message?.toolCalls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      return [];
    }

    return toolCalls
      .filter((call) => call && call.function?.name && call.id)
      .map((call) => ({
        provider: 'openai' as const,
        callId: call.id,
        name: call.function.name,
        input: this.parseArguments(
          call.function.arguments,
        ) as OpenAIToolCall['input'],
        raw: {
          id: call.id,
          type: 'function' as const,
          function: {
            name: call.function.name,
            arguments: call.function.arguments ?? '{}',
          },
        },
      }));
  }

  /**
   * Parses tool call arguments.
   */
  private parseArguments(raw: unknown): unknown {
    if (typeof raw !== 'string') return raw;

    try {
      return JSON.parse(raw);
    } catch {
      this.logger.warn('Tool call arguments could not be parsed as JSON');
      return raw;
    }
  }

  /**
   * Creates follow-up messages for tool use.
   */
  async createToolUseFollowUpMessages(
    _client: OpenRouter | undefined,
    call: OpenAIToolCall,
    result: ToolResultPayload,
    attachments: ToolFileAttachment[],
    _workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<OpenRouterMessage[]> {
    const callMsg: AssistantMessage = {
      role: 'assistant',
      content: text ?? undefined,
      toolCalls: [
        {
          id: call.callId,
          type: 'function',
          function: {
            name: call.name,
            arguments:
              typeof call.input === 'string'
                ? call.input
                : JSON.stringify(call.input),
          },
        },
      ],
    };

    const finalResult =
      this.canProcessToolResultAttachments && attachments.length > 0
        ? {
            ...result,
            attachmentSummary: formatAttachmentSummary(attachments),
          }
        : result;

    const resultMsg: ToolResponseMessage = {
      role: 'tool',
      toolCallId: call.callId,
      content: JSON.stringify(finalResult),
    };

    return [callMsg, resultMsg];
  }
}

/**
 * Handler for Anthropic models using OpenRouter.
 * Provides prefill support for Claude models accessed via OpenRouter.
 */
export class ModelHandlerAnthropicViaOpenRouter extends ModelHandlerOpenRouter {
  updateMessageContentWithPrefill(
    messages: OpenRouterMessage[],
    bestConnector: string,
    newResponse: string,
    workspaceState: AgentWorkspaceState,
  ): void {
    const lastMessage = messages.at(-1);
    if (lastMessage?.role === 'assistant') {
      const assistantMsg = lastMessage as AssistantMessage;
      if (Array.isArray(assistantMsg.content)) {
        const lastPart = assistantMsg.content.at(-1);
        if (lastPart && 'text' in lastPart) {
          lastPart.text = bestConnector + newResponse;
        }
      } else if (typeof assistantMsg.content === 'string') {
        // Convert string content to array format for Claude prefill support
        assistantMsg.content = [
          {
            type: 'text',
            text: workspaceState.assembly.accumulatedOutput,
          },
        ];
      }
    }
  }

  updateMessageContentWithoutPrefill(
    messages: OpenRouterMessage[],
    _bestConnector: string,
    _newResponse: string,
    workspaceState: AgentWorkspaceState,
  ): void {
    const lastMessage = messages.at(-1);
    if (lastMessage?.role === 'user' || lastMessage?.role === 'system') {
      // Use array content format for Claude prefill support
      const assistantMsg: AssistantMessage = {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: workspaceState.assembly.accumulatedOutput,
          },
        ],
      };
      messages.push(assistantMsg);
    }
  }
}
