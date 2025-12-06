/**
 * Native OpenRouter model handler using the @openrouter/sdk
 *
 * This handler uses the official OpenRouter SDK instead of the OpenAI-compatible API,
 * providing access to OpenRouter-specific features and better type safety.
 */

// Third-party imports
import { OpenRouter } from '@openrouter/sdk';

// Local imports - agent components
import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentSetting, hasEndTag } from '@agent/core/AgentDataclass';
import { ConversationRoundState } from '@agent/core/AgentState';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import { createContinuationMessage } from '@agent/utils/continuationMessage';
import { MediaEntry } from '@agent/utils/mediaTypes';
import { calculateTokenPrice } from '@agent/utils/priceUtils';
import { getSdkErrorMessage } from '@common/errors/sdkErrorUtils';

// Type imports
import type { ToolDefinition } from '@model';
import { cleanFileContent } from '@replacement/engine';
import type { ToolFileAttachment } from '@tools/result';
import type { FileLocation } from '@utils/files';
import { K_SLICE } from '@utils/config';
import { flexibleFS } from '@utils/files';
import { objectToLogString } from '@utils/text/stringUtils';
import xmlUtils from '@utils/text/xmlUtils';

// Local file imports
import { ModelHandler } from './ModelHandler';
import { executeRequest } from './utils/requestExecutor';
import {
  formatAttachmentSummary,
  type ToolResultPayload,
} from './utils/toolAttachmentUtils';
import type {
  CreateResponseOptions,
  ExtractResponseResult,
  OpenAIToolCall,
} from './types/IModelHandler';
import type { ProviderStopReason } from './types/StopReasonTypes';

// OpenRouter SDK types are inlined to avoid module resolution issues
// The SDK uses ESM exports which don't work well with the project's moduleResolution setting

/** System message type for OpenRouter */
interface ORSystemMessage {
  role: 'system';
  content: string;
  name?: string;
}

/** User message type for OpenRouter */
interface ORUserMessage {
  role: 'user';
  content: string | ORContentItem[];
  name?: string;
}

/** Assistant message type for OpenRouter */
interface ORAssistantMessage {
  role: 'assistant';
  content?: string | ORContentItem[] | null;
  name?: string;
  toolCalls?: ORToolCall[];
  reasoning?: string;
}

/** Tool response message type for OpenRouter */
interface ORToolMessage {
  role: 'tool';
  content: string;
  toolCallId: string;
}

/** Content item types */
interface ORContentItem {
  type: string;
  text?: string;
  imageUrl?: { url: string; detail?: string };
  inputAudio?: { data: string; format: string };
  [key: string]: unknown;
}

/** Tool call type */
interface ORToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** Tool definition type */
interface ORToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** Chat generation params */
interface ORChatParams {
  model: string;
  messages: ORMessage[];
  maxTokens?: number;
  temperature?: number;
  stop?: string[];
  tools?: ORToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required';
  stream?: boolean;
  streamOptions?: { includeUsage?: boolean };
  reasoning?: { effort?: string };
  [key: string]: unknown;
}

/** Token usage type */
interface ORTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  promptTokensDetails?: { cachedTokens?: number };
  completionTokensDetails?: { reasoningTokens?: number };
}

/** Chat response choice */
interface ORChoice {
  index: number;
  message?: ORAssistantMessage;
  delta?: Partial<ORAssistantMessage>;
  finishReason?: string | null;
}

/** Chat response type */
interface ORChatResponse {
  id: string;
  model: string;
  created: number;
  object: string;
  choices: ORChoice[];
  usage?: ORTokenUsage;
}

/** Union of all message types */
type ORMessage = ORSystemMessage | ORUserMessage | ORAssistantMessage | ORToolMessage;

// OpenRouter SDK uses different finish reason constants
const OPENROUTER_FINISH = {
  STOP: 'stop',
  LENGTH: 'length',
  TOOL_CALLS: 'tool_calls',
  CONTENT_FILTER: 'content_filter',
  ERROR: 'error',
} as const;

/**
 * Handler for models accessed through OpenRouter using the native SDK.
 */
export class ModelHandlerOpenRouterNative extends ModelHandler<
  ORMessage,
  ORTokenUsage | undefined,
  ORTokenUsage,
  OpenAIToolCall,
  OpenRouter,
  ORChatResponse
> {
  /** Returns OpenRouter client with configured API key. */
  async getClient(): Promise<OpenRouter> {
    const apiKey = await this.getApiKey();
    this.logger.debug('Creating OpenRouter native SDK client');
    return new OpenRouter({
      apiKey,
      xTitle: 'TeXRA.ai',
    });
  }

  /** Convert ToolDefinition to OpenRouter's ToolDefinitionJson format */
  private toOpenRouterTools(defs: ToolDefinition[]): ORToolDefinition[] {
    return defs.map((d) => ({
      type: 'function' as const,
      function: {
        name: d.name,
        description: d.description,
        parameters: d.parameters as Record<string, unknown> | undefined,
      },
    }));
  }

  /** Creates a chat completion with model-specific parameters. */
  async createResponse(
    options: CreateResponseOptions<ORMessage, OpenRouter>,
  ): Promise<ORChatResponse> {
    const { client, messages, temperature, endTag, signal, tools } = options;
    const useStreaming = this.getStreamingConfig();

    const params: ORChatParams = {
      model: this.config.openrouterFullName ?? this.config.name,
      messages,
      maxTokens: this.config.maxOutputTokens,
      temperature,
    };

    // Add reasoning parameters if supported
    if (this.config.capabilities.supportsReasoning) {
      if (
        this.config.capabilities.supportsReasoningEffort &&
        this.config.capabilities.reasoningEffort
      ) {
        const effort = this.validateReasoningEffort(
          this.config.capabilities.reasoningEffort,
        );
        params.reasoning = { effort };
      }
    }

    if (tools && tools.length > 0) {
      params.tools = this.toOpenRouterTools(tools);
      params.toolChoice = 'auto';
    }

    if (endTag) {
      params.stop = [endTag];
    }

    if (useStreaming) {
      return this.executeStreamingChat(client, params, signal);
    }

    return executeRequest(
      {
        model: this.config.name,
        operation: 'openrouter.native.chat.send',
        signal,
      },
      async () => {
        const response = await client.chat.send(
          { ...params, stream: false } as Parameters<typeof client.chat.send>[0],
          signal ? { signal } : undefined,
        );
        return response as unknown as ORChatResponse;
      },
    );
  }

  private async executeStreamingChat(
    client: OpenRouter,
    params: ORChatParams,
    signal?: AbortSignal,
  ): Promise<ORChatResponse> {
    const thinking = this.createThinkingStream();
    const output = this.isOutputStreamingEnabled()
      ? this.createOutputStream()
      : undefined;

    return executeRequest(
      {
        model: this.config.name,
        operation: 'openrouter.native.chat.stream',
        signal,
      },
      async () => {
        const stream = await client.chat.send(
          {
            ...params,
            stream: true,
            streamOptions: { includeUsage: true },
          } as Parameters<typeof client.chat.send>[0],
          signal ? { signal } : undefined,
        );

        // Accumulate the full response
        let fullContent = '';
        let fullReasoning = '';
        let finishReason: string | null = null;
        let usage: ORTokenUsage | undefined;
        let model = params.model ?? '';
        let id = '';
        let created = 0;
        const toolCalls: ORToolCall[] = [];

        // The stream is an async iterable
        for await (const chunk of stream as AsyncIterable<ORChatResponse>) {
          const choice = chunk.choices?.[0];
          if (choice) {
            const delta = choice.delta ?? choice.message;
            if (delta?.content && typeof delta.content === 'string') {
              fullContent += delta.content;
              output?.append(delta.content);
            }
            if (delta?.reasoning) {
              fullReasoning += delta.reasoning;
              thinking.append(delta.reasoning);
            }
            if (delta?.toolCalls) {
              // Merge tool calls incrementally
              for (const tc of delta.toolCalls) {
                // Streaming tool calls are merged by index
                const existingIdx = toolCalls.findIndex(
                  (t) => t.id === tc.id || (!tc.id && toolCalls.length > 0),
                );
                if (existingIdx >= 0 && tc.function) {
                  // Append to existing tool call arguments
                  const existing = toolCalls[existingIdx];
                  if (tc.function.arguments) {
                    existing.function.arguments += tc.function.arguments;
                  }
                } else if (tc.id && tc.function?.name) {
                  // New tool call
                  toolCalls.push({
                    id: tc.id,
                    type: 'function',
                    function: {
                      name: tc.function.name,
                      arguments: tc.function.arguments ?? '',
                    },
                  });
                }
              }
            }
            if (choice.finishReason) {
              finishReason = choice.finishReason;
            }
          }
          if (chunk.usage) {
            usage = chunk.usage;
          }
          if (chunk.id) {
            id = chunk.id;
          }
          if (chunk.model) {
            model = chunk.model;
          }
          if (chunk.created) {
            created = chunk.created;
          }
        }

        // Finalize streams
        thinking.finalize(fullReasoning || undefined);
        output?.finalize(fullContent);

        // Build the final response in ChatResponse format
        const response: ORChatResponse = {
          id,
          model,
          created,
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              finishReason,
              message: {
                role: 'assistant',
                content: fullContent || null,
                reasoning: fullReasoning || undefined,
                toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
              },
            },
          ],
          usage,
        };

        return response;
      },
    );
  }

  /** Initializes message array with system prompt and user content. */
  async initializeMessages(
    userPrefix: string,
    userRequest: string,
    mediaFiles?: string[],
    systemPrompt?: string,
  ): Promise<ORMessage[]> {
    const messages: ORMessage[] = [];

    // Handle system prompt
    if (systemPrompt) {
      if (this.config.capabilities.supportsSystemPrompt) {
        messages.push({
          role: 'system',
          content: systemPrompt,
        });
      } else {
        // For models without system prompt support, add as user message
        messages.push({
          role: 'user',
          content: systemPrompt,
        });
      }
    }

    // Build user message content
    const userContent: ORContentItem[] = [{ type: 'text', text: userPrefix }];

    // Add media if provided
    if (
      mediaFiles &&
      (this.config.capabilities.supportsVision ||
        this.config.capabilities.supportsNativeAudio)
    ) {
      const formattedMediaContent = await this.createMediaMessage(mediaFiles);
      userContent.push(...formattedMediaContent);
    }

    // Add user message
    messages.push({
      role: 'user',
      content: userContent,
    });

    // Add the user request
    const lastMessage = messages.at(-1);
    if (lastMessage?.role === 'user') {
      const content = lastMessage.content;
      if (Array.isArray(content)) {
        content.push({ type: 'text', text: userRequest });
      } else if (typeof content === 'string') {
        (lastMessage as ORUserMessage).content = [
          { type: 'text', text: content },
          { type: 'text', text: userRequest },
        ];
      }
    } else {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: userRequest }],
      });
    }

    return messages;
  }

  /** Adds user message content for subsequent rounds. */
  async createRoundMessages(
    messages: ORMessage[],
    userMessage: string,
    mediaFiles?: string[],
  ): Promise<ORMessage[]> {
    const roundContent: ORContentItem[] = [];

    if (
      mediaFiles &&
      mediaFiles.length > 0 &&
      (this.config.capabilities.supportsVision ||
        this.config.capabilities.supportsNativeAudio)
    ) {
      try {
        const formattedMediaContent = await this.createMediaMessage(mediaFiles);
        roundContent.push(...formattedMediaContent);
      } catch (err) {
        this.logger.error(
          `Error processing media files for follow-up round: ${getSdkErrorMessage(err)}`,
          { data: err },
        );
      }
    }
    roundContent.push({ type: 'text', text: userMessage });

    messages.push({
      role: 'user',
      content: roundContent,
    });
    return messages;
  }

  async createUserFollowUpMessages(
    messages: ORMessage[],
    userMessage: string,
  ): Promise<ORMessage[]> {
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: userMessage }],
    });
    return messages;
  }

  createAssistantMessage(text: string): ORMessage {
    return {
      role: 'assistant',
      content: text,
    };
  }

  /** Formats image/audio content for OpenRouter's native SDK API. */
  createMediaContent(mediaMessage: MediaEntry[]): ORContentItem[] {
    return mediaMessage.flatMap((media): ORContentItem[] => {
      if (media.media_category === 'image') {
        return [
          { type: 'text', text: `Image: ${media.file_name}` },
          {
            type: 'image_url',
            imageUrl: {
              url: `data:${media.media_type};base64,${media.data}`,
              detail: 'high',
            },
          },
        ];
      } else if (
        media.media_category === 'audio' &&
        this.config.capabilities.supportsNativeAudio
      ) {
        let audioFormat = media.media_type;
        if (media.media_type.includes('/')) {
          audioFormat = media.media_type.split('/')[1];
        }

        return [
          { type: 'text', text: `Audio: ${media.file_name}` },
          {
            type: 'input_audio',
            inputAudio: {
              data: media.data,
              format: audioFormat,
            },
          },
        ];
      } else if (media.media_category === 'audio') {
        this.logger.warn(
          `Audio input received (${media.file_name}) but native audio is not supported. Skipping.`,
        );
        return [];
      } else {
        this.logger.warn(`Unknown media category: ${media.media_category}`);
        return [];
      }
    });
  }

  /** Extracts response text and usage statistics from API response. */
  extractResponse(
    responseObject: ORChatResponse,
    endTag: string,
  ): ExtractResponseResult {
    if (!responseObject.choices?.length) {
      this.logger.debug(
        `Response object: ${objectToLogString(responseObject)}`,
      );
      const errorMsg = 'Invalid response from API: missing choices';
      this.logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    const choice = responseObject.choices[0];
    const stopReason = choice.finishReason;
    this.logger.debug(`Stop reason: ${stopReason}`);

    let newResponse = '';
    const messageContent = choice.message?.content;
    if (messageContent) {
      if (typeof messageContent === 'string') {
        newResponse = messageContent.trim();
      } else if (Array.isArray(messageContent)) {
        newResponse = messageContent
          .filter((item) => item.type === 'text' && 'text' in item)
          .map((item) => item.text ?? '')
          .join('')
          .trim();
      }
    } else if (
      stopReason === OPENROUTER_FINISH.TOOL_CALLS ||
      choice.message?.toolCalls
    ) {
      this.logger.debug('Received tool call without message content');
    } else {
      this.logger.error(
        `Response object: ${objectToLogString(responseObject)}`,
      );
      this.logger.error('content is empty');
    }

    // Add end tag if response was stopped and tag isn't present
    if (
      stopReason === OPENROUTER_FINISH.STOP &&
      endTag &&
      !newResponse.includes(endTag)
    ) {
      this.logger.debug(`Adding end tag to response: ${endTag}`);
      newResponse = `${newResponse}\n${endTag}`;
    }

    return {
      response: newResponse,
      // Cast to unknown since ORTokenUsage uses camelCase while ProviderUsage expects SDK types
      usage: responseObject.usage as unknown as ExtractResponseResult['usage'],
      stopReason: stopReason as ProviderStopReason,
    };
  }

  /** Manages continuation with prefill support. */
  addContinueMessageWithPrefill(
    _messages: ORMessage[],
    _stateRound: ConversationRoundState,
    _workspaceState: AgentWorkspaceState,
    _agentSetting: AgentSetting,
    _agentConfig: AgentConfig,
  ): void {
    this.logger.debug('Skipping continuation - assistant prefill is supported');
  }

  /** Manages continuation for models without prefill support. */
  addContinueMessageWithoutPrefill(
    messages: ORMessage[],
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

    this.logger.debug(
      `Adding continuation message to conversation. Continuation message:\n ${userMessageContinuation}`,
    );

    messages.push({
      role: 'user',
      content: [{ type: 'text', text: userMessageContinuation }],
    });
  }

  /** Initializes output file and handles prefill content. */
  async initializeOutputAndPrefill(
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    messages: ORMessage[],
    workspaceState: AgentWorkspaceState,
    outputLocation: FileLocation,
    prefill: string,
  ): Promise<[boolean, ORMessage[]]> {
    let endTurn = false;

    if (!(await flexibleFS.existsAndNonTrivial(outputLocation))) {
      const PseudoPrefillMsgContentString = `Organize your response with xml tags. Start your response with:\n${prefill}`;
      const lastMessage = messages.at(-1);
      if (lastMessage?.role === 'user') {
        const content = lastMessage.content;
        if (Array.isArray(content)) {
          content.push({ type: 'text', text: PseudoPrefillMsgContentString });
        } else if (typeof content === 'string') {
          (lastMessage as ORUserMessage).content = [
            { type: 'text', text: content },
            { type: 'text', text: PseudoPrefillMsgContentString },
          ];
        }
      }
      this.logger.debug(
        `Added pseudo prefill message to messages:\n${PseudoPrefillMsgContentString}`,
      );
      return [endTurn, messages];
    }

    // Get prefill from existing and non-trivial file
    let fileContent = await flexibleFS.read(outputLocation);
    fileContent = cleanFileContent(fileContent);

    // Extract any existing scratchpad content
    const scratchpad = await xmlUtils.extractScratchpad(
      fileContent,
      'scratchpad',
    );
    if (scratchpad) {
      this.logger.logScratchpad(scratchpad);
    }

    // Write file content to output file
    await flexibleFS.write(outputLocation, fileContent);

    messages.push({
      role: 'assistant',
      content: fileContent,
    });

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

  /** Computes cost based on token usage and model pricing. */
  computePrice(responseUsage: ORTokenUsage | undefined): number {
    if (!responseUsage) {
      return 0.0;
    }

    const promptTokens = responseUsage.promptTokens ?? 0;
    const completionTokens = responseUsage.completionTokens ?? 0;

    let basePrice = calculateTokenPrice(
      promptTokens,
      completionTokens,
      this.config.inputPrice,
      this.config.outputPrice,
    );

    // Retrieve nested token details if present
    const reasoningTokens =
      responseUsage.completionTokensDetails?.reasoningTokens ?? 0;
    const cachedTokens = responseUsage.promptTokensDetails?.cachedTokens ?? 0;

    if (reasoningTokens) {
      basePrice += (reasoningTokens * this.config.outputPrice) / 1e6;
    }
    if (cachedTokens) {
      basePrice -=
        (cachedTokens *
          this.config.inputPrice *
          (1 - this.capabilities.cacheDiscountFactor)) /
        1e6;
    }

    return basePrice;
  }

  /** Normalizes OpenRouter usage data into a unified format. */
  normalizeUsage(
    rawUsage: ORTokenUsage | undefined,
    responseTimeMs: number,
  ): NormalizedUsage {
    if (!rawUsage) {
      return {
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        responseTimeMs,
        provider: 'openrouter',
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
      provider: 'openrouter',
      cachedInputTokens: cachedTokens || undefined,
      percentageCached: percentageCached > 0 ? percentageCached : undefined,
      reasoningTokens: reasoningTokens || undefined,
      _native: rawUsage,
    };
  }

  /** Updates message content for models with prefill support. */
  updateMessageContentWithPrefill(
    messages: ORMessage[],
    bestConnector: string,
    newResponse: string,
    workspaceState: AgentWorkspaceState,
  ): void {
    const lastMessage = messages.at(-1);

    if (lastMessage?.role === 'assistant') {
      const assistantMsg = lastMessage as ORAssistantMessage;
      const content = assistantMsg.content;
      if (Array.isArray(content)) {
        content.push({ type: 'text', text: bestConnector + newResponse });
      } else if (typeof content === 'string') {
        assistantMsg.content = workspaceState.assembly.accumulatedOutput;
      } else {
        assistantMsg.content = bestConnector + newResponse;
      }
    } else if (
      lastMessage?.role === 'user' ||
      lastMessage?.role === 'system'
    ) {
      this.logger.debug(
        'Last message is a user or system message - unexpected format',
      );
      messages.push({
        role: 'assistant',
        content: bestConnector + newResponse,
      });
    }
  }

  /** Updates message content for models without prefill support. */
  updateMessageContentWithoutPrefill(
    messages: ORMessage[],
    bestConnector: string,
    newResponse: string,
    workspaceState: AgentWorkspaceState,
  ): void {
    this.logger.debug(
      'Updating message content for OpenRouter native models without prefill support',
    );

    const lastMessage = messages.at(-1);
    const secondLastMessage = messages.at(-2);

    if (
      !lastMessage ||
      (lastMessage.role !== 'user' && lastMessage.role !== 'system')
    ) {
      this.logger.error(
        'Last message is not a user or system message - unexpected format',
      );
      return;
    }

    if (this.containCutOffMessage(lastMessage.content as string)) {
      this.logger.debug(
        'Last message is a user message asking to continue after cut off',
      );
      if (secondLastMessage?.role === 'assistant') {
        const assistantMsg = secondLastMessage as ORAssistantMessage;
        if (Array.isArray(assistantMsg.content)) {
          assistantMsg.content.push({
            type: 'text',
            text: bestConnector + newResponse,
          });
        } else {
          assistantMsg.content = workspaceState.assembly.accumulatedOutput;
        }

        // Remove the user continuation prompt
        if (messages.at(-1)?.role === 'user') {
          messages.pop();
        }
      }
    } else {
      this.logger.debug('Last message is a request message');
      messages.push({
        role: 'assistant',
        content: workspaceState.assembly.accumulatedOutput,
      });
    }
  }

  /** Determines if generation should continue based on response content. */
  shouldContinue(
    stopReason: ProviderStopReason,
    newResponse: string,
    agentSetting: AgentSetting,
  ): boolean {
    return (
      stopReason === OPENROUTER_FINISH.LENGTH &&
      !hasEndTag(agentSetting, newResponse)
    );
  }

  /** Processes thinking blocks from API response. */
  processThinkingBlock(
    responseObject: ORChatResponse,
    workspaceState?: AgentWorkspaceState,
  ): string | null {
    const message = responseObject?.choices?.[0]?.message;
    const reasoning = message?.reasoning;

    if (!reasoning || (typeof reasoning === 'string' && !reasoning.trim())) {
      return null;
    }

    const reasoningStr =
      typeof reasoning === 'string' ? reasoning : JSON.stringify(reasoning);

    if (workspaceState && !workspaceState.reasoning.thinkingAdded) {
      workspaceState.reasoning.thinkingBlocks = [
        { type: 'thinking', thinking: reasoningStr },
      ];
      workspaceState.reasoning.thinkingAdded = true;
    }

    this.logger.debug(
      `Reasoning content preview: ${reasoningStr.substring(0, K_SLICE)}...`,
    );
    return reasoningStr;
  }

  private parseArguments(raw: string): string {
    // Return as string to match OpenAIToolCall.input type
    return raw;
  }

  /** Extract tool calls and return as OpenAI-compatible format for compatibility */
  extractToolUse(responseObject: ORChatResponse): OpenAIToolCall[] {
    const toolCalls = responseObject?.choices?.[0]?.message?.toolCalls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      return [];
    }

    // Return as OpenAI-compatible tool calls for compatibility with existing infrastructure
    return toolCalls
      .filter((call) => call && call.id && call.function?.name)
      .map((call) => ({
        provider: 'openai' as const,
        callId: call.id,
        name: call.function.name,
        input: this.parseArguments(call.function.arguments),
        raw: {
          id: call.id,
          type: 'function' as const,
          function: {
            name: call.function.name,
            arguments: call.function.arguments,
          },
        },
      }));
  }

  async createToolUseFollowUpMessages(
    _client: OpenRouter | undefined,
    call: OpenAIToolCall,
    result: ToolResultPayload,
    attachments: ToolFileAttachment[],
    _workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<ORMessage[]> {
    const callMsg: ORAssistantMessage = {
      role: 'assistant',
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
    if (text) {
      callMsg.content = text;
    }

    // Add attachment summary only if handler supports them and attachments exist
    const finalResult =
      this.canProcessToolResultAttachments && attachments.length > 0
        ? {
            ...result,
            attachmentSummary: formatAttachmentSummary(attachments),
          }
        : result;

    const resultMsg: ORToolMessage = {
      role: 'tool',
      toolCallId: call.callId,
      content: JSON.stringify(finalResult),
    };

    return [callMsg, resultMsg];
  }
}
