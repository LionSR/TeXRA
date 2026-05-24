// Third-party imports
import { OpenRouter } from '@openrouter/sdk';
import { ModelProvider } from 'llm-zoo';

// Local imports - agent
import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentSetting, hasEndTag } from '@agent/core/AgentDataclass';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import { MediaEntry } from '@agent/utils/mediaTypes';
import { calculateTokenPrice } from '@agent/utils/priceUtils';
import { K_SLICE } from '@agent/core/constants';
import { getConfig } from '@agent/core/config';
import {
  buildErrorLogData,
  getSdkErrorMessage,
} from '@common/errors/sdkErrorUtils';
import { MESSAGE_TYPES } from '@shared/schemas';

// Local imports - tools and utils
import type { ToolFileAttachment } from '@tools/result';
import { isNonEmptyString } from '@utils/core';
import type { FileLocation } from '@utils/files';
import { flexibleFS } from '@utils/files';
import { computeCachePercentage } from './utils/usageNormalization';
import { prepareExistingOutputContent } from './utils/fileContentUtils';

// Local file imports
import { OPENAI_CHAT_FINISH } from './types/StopReasonTypes';
import { toOpenAITools } from './toolConversion';
import {
  formatAttachmentSummary,
  formatToolResultAsText,
  type ToolResultPayload,
} from './utils/toolAttachmentUtils';
import { parseToolArguments } from './utils/parseArguments';
import { extractTextFromReasoningDetails } from './utils/openRouterReasoning';
import { ModelHandler } from './ModelHandler';
import {
  CLIENT_COMPACTION_SUMMARY_MAX_TOKENS,
  COMPACTION_SYSTEM_PROMPT,
  DEFAULT_COMPACTION_THRESHOLD_PERCENT,
} from './contextManagementConstants';
import type {
  ChatResult,
  ChatStreamChunk,
  ChatUsage,
  ChatMessages,
  ChatAssistantMessage,
  ChatToolCall,
  ChatContentItems,
  ChatRequest,
  ChatFinishReasonEnum,
  ReasoningDetailUnion,
} from '@openrouter/sdk/models';
import type {
  CreateResponseOptions,
  CreateResponseResult,
  ExtractResponseResult,
  OpenRouterToolCall,
} from './types/IModelHandler';
import type { ProviderStopReason } from './types/StopReasonTypes';

type OpenRouterReasoningEffort = NonNullable<
  NonNullable<ChatRequest['reasoning']>['effort']
>;

function toOpenRouterReasoningEffort(
  effort: string,
): OpenRouterReasoningEffort {
  switch (effort) {
    case 'xhigh':
    case 'high':
    case 'medium':
    case 'low':
    case 'minimal':
    case 'none':
      return effort;
    default:
      return 'low';
  }
}

// ============================================================================
// Streaming aggregator
// ============================================================================

/**
 * Accumulates streaming chunks into a final ChatResult since the OpenRouter SDK
 * does not provide a `finalChatCompletion()` helper.
 */
class OpenRouterStreamAggregator {
  private content = '';
  private reasoning = '';
  private reasoningDetails: ReasoningDetailUnion[] = [];
  private toolCallMap = new Map<
    number,
    {
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }
  >();
  private finishReason: ChatFinishReasonEnum | null = null;
  private usage: ChatUsage | null = null;
  private model = '';
  private id = '';
  private created = 0;

  consumeChunk(chunk: ChatStreamChunk): {
    contentDelta: string;
    reasoningDelta: string;
  } {
    if (!this.id && chunk.id) this.id = chunk.id;
    if (!this.model && chunk.model) this.model = chunk.model;
    if (!this.created && chunk.created) this.created = chunk.created;
    if (chunk.usage) this.usage = chunk.usage;

    // Surface streaming errors instead of silently ignoring them
    if (chunk.error) {
      throw new Error(
        `OpenRouter streaming error (${chunk.error.code}): ${chunk.error.message}`,
      );
    }

    const choice = chunk.choices[0];
    if (!choice) return { contentDelta: '', reasoningDelta: '' };

    if (choice.finishReason != null) {
      this.finishReason = choice.finishReason;
    }

    const delta = choice.delta;
    const contentDelta = delta.content ?? '';
    if (contentDelta) this.content += contentDelta;

    // Reasoning - try reasoningDetails first, then reasoning string
    let reasoningDelta = '';
    if (delta.reasoningDetails?.length) {
      for (const detail of delta.reasoningDetails) {
        this.reasoningDetails.push(detail);
      }
      reasoningDelta = extractTextFromReasoningDetails(delta.reasoningDetails);
    } else if (delta.reasoning) {
      reasoningDelta = delta.reasoning;
    }
    if (reasoningDelta) this.reasoning += reasoningDelta;

    // Accumulate tool calls by index
    if (delta.toolCalls) {
      for (const tc of delta.toolCalls) {
        const existing = this.toolCallMap.get(tc.index);
        if (existing) {
          if (tc.id && !existing.id) {
            existing.id = tc.id;
          }
          if (tc.function?.arguments) {
            existing.function.arguments += tc.function.arguments;
          }
          if (tc.function?.name) {
            existing.function.name += tc.function.name;
          }
        } else {
          this.toolCallMap.set(tc.index, {
            id: tc.id ?? '',
            type: 'function',
            function: {
              name: tc.function?.name ?? '',
              arguments: tc.function?.arguments ?? '',
            },
          });
        }
      }
    }

    return { contentDelta, reasoningDelta };
  }

  buildResponse(): ChatResult {
    const toolCalls: ChatToolCall[] = [];
    // Sort by index to maintain order
    const sorted = [...this.toolCallMap.entries()].sort(([a], [b]) => a - b);
    for (const [, tc] of sorted) {
      toolCalls.push({
        id: tc.id,
        type: 'function',
        function: { name: tc.function.name, arguments: tc.function.arguments },
      });
    }

    const message: ChatAssistantMessage & { role: 'assistant' } = {
      role: 'assistant',
      content: this.content || undefined,
    };
    if (toolCalls.length > 0) {
      message.toolCalls = toolCalls;
    }
    if (this.reasoning) {
      message.reasoning = this.reasoning;
    }
    if (this.reasoningDetails.length > 0) {
      message.reasoningDetails = this.reasoningDetails;
    }

    return {
      id: this.id,
      choices: [
        {
          index: 0,
          message,
          finishReason: this.finishReason,
        },
      ],
      created: this.created || Math.floor(Date.now() / 1000),
      model: this.model,
      object: 'chat.completion',
      systemFingerprint: null,
      usage: this.usage ?? undefined,
    };
  }
}

// ============================================================================
// Handler
// ============================================================================

/**
 * Native OpenRouter model handler using @openrouter/sdk directly.
 * Decoupled from the OpenAI SDK — uses OpenRouter-native types and client.
 */
export class ModelHandlerOpenRouterNative extends ModelHandler<
  ChatMessages,
  ChatUsage | null,
  ChatUsage,
  OpenRouterToolCall,
  OpenRouter,
  ChatResult
> {
  // ── Client-side compaction state ──────────────────────────────────────
  private lastKnownInputTokens = 0;
  private compactionRequested = false;

  override get supportsManualCompaction(): boolean {
    return this.isToolUseMode();
  }

  override requestCompaction(): void {
    this.compactionRequested = true;
  }

  protected get usageProvider(): NormalizedUsage['provider'] {
    return 'openrouter';
  }

  /** Whether this is an Anthropic model routed through OpenRouter. */
  private get isAnthropicViaOpenRouter(): boolean {
    return this.config.provider === ModelProvider.ANTHROPIC;
  }

  async getClient(): Promise<OpenRouter> {
    const apiKey = await this.getApiKey();
    const baseUrl = this.getBaseUrl();
    return new OpenRouter({
      apiKey,
      appTitle: 'TeXRA.ai',
      ...(baseUrl ? { serverURL: baseUrl } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // createResponse
  // ---------------------------------------------------------------------------

  async createResponse(
    options: CreateResponseOptions<ChatMessages, OpenRouter>,
  ): Promise<CreateResponseResult<ChatResult, ChatMessages>> {
    const {
      client,
      messages: rawMessages,
      temperature,
      endTag,
      signal,
      tools,
    } = options;

    // Phase 0: COMPACT - Check if conversation should be compacted
    let updatedMessages: ChatMessages[] | undefined;
    let messagesToUse = rawMessages;

    if (this.shouldCompact()) {
      this.compactionRequested = false;
      const { compactedMessages, didCompact } = await this.compactConversation(
        client,
        rawMessages,
        signal,
      );
      if (didCompact) {
        messagesToUse = compactedMessages;
        updatedMessages = compactedMessages;
      }
    }

    const useStreaming = this.getStreamingConfig();

    const request: ChatRequest = {
      model: this.config.openrouterFullName,
      messages: messagesToUse,
      maxTokens: this.getEffectiveMaxOutputTokens(),
      temperature,
    };

    // Reasoning configuration:
    // OpenRouter SDK serializes `reasoning.effort` but not `reasoning.enabled`.
    // Use getEffectiveReasoningEffort() for tier-based restrictions (e.g. GPT-5
    // xhigh capped to high for Max-tier users on server-side keys).
    if (this.capabilities.supportsReasoning) {
      const effective = this.capabilities.supportsReasoningEffort
        ? (this.getEffectiveReasoningEffort() ?? 'low')
        : 'low';
      const effort = effective === 'none' ? 'low' : effective;
      request.reasoning = {
        effort: toOpenRouterReasoningEffort(
          this.validateReasoningEffort(effort),
        ),
      };
    }

    if (tools && tools.length > 0) {
      request.tools = toOpenAITools(tools) as ChatRequest['tools'];
      request.toolChoice = 'auto';
    }

    if (endTag) {
      request.stop = [endTag];
    }

    if (useStreaming) {
      const streamRequest: ChatRequest & { stream: true } = {
        ...request,
        stream: true,
        streamOptions: { includeUsage: true },
      };
      const stream = await client.chat.send(
        { chatRequest: streamRequest },
        { signal },
      );
      const aggregator = new OpenRouterStreamAggregator();
      const thinking = this.createThinkingStream();
      const output = this.isOutputStreamingEnabled()
        ? this.createOutputStream()
        : undefined;

      try {
        for await (const chunk of stream) {
          const { contentDelta, reasoningDelta } =
            aggregator.consumeChunk(chunk);
          if (reasoningDelta) thinking.append(reasoningDelta);
          if (contentDelta) output?.append(contentDelta);
        }

        const response = aggregator.buildResponse();
        const finalReasoning = this.processThinkingBlock(response);
        thinking.finalize(finalReasoning ?? undefined);
        const finalOutput = response.choices?.[0]?.message?.content ?? '';
        if (output)
          output.finalize(typeof finalOutput === 'string' ? finalOutput : '');

        if (response.usage?.promptTokens) {
          this.lastKnownInputTokens = response.usage.promptTokens;
        } else {
          this.logger.warn(
            'No usage data in streaming response — token tracking and compaction may be affected',
          );
        }
        return { response, updatedMessages };
      } catch (err) {
        // Ensure progress streams are finalized on error to prevent
        // the progress view from being stuck in a loading state
        thinking.finalize(undefined);
        output?.finalize('');
        throw err;
      }
    }

    // Non-streaming
    const nonStreamingRequest: ChatRequest & { stream: false } = {
      ...request,
      stream: false,
    };
    const response = await client.chat.send(
      { chatRequest: nonStreamingRequest },
      { signal },
    );

    if (response.usage?.promptTokens) {
      this.lastKnownInputTokens = response.usage.promptTokens;
    } else {
      this.logger.warn(
        'No usage data in response — token tracking and compaction may be affected',
      );
    }
    return { response, updatedMessages };
  }

  // ---------------------------------------------------------------------------
  // Compaction
  // ---------------------------------------------------------------------------

  private shouldCompact(): boolean {
    if (!this.isToolUseMode()) return false;
    if (this.compactionRequested) return true;

    const thresholdPercent = getConfig<number>(
      'texra.model.compactionThresholdPercent',
      DEFAULT_COMPACTION_THRESHOLD_PERCENT,
    );
    if (thresholdPercent <= 0) return false;

    const threshold = Math.floor(
      (thresholdPercent / 100) * this.config.contextWindow,
    );
    return this.lastKnownInputTokens > threshold;
  }

  private async compactConversation(
    client: OpenRouter,
    messages: ChatMessages[],
    signal?: AbortSignal,
  ): Promise<{ compactedMessages: ChatMessages[]; didCompact: boolean }> {
    const tokensBefore = this.lastKnownInputTokens;
    const contextWindow = this.config.contextWindow;

    // Separate system messages from conversation
    const systemMessages: ChatMessages[] = [];
    const conversationMessages: ChatMessages[] = [];
    for (const msg of messages) {
      if (
        (msg.role === 'system' || msg.role === 'developer') &&
        conversationMessages.length === 0
      ) {
        systemMessages.push(msg);
      } else {
        conversationMessages.push(msg);
      }
    }

    if (conversationMessages.length <= 2) {
      this.logger.debug('Conversation too short for compaction, skipping');
      return { compactedMessages: messages, didCompact: false };
    }

    try {
      const summaryRequest: ChatRequest & { stream: false } = {
        model: this.config.openrouterFullName,
        messages: [
          {
            role: 'system',
            content: COMPACTION_SYSTEM_PROMPT,
          },
          ...conversationMessages,
        ],
        maxTokens: CLIENT_COMPACTION_SUMMARY_MAX_TOKENS,
        temperature: 0,
        stream: false,
        // Minimize reasoning for summarization — use lowest valid effort
        ...(this.capabilities.supportsReasoningEffort
          ? { reasoning: { effort: 'low' } }
          : {}),
      };
      const summaryResponse = await client.chat.send(
        { chatRequest: summaryRequest },
        { signal },
      );

      const summaryText = summaryResponse.choices[0]?.message?.content;
      const summary = typeof summaryText === 'string' ? summaryText.trim() : '';
      if (!summary) {
        this.logger.warn('Compaction returned empty summary, skipping');
        return { compactedMessages: messages, didCompact: false };
      }

      const compactedMessages: ChatMessages[] = [
        ...systemMessages,
        {
          role: 'user',
          content: `[Previous conversation summary]\n\n${summary}`,
        },
      ];

      const summaryOutputTokens = summaryResponse.usage?.completionTokens ?? 0;
      const estimatedTokensAfter = Math.max(1, summaryOutputTokens);
      const reduction = tokensBefore - estimatedTokensAfter;
      const reductionPercent =
        tokensBefore > 0 ? ((reduction / tokensBefore) * 100).toFixed(1) : '0';

      this.logger.domain({
        key: 'contextManagement',
        text: `Compacted conversation: ${tokensBefore.toLocaleString()} → ~${estimatedTokensAfter.toLocaleString()} tokens (${reductionPercent}% reduction)`,
        data: {
          action: 'compaction',
          tokensBefore,
          tokensAfter: estimatedTokensAfter,
          contextWindow,
          utilizationBefore: Number(
            ((tokensBefore / contextWindow) * 100).toFixed(1),
          ),
          utilizationAfter: Number(
            ((estimatedTokensAfter / contextWindow) * 100).toFixed(1),
          ),
          details: `Client-side compaction: ${conversationMessages.length} messages summarized`,
        },
      });

      return { compactedMessages, didCompact: true };
    } catch (err) {
      this.logger.warn(
        `Compaction failed, continuing with original messages: ${getSdkErrorMessage(err)}`,
      );
      return { compactedMessages: messages, didCompact: false };
    }
  }

  // ---------------------------------------------------------------------------
  // Message creation
  // ---------------------------------------------------------------------------

  async initializeMessages(
    userPrefix: string,
    userRequest: string,
    mediaFiles?: FileLocation[],
    systemPrompt?: string,
  ): Promise<ChatMessages[]> {
    const messages: ChatMessages[] = [];

    if (systemPrompt) {
      const role = this.capabilities.supportsSystemPrompt ? 'system' : 'user';
      if (role === 'system') {
        messages.push({
          role: 'system',
          content: [{ type: 'text', text: systemPrompt }],
        });
      } else {
        messages.push({
          role: 'user',
          content: [{ type: 'text', text: systemPrompt }],
        });
      }
    }

    const userContent: ChatContentItems[] = [];
    if (userPrefix) {
      userContent.push({ type: 'text', text: userPrefix });
    }

    if (
      mediaFiles?.length &&
      (this.capabilities.supportsVision ||
        this.capabilities.supportsNativeAudio)
    ) {
      const formattedMedia = await this.createMediaMessage(mediaFiles);
      userContent.push(...formattedMedia);
    }

    // Append to existing user message or create new
    const lastMsg = messages.at(-1);
    if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
      (lastMsg.content as ChatContentItems[]).push(...userContent);
    } else {
      messages.push({ role: 'user', content: userContent });
    }

    // Add user request
    const requestRole = this.capabilities.supportsIntermDevMsgs
      ? 'system'
      : 'user';
    const lastMessage = messages.at(-1);

    if (
      requestRole === 'user' &&
      lastMessage?.role === 'user' &&
      Array.isArray(lastMessage.content)
    ) {
      (lastMessage.content as ChatContentItems[]).push({
        type: 'text',
        text: userRequest,
      });
    } else if (requestRole === 'system') {
      messages.push({
        role: 'system',
        content: [{ type: 'text', text: userRequest }],
      });
    } else {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: userRequest }],
      });
    }

    return messages;
  }

  async createRoundMessages(
    messages: ChatMessages[],
    userMessage: string,
    mediaFiles?: FileLocation[],
  ): Promise<ChatMessages[]> {
    const roundContent: ChatContentItems[] = [];

    if (
      mediaFiles?.length &&
      (this.capabilities.supportsVision ||
        this.capabilities.supportsNativeAudio)
    ) {
      try {
        const formattedMedia = await this.createMediaMessage(mediaFiles);
        roundContent.push(...formattedMedia);
      } catch (err) {
        this.logger.error(
          `Error processing media files for follow-up round: ${getSdkErrorMessage(err)}`,
          { data: err },
        );
      }
    }

    if (userMessage) {
      roundContent.push({ type: 'text', text: userMessage });
    }

    if (roundContent.length > 0) {
      messages.push({ role: 'user', content: roundContent });
    }
    return messages;
  }

  async createUserFollowUpMessages(
    messages: ChatMessages[],
    userMessage: string,
  ): Promise<ChatMessages[]> {
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: userMessage }],
    });
    return messages;
  }

  createAssistantMessage(text: string): ChatMessages {
    return { role: 'assistant', content: text } as ChatMessages;
  }

  extractAssistantText(message: ChatMessages): string | undefined {
    if (message.role !== 'assistant') return undefined;
    const msg = message as ChatAssistantMessage;
    if (typeof msg.content === 'string') return msg.content;
    if (!Array.isArray(msg.content)) return undefined;
    const texts = (msg.content as ChatContentItems[])
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .filter(Boolean);
    return texts.length > 0 ? texts.join('\n') : undefined;
  }

  // ---------------------------------------------------------------------------
  // Media
  // ---------------------------------------------------------------------------

  createMediaContent(mediaMessage: MediaEntry[]): ChatContentItems[] {
    return mediaMessage.flatMap((media): ChatContentItems[] => {
      if (media.media_category === 'image') {
        return [
          { type: 'text', text: `Image: ${media.file_name}` },
          {
            type: 'image_url',
            imageUrl: {
              url: `data:${media.media_type};base64,${media.data}`,
              detail: 'high',
            },
          } as ChatContentItems,
        ];
      } else if (
        media.media_category === 'audio' &&
        this.capabilities.supportsNativeAudio
      ) {
        const audioFormat = (
          media.media_type.split('/').pop() ?? media.media_type
        ).toLowerCase();
        return [
          { type: 'text', text: `Audio: ${media.file_name}` },
          {
            type: 'input_audio',
            inputAudio: {
              data: media.data,
              format: audioFormat,
            },
          } as ChatContentItems,
        ];
      } else if (media.media_category === 'audio') {
        this.logger.warn(
          `Audio input received (${media.file_name}) but native audio is not supported by this model. Skipping.`,
        );
        return [];
      }
      this.logger.warn(`Unknown media category: ${media.media_category}`);
      return [];
    });
  }

  // ---------------------------------------------------------------------------
  // Response extraction
  // ---------------------------------------------------------------------------

  extractResponse(
    responseObject: ChatResult,
    endTag: string,
  ): ExtractResponseResult {
    if (!responseObject.choices?.length) {
      const errorMsg = 'Invalid response from OpenRouter API: missing choices';
      this.logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    const choice = responseObject.choices[0];
    const stopReason = String(choice.finishReason ?? OPENAI_CHAT_FINISH.STOP);
    this.logger.debug(`Stop reason: ${stopReason}`);

    let newResponse = '';
    const msg = choice.message;
    if (typeof msg.content === 'string') {
      newResponse = msg.content.trim();
    } else if (Array.isArray(msg.content)) {
      newResponse = (msg.content as ChatContentItems[])
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('')
        .trim();
    } else if (
      stopReason === OPENAI_CHAT_FINISH.TOOL_CALLS ||
      (msg.toolCalls && msg.toolCalls.length > 0)
    ) {
      this.logger.debug('Received tool call without message content');
    } else if (!msg.content) {
      this.logger.error('content is empty');
    }

    if (
      stopReason === OPENAI_CHAT_FINISH.STOP &&
      endTag &&
      !newResponse.includes(endTag)
    ) {
      this.logger.debug(`Adding end tag to response: ${endTag}`);
      newResponse = `${newResponse}\n${endTag}`;
    }

    return {
      text: newResponse,
      usage: responseObject.usage ?? null,
      stopReason,
    };
  }

  // ---------------------------------------------------------------------------
  // Pricing & usage
  // ---------------------------------------------------------------------------

  computePrice(responseUsage: ChatUsage | null): number {
    if (!responseUsage) return 0;

    const promptTokens = responseUsage.promptTokens ?? 0;
    const completionTokens = responseUsage.completionTokens ?? 0;

    let basePrice = calculateTokenPrice(
      promptTokens,
      completionTokens,
      this.config.inputPrice,
      this.config.outputPrice,
    );

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

  normalizeUsage(
    rawUsage: ChatUsage | null,
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
    const cachedTokens = rawUsage.promptTokensDetails?.cachedTokens ?? 0;

    return {
      inputTokens,
      outputTokens: rawUsage.completionTokens ?? 0,
      cost: this.computePrice(rawUsage),
      responseTimeMs,
      provider: this.usageProvider,
      cachedInputTokens: cachedTokens || undefined,
      percentageCached: computeCachePercentage(cachedTokens, inputTokens),
      reasoningTokens:
        rawUsage.completionTokensDetails?.reasoningTokens || undefined,
      _native: rawUsage,
    };
  }

  // ---------------------------------------------------------------------------
  // Thinking / reasoning
  // ---------------------------------------------------------------------------

  processThinkingBlock(
    responseObject: ChatResult,
    workspaceState?: AgentWorkspaceState,
  ): string | null {
    const message = responseObject?.choices?.[0]?.message;
    if (!message) return null;

    // Try reasoningDetails first (OpenRouter normalized format)
    const reasoningDetails = (message as ChatAssistantMessage).reasoningDetails;
    if (reasoningDetails) {
      const extracted = extractTextFromReasoningDetails(reasoningDetails);
      if (extracted) {
        this.setThinkingState(extracted, workspaceState);
        return extracted;
      }
    }

    // Fall back to reasoning string
    const reasoning = (message as ChatAssistantMessage).reasoning;
    if (isNonEmptyString(reasoning)) {
      this.setThinkingState(reasoning, workspaceState);
      return reasoning;
    }

    return null;
  }

  private setThinkingState(
    reasoning: string,
    workspaceState?: AgentWorkspaceState,
  ): void {
    if (workspaceState && !workspaceState.reasoning.thinkingAdded) {
      workspaceState.reasoning.thinkingBlocks = [
        { type: 'thinking', thinking: reasoning },
      ];
      workspaceState.reasoning.thinkingAdded = true;
    }
    this.logger.debug(
      `Reasoning content preview: ${reasoning.substring(0, K_SLICE)}...`,
    );
  }

  // ---------------------------------------------------------------------------
  // Tool use
  // ---------------------------------------------------------------------------

  extractToolUse(responseObject: ChatResult): OpenRouterToolCall[] {
    const toolCalls = responseObject?.choices?.[0]?.message?.toolCalls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return [];

    return toolCalls
      .filter((call): call is ChatToolCall =>
        Boolean(call && call.function?.name && call.id),
      )
      .map((call) => ({
        provider: 'openrouter' as const,
        callId: call.id,
        name: call.function.name,
        input: parseToolArguments(call.function.arguments, this.logger),
        raw: call,
      }));
  }

  async createToolUseFollowUpMessages(
    _client: OpenRouter | undefined,
    call: OpenRouterToolCall,
    result: ToolResultPayload,
    attachments: ToolFileAttachment[],
    _workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<ChatMessages[]> {
    const callMsg: ChatMessages = {
      role: 'assistant',
      toolCalls: [call.raw],
      ...(text ? { content: text } : {}),
    } as ChatMessages;

    const attachmentSummary =
      this.canProcessToolResultAttachments && attachments.length > 0
        ? formatAttachmentSummary(attachments)
        : undefined;

    const resultMsg: ChatMessages = {
      role: 'tool',
      toolCallId: call.callId,
      content: formatToolResultAsText(result, attachmentSummary),
    } as ChatMessages;

    return [callMsg, resultMsg];
  }

  async createBatchedToolUseFollowUpMessages(
    calls: OpenRouterToolCall[],
    results: ToolResultPayload[],
    _attachmentsPerCall: ToolFileAttachment[][],
    _workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<ChatMessages[]> {
    if (calls.length !== results.length) {
      throw new Error(
        `Batched tool calls mismatch: ${calls.length} calls vs ${results.length} results`,
      );
    }
    if (calls.length === 0) return [];

    const callMsg: ChatMessages = {
      role: 'assistant',
      toolCalls: calls.map((c) => c.raw),
      ...(text ? { content: text } : {}),
    } as ChatMessages;

    const resultMsgs: ChatMessages[] = calls.map(
      (call, i) =>
        ({
          role: 'tool',
          toolCallId: call.callId,
          content: formatToolResultAsText(results[i]),
        }) as ChatMessages,
    );

    return [callMsg, ...resultMsgs];
  }

  // ---------------------------------------------------------------------------
  // Stop / continue logic
  // ---------------------------------------------------------------------------

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

  addContinueMessageWithPrefill(
    _messages: ChatMessages[],
    _workspaceState: AgentWorkspaceState,
    _agentSetting: AgentSetting,
  ): void {
    this.defaultAddContinueWithPrefill();
  }

  addContinueMessageWithoutPrefill(
    messages: ChatMessages[],
    workspaceState: AgentWorkspaceState,
    agentSetting: AgentSetting,
  ): void {
    const userMessageContinuation = this.createContinuationPrompt(
      workspaceState,
      agentSetting,
    );
    this.logger.debug(
      `Adding continuation message. Continuation:\n ${userMessageContinuation}`,
    );

    const role = this.capabilities.supportsIntermDevMsgs ? 'system' : 'user';
    if (role === 'system') {
      messages.push({
        role: 'system',
        content: [{ type: 'text', text: userMessageContinuation }],
      });
    } else {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: userMessageContinuation }],
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Prefill / output initialization
  // ---------------------------------------------------------------------------

  async initializeOutputAndPrefill(
    _agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    messages: ChatMessages[],
    workspaceState: AgentWorkspaceState,
    outputLocation: FileLocation,
    prefill: string,
  ): Promise<[boolean, ChatMessages[]]> {
    if (!(await flexibleFS.existsAndNonTrivial(outputLocation))) {
      if (prefill.length === 0) {
        this.logger.debug(
          'No prefill provided; skipping pseudo-prefill instruction',
        );
        return [false, messages];
      }
      const pseudoPrefillMsg = `Organize your response with xml tags. Start your response with:\n${prefill}`;
      const lastMessage = messages.at(-1);
      if (lastMessage && Array.isArray(lastMessage.content)) {
        (lastMessage.content as ChatContentItems[]).push({
          type: 'text',
          text: pseudoPrefillMsg,
        });
      } else if (lastMessage && typeof lastMessage.content === 'string') {
        (lastMessage as any).content = [
          { type: 'text', text: lastMessage.content },
          { type: 'text', text: pseudoPrefillMsg },
        ];
      }
      this.logger.debug(`Added pseudo prefill: "${pseudoPrefillMsg}"`);
      return [false, messages];
    }

    const { fileContent } = await prepareExistingOutputContent(
      outputLocation,
      workspaceState,
      this.logger,
    );

    // Push assistant message with file content
    messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: fileContent }],
    } as ChatMessages);

    // If the file already contains the end tag, the prior run finished — no model call needed
    if (hasEndTag(agentSetting, fileContent)) {
      this.logger.debug(
        'End tag detected - skipping model call (response already added above)',
      );
      return [true, messages];
    }

    this.logger.warn(
      'Output file exists but no end tag found - continuing from file',
    );

    if (!fileContent.includes(prefill)) {
      workspaceState.assembly.accumulatedOutput = prefill + fileContent;
      await flexibleFS.write(
        outputLocation,
        workspaceState.assembly.accumulatedOutput,
      );
    }
    this.addContinueMessageWithoutPrefill(
      messages,
      workspaceState,
      agentSetting,
    );

    return [false, messages];
  }

  updateMessageContentWithPrefill(
    messages: ChatMessages[],
    bestConnector: string,
    newResponse: string,
    workspaceState: AgentWorkspaceState,
  ): void {
    const lastMessage = messages.at(-1);

    if (lastMessage?.role === 'assistant') {
      const msg = lastMessage as ChatAssistantMessage;
      if (Array.isArray(msg.content)) {
        if (this.isAnthropicViaOpenRouter) {
          // Anthropic prefill: replace the last text part
          const lastPart = (msg.content as ChatContentItems[]).at(-1);
          if (lastPart && 'text' in lastPart) {
            (lastPart as any).text = bestConnector + newResponse;
          }
        } else {
          (msg.content as ChatContentItems[]).push({
            type: 'text',
            text: bestConnector + newResponse,
          });
        }
      } else {
        (lastMessage as any).content = [
          {
            type: 'text',
            text: workspaceState.assembly.accumulatedOutput,
          },
        ];
      }
    } else if (lastMessage?.role === 'user' || lastMessage?.role === 'system') {
      messages.push({
        role: 'assistant',
        content: bestConnector + newResponse,
      } as ChatMessages);
    }
  }

  updateMessageContentWithoutPrefill(
    messages: ChatMessages[],
    bestConnector: string,
    newResponse: string,
    workspaceState: AgentWorkspaceState,
  ): void {
    // Anthropic via OpenRouter: always push assistant message with accumulated output
    if (this.isAnthropicViaOpenRouter) {
      const lastMessage = messages.at(-1);
      if (lastMessage?.role === 'user' || lastMessage?.role === 'system') {
        messages.push({
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: workspaceState.assembly.accumulatedOutput,
            },
          ],
        } as ChatMessages);
      }
      return;
    }

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

    if (this.containCutOffMessage(lastMessage.content)) {
      if (secondLastMessage?.role === 'assistant') {
        const msg = secondLastMessage as ChatAssistantMessage;
        if (Array.isArray(msg.content)) {
          (msg.content as ChatContentItems[]).push({
            type: 'text',
            text: bestConnector + newResponse,
          });
        } else {
          (secondLastMessage as any).content = [
            {
              type: 'text',
              text: workspaceState.assembly.accumulatedOutput,
            },
          ];
        }
        if (messages.at(-1)?.role === 'user') {
          messages.pop();
        }
      }
    } else {
      messages.push({
        role: 'assistant',
        content: [
          { type: 'text', text: workspaceState.assembly.accumulatedOutput },
        ],
      } as ChatMessages);
    }
  }

  // ---------------------------------------------------------------------------
  // Message modification
  // ---------------------------------------------------------------------------

  prependTextToUserMessage(messages: ChatMessages[], text: string): void {
    if (!text.trim()) return;
    const lastUserMsg = messages.findLast((m) => m.role === 'user');
    if (!lastUserMsg || !('content' in lastUserMsg)) return;

    if (typeof lastUserMsg.content === 'string') {
      (lastUserMsg as any).content = text + lastUserMsg.content;
    } else if (Array.isArray(lastUserMsg.content)) {
      const firstTextPart = (lastUserMsg.content as ChatContentItems[]).find(
        (p) => p.type === 'text',
      );
      if (firstTextPart && 'text' in firstTextPart) {
        (firstTextPart as any).text = text + (firstTextPart as any).text;
      } else {
        (lastUserMsg.content as ChatContentItems[]).unshift({
          type: 'text',
          text,
        });
      }
    }
  }

  async addMediaToUserMessage(
    messages: ChatMessages[],
    mediaFiles: FileLocation[],
  ): Promise<void> {
    if (!mediaFiles.length || !this.capabilities.supportsVision) return;
    const lastUserMsg = messages.findLast((m) => m.role === 'user');
    if (!lastUserMsg || !('content' in lastUserMsg)) return;

    try {
      const formattedMedia = await this.createMediaMessage(mediaFiles);
      if (typeof lastUserMsg.content === 'string') {
        (lastUserMsg as any).content = [
          ...formattedMedia,
          { type: 'text', text: lastUserMsg.content },
        ];
      } else if (Array.isArray(lastUserMsg.content)) {
        (lastUserMsg.content as ChatContentItems[]).unshift(...formattedMedia);
      }
    } catch (err) {
      this.logger.error(
        `Error adding media to user message: ${getSdkErrorMessage(err)}`,
        {
          data: buildErrorLogData(err, {
            operation: 'add media to user message',
          }),
          messageType: MESSAGE_TYPES.ERROR,
        },
      );
    }
  }
}
