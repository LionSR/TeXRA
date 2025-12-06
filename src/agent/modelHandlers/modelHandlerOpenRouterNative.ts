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
import { cleanFileContent } from '@replacement/engine';
import type { ToolFileAttachment } from '@tools/result';
import type { FileLocation } from '@utils/files';
import { K_SLICE } from '@utils/config';
import { flexibleFS } from '@utils/files';
import { objectToLogString } from '@utils/text/stringUtils';
import xmlUtils from '@utils/text/xmlUtils';

// Local file imports
import { ModelHandler } from './ModelHandler';
import { toOpenRouterNativeTools } from './toolConversion';
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
import { OPENAI_CHAT_FINISH } from './types/StopReasonTypes';

// ============================================================================
// SDK Type Inference
// ============================================================================
// Derive types from SDK methods to avoid module resolution issues with ESM exports

/** Inferred chat parameters type from SDK */
type ChatSendParams = Parameters<OpenRouter['chat']['send']>[0];

// ============================================================================
// Local Type Definitions (matching SDK's camelCase conventions)
// ============================================================================

/** Content item for messages - literal types for SDK compatibility */
interface ORContentItem {
  type: 'text' | 'image_url' | 'input_audio';
  text?: string;
  imageUrl?: { url: string; detail?: string };
  inputAudio?: { data: string; format: string };
}

/** Tool call structure */
interface ORToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** Message types */
interface ORSystemMessage {
  role: 'system';
  content: string;
}

interface ORUserMessage {
  role: 'user';
  content: string | ORContentItem[];
}

interface ORAssistantMessage {
  role: 'assistant';
  content?: string | ORContentItem[] | null;
  toolCalls?: ORToolCall[];
  reasoning?: string;
}

interface ORToolMessage {
  role: 'tool';
  content: string;
  toolCallId: string;
}

type ORMessage =
  | ORSystemMessage
  | ORUserMessage
  | ORAssistantMessage
  | ORToolMessage;

/** Token usage (camelCase matching SDK) */
interface ORTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  promptTokensDetails?: { cachedTokens?: number };
  completionTokensDetails?: { reasoningTokens?: number };
}

/** Chat response structure */
interface ORChatResponse {
  id: string;
  model: string;
  created: number;
  object: string;
  choices: Array<{
    index: number;
    message?: ORAssistantMessage;
    delta?: Partial<ORAssistantMessage>;
    finishReason?: string | null;
  }>;
  usage?: ORTokenUsage;
}

/**
 * Handler for models accessed through OpenRouter using the native SDK.
 *
 * Key differences from ModelHandlerOpenRouter (OpenAI-compatible):
 * - Uses @openrouter/sdk directly instead of OpenAI SDK
 * - Native support for SDK-specific features like reasoning effort
 * - CamelCase property names matching SDK conventions
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

  /** Creates a chat completion with model-specific parameters. */
  async createResponse(
    options: CreateResponseOptions<ORMessage, OpenRouter>,
  ): Promise<ORChatResponse> {
    const { client, messages, temperature, endTag, signal, tools } = options;
    const useStreaming = this.getStreamingConfig();

    // Build params using SDK's expected format
    // Cast messages to SDK type - our ORMessage type is compatible at runtime
    const params = {
      model: this.config.openrouterFullName ?? this.config.name,
      messages: messages as unknown as ChatSendParams['messages'],
      maxTokens: this.config.maxOutputTokens,
      temperature,
      ...(endTag && { stop: [endTag] }),
      ...(tools?.length && {
        tools: toOpenRouterNativeTools(tools),
        toolChoice: 'auto' as const,
      }),
      ...(this.config.capabilities.supportsReasoning &&
        this.config.capabilities.supportsReasoningEffort &&
        this.config.capabilities.reasoningEffort && {
          reasoning: {
            effort: this.validateReasoningEffort(
              this.config.capabilities.reasoningEffort,
            ) as 'low' | 'medium' | 'high',
          },
        }),
    };

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
          { ...params, stream: false } as ChatSendParams,
          signal ? { signal } : undefined,
        );
        return response as unknown as ORChatResponse;
      },
    );
  }

  private async executeStreamingChat(
    client: OpenRouter,
    params: Partial<ChatSendParams>,
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
          } as ChatSendParams,
          signal ? { signal } : undefined,
        );

        // Accumulate response from stream
        let fullContent = '';
        let fullReasoning = '';
        let finishReason: string | null = null;
        let usage: ORTokenUsage | undefined;
        let model = (params as { model?: string }).model ?? '';
        let id = '';
        let created = 0;
        const toolCalls: ORToolCall[] = [];

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
              this.mergeStreamingToolCalls(toolCalls, delta.toolCalls);
            }
            if (choice.finishReason) {
              finishReason = choice.finishReason;
            }
          }
          if (chunk.usage) usage = chunk.usage;
          if (chunk.id) id = chunk.id;
          if (chunk.model) model = chunk.model;
          if (chunk.created) created = chunk.created;
        }

        thinking.finalize(fullReasoning || undefined);
        output?.finalize(fullContent);

        return {
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
      },
    );
  }

  /** Merge streaming tool call deltas into accumulated tool calls */
  private mergeStreamingToolCalls(
    accumulated: ORToolCall[],
    deltas: Partial<ORToolCall>[],
  ): void {
    for (const tc of deltas) {
      const existing = accumulated.find(
        (t) => t.id === tc.id || (!tc.id && accumulated.length > 0),
      );
      if (existing && tc.function?.arguments) {
        existing.function.arguments += tc.function.arguments;
      } else if (tc.id && tc.function?.name) {
        accumulated.push({
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

  /** Initializes message array with system prompt and user content. */
  async initializeMessages(
    userPrefix: string,
    userRequest: string,
    mediaFiles?: string[],
    systemPrompt?: string,
  ): Promise<ORMessage[]> {
    const messages: ORMessage[] = [];

    if (systemPrompt) {
      messages.push(
        this.config.capabilities.supportsSystemPrompt
          ? { role: 'system', content: systemPrompt }
          : { role: 'user', content: systemPrompt },
      );
    }

    const userContent: ORContentItem[] = [{ type: 'text', text: userPrefix }];

    if (
      mediaFiles?.length &&
      (this.config.capabilities.supportsVision ||
        this.config.capabilities.supportsNativeAudio)
    ) {
      userContent.push(...(await this.createMediaMessage(mediaFiles)));
    }

    userContent.push({ type: 'text', text: userRequest });
    messages.push({ role: 'user', content: userContent });

    return messages;
  }

  /** Adds user message content for subsequent rounds. */
  async createRoundMessages(
    messages: ORMessage[],
    userMessage: string,
    mediaFiles?: string[],
  ): Promise<ORMessage[]> {
    const content: ORContentItem[] = [];

    if (
      mediaFiles?.length &&
      (this.config.capabilities.supportsVision ||
        this.config.capabilities.supportsNativeAudio)
    ) {
      try {
        content.push(...(await this.createMediaMessage(mediaFiles)));
      } catch (err) {
        this.logger.error(
          `Error processing media files: ${getSdkErrorMessage(err)}`,
          { data: err },
        );
      }
    }
    content.push({ type: 'text', text: userMessage });

    messages.push({ role: 'user', content });
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
    return { role: 'assistant', content: text };
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
      }

      if (
        media.media_category === 'audio' &&
        this.config.capabilities.supportsNativeAudio
      ) {
        const format = media.media_type.includes('/')
          ? media.media_type.split('/')[1]
          : media.media_type;
        return [
          { type: 'text', text: `Audio: ${media.file_name}` },
          { type: 'input_audio', inputAudio: { data: media.data, format } },
        ];
      }

      if (media.media_category === 'audio') {
        this.logger.warn(
          `Audio (${media.file_name}) not supported by model. Skipping.`,
        );
        return [];
      }

      this.logger.warn(`Unknown media category: ${media.media_category}`);
      return [];
    });
  }

  /** Extracts response text and usage statistics from API response. */
  extractResponse(
    responseObject: ORChatResponse,
    endTag: string,
  ): ExtractResponseResult {
    if (!responseObject.choices?.length) {
      this.logger.debug(`Response: ${objectToLogString(responseObject)}`);
      throw new Error('Invalid response from API: missing choices');
    }

    const choice = responseObject.choices[0];
    const stopReason = choice.finishReason;
    this.logger.debug(`Stop reason: ${stopReason}`);

    let response = this.extractTextContent(choice.message?.content);

    if (!response && !choice.message?.toolCalls) {
      if (stopReason !== OPENAI_CHAT_FINISH.TOOL_CALLS) {
        this.logger.error(`Response: ${objectToLogString(responseObject)}`);
        this.logger.error('content is empty');
      } else {
        this.logger.debug('Tool call without message content');
      }
    }

    // Add end tag if response was stopped and tag isn't present
    if (
      stopReason === OPENAI_CHAT_FINISH.STOP &&
      endTag &&
      !response.includes(endTag)
    ) {
      this.logger.debug(`Adding end tag: ${endTag}`);
      response = `${response}\n${endTag}`;
    }

    return {
      response,
      usage: responseObject.usage as unknown as ExtractResponseResult['usage'],
      stopReason: stopReason as ProviderStopReason,
    };
  }

  /** Extract text from various content formats */
  private extractTextContent(
    content: string | ORContentItem[] | null | undefined,
  ): string {
    if (!content) return '';
    if (typeof content === 'string') return content.trim();
    return content
      .filter((item) => item.type === 'text' && item.text)
      .map((item) => item.text!)
      .join('')
      .trim();
  }

  /** Manages continuation with prefill support. */
  addContinueMessageWithPrefill(
    _messages: ORMessage[],
    _stateRound: ConversationRoundState,
    _workspaceState: AgentWorkspaceState,
    _agentSetting: AgentSetting,
    _agentConfig: AgentConfig,
  ): void {
    this.logger.debug('Skipping continuation - prefill supported');
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
    const continuation = createContinuationMessage(
      agentSetting.endTag,
      prefillTokens,
    );
    this.logger.debug(`Adding continuation:\n${continuation}`);
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: continuation }],
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
    if (!(await flexibleFS.existsAndNonTrivial(outputLocation))) {
      const pseudoPrefill = `Organize your response with xml tags. Start your response with:\n${prefill}`;
      const lastMessage = messages.at(-1);
      if (lastMessage?.role === 'user' && Array.isArray(lastMessage.content)) {
        lastMessage.content.push({ type: 'text', text: pseudoPrefill });
      }
      this.logger.debug(`Added pseudo prefill:\n${pseudoPrefill}`);
      return [false, messages];
    }

    let fileContent = cleanFileContent(await flexibleFS.read(outputLocation));

    const scratchpad = await xmlUtils.extractScratchpad(
      fileContent,
      'scratchpad',
    );
    if (scratchpad) this.logger.logScratchpad(scratchpad);

    await flexibleFS.write(outputLocation, fileContent);
    messages.push({ role: 'assistant', content: fileContent });

    if (hasEndTag(agentSetting, fileContent)) {
      this.logger.debug('End tag detected - skipping continuation');
      return [true, messages];
    }

    this.logger.warn('Output exists but no end tag - continuing');
    const output = fileContent.includes(prefill)
      ? fileContent
      : prefill + fileContent;
    workspaceState.assembly.updateAccumulatedOutput(output);
    if (output !== fileContent) {
      await flexibleFS.write(outputLocation, output);
    }
    workspaceState.assembly.lastResponse = output;
    this.addContinueMessageWithoutPrefill(
      messages,
      new ConversationRoundState(0),
      workspaceState,
      agentSetting,
      agentConfig,
    );

    return [false, messages];
  }

  /** Computes cost based on token usage and model pricing. */
  computePrice(usage: ORTokenUsage | undefined): number {
    if (!usage) return 0;

    const prompt = usage.promptTokens ?? 0;
    const completion = usage.completionTokens ?? 0;
    const reasoning = usage.completionTokensDetails?.reasoningTokens ?? 0;
    const cached = usage.promptTokensDetails?.cachedTokens ?? 0;

    let price = calculateTokenPrice(
      prompt,
      completion,
      this.config.inputPrice,
      this.config.outputPrice,
    );

    if (reasoning) {
      price += (reasoning * this.config.outputPrice) / 1e6;
    }
    if (cached) {
      price -=
        (cached *
          this.config.inputPrice *
          (1 - this.capabilities.cacheDiscountFactor)) /
        1e6;
    }

    return price;
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
    const cached = rawUsage.promptTokensDetails?.cachedTokens ?? 0;
    const reasoning = rawUsage.completionTokensDetails?.reasoningTokens ?? 0;
    const percentageCached = inputTokens > 0 ? (cached / inputTokens) * 100 : 0;

    return {
      inputTokens,
      outputTokens,
      cost: this.computePrice(rawUsage),
      responseTimeMs,
      provider: 'openrouter',
      cachedInputTokens: cached || undefined,
      percentageCached: percentageCached > 0 ? percentageCached : undefined,
      reasoningTokens: reasoning || undefined,
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
      if (Array.isArray(assistantMsg.content)) {
        assistantMsg.content.push({
          type: 'text',
          text: bestConnector + newResponse,
        });
      } else if (typeof assistantMsg.content === 'string') {
        assistantMsg.content = workspaceState.assembly.accumulatedOutput;
      } else {
        assistantMsg.content = bestConnector + newResponse;
      }
    } else {
      this.logger.debug('Expected assistant message - pushing new one');
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
    this.logger.debug('Updating content without prefill');

    const lastMessage = messages.at(-1);
    const secondLast = messages.at(-2);

    if (
      !lastMessage ||
      (lastMessage.role !== 'user' && lastMessage.role !== 'system')
    ) {
      this.logger.error('Unexpected message format');
      return;
    }

    if (this.containCutOffMessage(lastMessage.content as string)) {
      this.logger.debug('Continue after cut off');
      if (secondLast?.role === 'assistant') {
        const assistant = secondLast as ORAssistantMessage;
        if (Array.isArray(assistant.content)) {
          assistant.content.push({
            type: 'text',
            text: bestConnector + newResponse,
          });
        } else {
          assistant.content = workspaceState.assembly.accumulatedOutput;
        }
        if (messages.at(-1)?.role === 'user') messages.pop();
      }
    } else {
      this.logger.debug('Request message - adding assistant response');
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
      stopReason === OPENAI_CHAT_FINISH.LENGTH &&
      !hasEndTag(agentSetting, newResponse)
    );
  }

  /** Processes thinking blocks from API response. */
  processThinkingBlock(
    responseObject: ORChatResponse,
    workspaceState?: AgentWorkspaceState,
  ): string | null {
    const reasoning = responseObject?.choices?.[0]?.message?.reasoning;
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
      `Reasoning preview: ${reasoningStr.substring(0, K_SLICE)}...`,
    );
    return reasoningStr;
  }

  /** Extract tool calls in OpenAI-compatible format for infrastructure compatibility */
  extractToolUse(responseObject: ORChatResponse): OpenAIToolCall[] {
    const toolCalls = responseObject?.choices?.[0]?.message?.toolCalls;
    if (!toolCalls?.length) return [];

    return toolCalls
      .filter((call) => call?.id && call?.function?.name)
      .map((call) => ({
        provider: 'openai' as const,
        callId: call.id,
        name: call.function.name,
        input: call.function.arguments,
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
    const assistantMsg: ORAssistantMessage = {
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
      ...(text && { content: text }),
    };

    const finalResult =
      this.canProcessToolResultAttachments && attachments.length > 0
        ? { ...result, attachmentSummary: formatAttachmentSummary(attachments) }
        : result;

    const toolMsg: ORToolMessage = {
      role: 'tool',
      toolCallId: call.callId,
      content: JSON.stringify(finalResult),
    };

    return [assistantMsg, toolMsg];
  }
}
