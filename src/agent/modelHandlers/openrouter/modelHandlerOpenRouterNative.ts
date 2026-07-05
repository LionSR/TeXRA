// Third-party imports
import { OpenRouter } from '@openrouter/sdk';
import {
  ConnectionError as OpenRouterConnectionError,
  RequestTimeoutError as OpenRouterRequestTimeoutError,
} from '@openrouter/sdk/models/errors';
import { ModelProvider } from 'llm-zoo';

// Local imports - agent
import { logSdkError, type StreamHandle } from '@agent/trace';
import { parseToolInput } from '@agent/core/flows/toolUseRound/toolCallParsing';
import type { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import type { MediaEntry } from '@agent/utils/mediaTypes';
import { K_SLICE } from '@agent/core/constants';
import {
  annotateStreamFailure,
  detectStatusCode,
  takeTail,
  PARTIAL_TEXT_TAIL_MAX,
} from '@common/errors/sdkErrorUtils';
import replacementEngine from '@replacement/engine';

// Local imports - tools and utils
import type { FileLocation } from '@shared/schemas';
import type {
  ToolFileAttachment,
  ToolResult,
} from '@shared/schemas/toolResult';
import { isNonEmptyString } from '@utils/core';
import { extractMimeSubtype, joinNonEmpty } from '@utils/text/stringUtils';
import {
  computeOpenRouterPrice,
  normalizeOpenRouterUsage,
} from './openRouterUsage';
import { tagOpenRouterSdkError } from './openRouterSdkError';

// Local file imports
import { OPENAI_CHAT_FINISH } from '../types/StopReasonTypes';
import { toOpenAITools } from '../toolConversion';
import {
  checkBatchedToolCalls,
  insertMediaIntoChatUserMessage,
  prependTextToChatUserMessage,
} from '../openai/openAIMessageUtils';
import {
  formatAttachmentSummary,
  formatToolResultAsText,
} from '../utils/toolAttachmentUtils';
import { extractTextFromReasoningDetails } from '../utils/openRouterReasoning';
import {
  OpenRouterStreamAggregator,
  toOpenRouterReasoningEffort,
} from './openRouterStreaming';
import { ModelHandler } from '../ModelHandler';
import {
  CLIENT_COMPACTION_SUMMARY_MAX_TOKENS,
  COMPACTION_SYSTEM_PROMPT,
} from '../contextManagementConstants';
import type {
  ChatResult,
  ChatUsage,
  ChatMessages,
  ChatAssistantMessage,
  ChatUserMessage,
  ChatToolCall,
  ChatContentItems,
  ChatContentText,
  ChatRequest,
} from '@openrouter/sdk/models';
import type {
  CreateResponseOptions,
  CreateResponseResult,
  ExtractResponseResult,
  OpenRouterToolCall,
} from '../types/IModelHandler';

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
  OpenRouterToolCall,
  OpenRouter,
  ChatResult,
  ChatContentItems
> {
  // ── Client-side compaction state ──────────────────────────────────────
  private lastKnownInputTokens = 0;

  override get supportsManualCompaction(): boolean {
    return this.isToolUseMode();
  }

  /**
   * OpenRouter proxies multiple underlying providers behind a single handler
   * class (config.provider is preserved through routing), so batching must be
   * decided by the routed-through provider rather than the handler class —
   * mirroring the Google/DeepSeek/Kimi/MiniMax direct-handler overrides.
   */
  override get requiresBatchedParallelToolResults(): boolean {
    return this.isGoogle || this.isDeepSeek || this.isKimi || this.isMiniMax;
  }

  /**
   * DeepSeek (proxied via OpenRouter) honors a reasoning-level override whenever
   * it supports reasoning, even without a granular configurable-effort capability.
   */
  override get supportsReasoningLevelOverride(): boolean {
    return (
      this.capabilities.supportsReasoningEffort ||
      (this.isDeepSeek && this.capabilities.supportsReasoning)
    );
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

  override isAutoRetryManagedByProvider(error: Error): boolean {
    if (
      error instanceof OpenRouterConnectionError ||
      error instanceof OpenRouterRequestTimeoutError
    ) {
      return true;
    }

    const statusCode = detectStatusCode(error);
    // @openrouter/sdk v0.13.21 defaults chatSend retryCodes to ["5XX"];
    // 429/408 HTTP responses remain owned by TeXRA's flow retry.
    return statusCode !== undefined && statusCode >= 500;
  }

  // ---------------------------------------------------------------------------
  // createResponse
  // ---------------------------------------------------------------------------

  protected override get sdkErrorTagger() {
    return tagOpenRouterSdkError;
  }

  /** Creates an OpenRouter response after SDK-boundary error tagging is installed. */
  protected override async createResponseImpl(
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

    if (this.shouldCompactByInputTokens(this.lastKnownInputTokens)) {
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
      const aggregator = new OpenRouterStreamAggregator();
      let thinking: StreamHandle | undefined;
      let output: StreamHandle | undefined;
      let streamConnected = false;

      try {
        const stream = await client.chat.send(
          { chatRequest: streamRequest },
          { signal },
        );
        streamConnected = true;
        // Opened after the SDK request-retry boundary returns; the deferred
        // starts fire (if ever) at the first reasoning/content delta.
        thinking = this.createThinkingStream();
        output = this.createOutputStream();

        for await (const chunk of stream) {
          const { contentDelta, reasoningDelta } =
            aggregator.consumeChunk(chunk);
          if (reasoningDelta) thinking.append(reasoningDelta);
          if (contentDelta) output.append(contentDelta);
        }

        const response = aggregator.buildResponse();
        const finalReasoning = this.processThinkingBlock(response);
        thinking.finalize(finalReasoning ?? undefined);
        const finalOutput = response.choices?.[0]?.message?.content ?? '';
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
        // the progress view from being stuck in a loading state. No explicit
        // final text so any chunks already streamed are preserved (passing `''`
        // would overwrite the visible partial output).
        thinking?.finalize(undefined);
        output?.finalize();
        // Lift the accumulated partial text onto the error so the retry UI
        // can show the tail (parity with the other streaming providers).
        const partialTail = takeTail(
          aggregator.partialContent,
          PARTIAL_TEXT_TAIL_MAX,
        );
        annotateStreamFailure(
          err,
          partialTail,
          streamConnected || partialTail.length > 0,
        );
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

  private async compactConversation(
    client: OpenRouter,
    messages: ChatMessages[],
    signal?: AbortSignal,
  ): Promise<{ compactedMessages: ChatMessages[]; didCompact: boolean }> {
    return this.runClientCompaction(
      messages,
      this.lastKnownInputTokens,
      async (conversationMessages) => {
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
        return {
          summaryText:
            typeof summaryText === 'string' ? summaryText.trim() : '',
          outputTokens: summaryResponse.usage?.completionTokens ?? 0,
        };
      },
      (summary) => ({
        role: 'user',
        content: `[Previous conversation summary]\n\n${summary}`,
      }),
    );
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
      messages.push({
        role,
        content: [{ type: 'text', text: systemPrompt }],
      });
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
    } else {
      messages.push({
        role: requestRole,
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
        this.logger.error('Error processing media files for follow-up round', {
          data: err,
        });
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
    return joinNonEmpty(
      (msg.content as ChatContentItems[])
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text),
    );
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
        const audioFormat = extractMimeSubtype(media.media_type).toLowerCase();
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

    newResponse = this.appendEndTagIfNeeded(
      newResponse,
      endTag,
      stopReason === OPENAI_CHAT_FINISH.STOP,
    );
    newResponse = replacementEngine.applyAll(newResponse);

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
    return computeOpenRouterPrice(responseUsage, this.standardPricingConfig());
  }

  normalizeUsage(
    rawUsage: ChatUsage | null,
    responseTimeMs: number,
  ): NormalizedUsage {
    return normalizeOpenRouterUsage(
      rawUsage,
      responseTimeMs,
      this.usageProvider,
      this.standardPricingConfig(),
    );
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
    this.applyStringReasoningToWorkspaceState(reasoning, workspaceState);
    this.logger.debug('Reasoning content preview', {
      data: reasoning.slice(0, K_SLICE),
    });
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
        input: parseToolInput(call.function.arguments, call.id, this.logger),
        raw: call,
      }));
  }

  async createToolUseFollowUpMessages(
    _client: OpenRouter | undefined,
    call: OpenRouterToolCall,
    result: ToolResult,
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
    results: ToolResult[],
    _attachmentsPerCall: ToolFileAttachment[][],
    _workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<ChatMessages[]> {
    if (!checkBatchedToolCalls(calls.length, results.length)) return [];

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

  protected override get shouldPrependPrefillOnResumeWithoutAssistantPrefill(): boolean {
    return true;
  }

  protected appendUserText(
    messages: ChatMessages[],
    text: string,
    placement: 'last-user' | 'continuation',
  ): void {
    if (placement === 'continuation') {
      const role = this.capabilities.supportsIntermDevMsgs ? 'system' : 'user';
      messages.push({
        role,
        content: [{ type: 'text', text }],
      } as ChatMessages);
      return;
    }

    const lastMessage = messages.at(-1);
    if (lastMessage && Array.isArray(lastMessage.content)) {
      (lastMessage.content as ChatContentItems[]).push({ type: 'text', text });
      return;
    }
    if (lastMessage && typeof lastMessage.content === 'string') {
      (lastMessage as ChatUserMessage).content = [
        { type: 'text', text: lastMessage.content },
        { type: 'text', text },
      ];
      return;
    }
    messages.push({
      role: 'user',
      content: [{ type: 'text', text }],
    } as ChatMessages);
  }

  // ---------------------------------------------------------------------------
  // Prefill / output initialization
  // ---------------------------------------------------------------------------

  protected appendTextToLastAssistantMessage(
    messages: ChatMessages[],
    text: string,
    options: { afterContinuationPrompt?: boolean; fallbackText?: string } = {},
  ): boolean {
    let targetIndex = messages.length - 1;
    const trailingMessage = messages.at(-1);

    if (options.afterContinuationPrompt) {
      if (this.isAnthropicViaOpenRouter) return false;
      if (
        !trailingMessage ||
        (trailingMessage.role !== 'user' && trailingMessage.role !== 'system')
      ) {
        return false;
      }
      if (!this.containCutOffMessage(trailingMessage.content)) return false;
      targetIndex = messages.length - 2;
    }

    const targetMessage = messages.at(targetIndex);
    if (targetMessage?.role !== 'assistant') return false;

    const message = targetMessage as ChatAssistantMessage;
    if (Array.isArray(message.content)) {
      if (this.isAnthropicViaOpenRouter && !options.afterContinuationPrompt) {
        const lastPart = (message.content as ChatContentItems[]).at(-1);
        if (lastPart && 'text' in lastPart) {
          (lastPart as ChatContentText).text = text;
        }
      } else {
        (message.content as ChatContentItems[]).push({ type: 'text', text });
      }
    } else {
      message.content = [
        {
          type: 'text',
          text: options.fallbackText ?? text,
        },
      ];
    }

    if (options.afterContinuationPrompt && trailingMessage?.role === 'user') {
      messages.pop();
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Message modification
  // ---------------------------------------------------------------------------

  prependTextToUserMessage(messages: ChatMessages[], text: string): void {
    prependTextToChatUserMessage(messages, text);
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
      insertMediaIntoChatUserMessage(lastUserMsg, formattedMedia);
    } catch (err) {
      logSdkError(this.logger, 'Error adding media to user message', err, {
        operation: 'add media to user message',
      });
    }
  }
}
