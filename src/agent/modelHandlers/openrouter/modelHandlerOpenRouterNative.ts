// Third-party imports
import { HTTPClient, OpenRouter } from '@openrouter/sdk';
import { ModelProvider, ReasoningEffort } from 'llm-zoo';

// Local imports
import type { StreamHandle } from '@agent/trace';
import { parseToolInput } from '@agent/core/flows/toolUseRound/toolCallParsing';
import type { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import type { MediaEntry } from '@agent/utils/mediaTypes';
import { K_SLICE } from '@agent/core/constants';
import { OPENAI_CHAT_FINISH } from '@agent/types/StopReasonTypes';
import type {
  CreateResponseOptions,
  CreateResponseResult,
  ExtractResponseResult,
  ModelCredentialSelection,
  OpenRouterToolCall,
} from '@agent/types/ModelHandlerContracts';
import {
  handleStreamingFailure,
  takeTail,
  PARTIAL_TEXT_TAIL_MAX,
} from '@common/errors/sdkErrorUtils';
import type { FileLocation, MediaAttachmentKind } from '@shared/schemas';
import type {
  ToolFileAttachment,
  ToolResult,
} from '@shared/schemas/toolResult';
import { isNonEmptyString } from '@utils/core';
import { extractMimeSubtype } from '@utils/text/stringUtils';

// Local file imports
import { toDataUrl } from '../support/dataUrl';
import { auxiliaryRetry } from '../support/auxiliaryRetry';
import {
  classifyMediaEntry,
  unknownMediaCategoryWarning,
} from '../support/mediaClassification';
import { getDeclaredMaxReasoningEffort } from '../support/reasoningEffort';
import { OPENROUTER_BASE_URL } from '../support/ProxyConfigResolver';
import {
  resolveMoonshotRequestParameters,
  type MoonshotRequestParameters,
} from '../support/moonshotRequestParameters';
import {
  computeOpenRouterPrice,
  normalizeOpenRouterUsage,
} from './openRouterUsage';
import { tagOpenRouterSdkError } from './openRouterSdkError';
import { toOpenAITools } from '../toolConversion';
import {
  appendUserTextToChatMessages,
  createChatRoundMessages,
  createChatUserFollowUpMessages,
  extractChatAssistantText,
  initializeChatMessages,
  insertMediaIntoChatUserMessage,
  prependTextToChatUserMessage,
} from '../openai/openAIMessageUtils';
import { formatToolResultTextWithAttachments } from '../utils/toolAttachmentUtils';
import { extractTextFromReasoningDetails } from '../utils/openRouterReasoning';
import {
  OpenRouterStreamAggregator,
  toOpenRouterReasoningEffort,
} from './openRouterStreaming';
import { ModelHandler } from '../ModelHandler';
import { CLIENT_COMPACTION_SUMMARY_MAX_TOKENS } from '../contextManagementConstants';

// Third-party imports
import type {
  ChatResult,
  ChatStreamChunk,
  ChatUsage,
  ChatMessages,
  ChatAssistantMessage,
  ChatToolCall,
  ChatContentItems,
  ChatContentText,
  ChatRequest,
} from '@openrouter/sdk/models';

function isOpenRouterChatStream(
  response: unknown,
): response is AsyncIterable<ChatStreamChunk> {
  if (typeof response !== 'object' || response === null) return false;
  return typeof Reflect.get(response, Symbol.asyncIterator) === 'function';
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
  OpenRouterToolCall,
  OpenRouter,
  ChatResult,
  ChatContentItems
> {
  // ── Client-side compaction state ──────────────────────────────────────
  private lastKnownInputTokens = 0;

  /** Client-side compaction is implemented for tool-use sessions regardless of the routed-through provider. */
  override get supportsManualCompaction(): boolean {
    return this.isToolUseMode();
  }

  /**
   * OpenRouter proxies multiple underlying providers behind a single handler
   * class (config.provider is preserved through routing), so batching must be
   * decided by the routed-through provider rather than the handler class —
   * mirroring the Anthropic/Google/DeepSeek/Kimi/MiniMax direct-handler
   * overrides.
   * Keyed on provider identity rather than `capabilities.supportsReasoning`
   * for the same reason those direct-handler overrides are — see the base
   * getter's doc comment (#7101 triage).
   */
  override get requiresBatchedParallelToolResults(): boolean {
    const { provider } = this.config;
    return (
      provider === ModelProvider.ANTHROPIC ||
      provider === ModelProvider.GOOGLE ||
      provider === ModelProvider.DEEPSEEK ||
      provider === ModelProvider.MOONSHOT ||
      provider === ModelProvider.MINIMAX
    );
  }

  protected get usageProvider(): NormalizedUsage['provider'] {
    return 'openrouter';
  }

  /** Whether this is an Anthropic model routed through OpenRouter. */
  private get isAnthropicViaOpenRouter(): boolean {
    return this.config.provider === ModelProvider.ANTHROPIC;
  }

  async getClient(
    selection: ModelCredentialSelection = 'configured',
  ): Promise<OpenRouter> {
    const credential = await this.resolveClientCredential(selection);
    const client = new OpenRouter({
      apiKey: credential.apiKey,
      appTitle: 'TeXRA.ai',
      ...(credential.baseUrl ? { serverURL: credential.baseUrl } : {}),
      httpClient: new HTTPClient({ fetcher: this.longRunningModelFetch }),
      // TeXRA's session gate owns retry timing and admission.
      retryConfig: { strategy: 'none' },
    });
    return this.rememberClientCredentialRoute(
      client,
      credential.route,
      credential.apiKey,
    );
  }

  override getRetryEndpoint(client: OpenRouter): string {
    // ClientSDK declares `_baseURL` as typed public and the SDK's own funcs/
    // modules consume it, making it the supported access path despite the
    // underscore prefix.
    return client._baseURL?.href ?? OPENROUTER_BASE_URL;
  }

  // ---------------------------------------------------------------------------
  // createResponse
  // ---------------------------------------------------------------------------

  protected override get sdkErrorTagger() {
    return tagOpenRouterSdkError;
  }

  /**
   * OpenRouter preserves the underlying provider identity in `config`.
   * DeepSeek rejects named tool choice while thinking mode is enabled,
   * including when the request is routed through OpenRouter.
   */
  override get supportsForcedToolChoice(): boolean {
    return !(
      this.config.provider === ModelProvider.DEEPSEEK &&
      this.capabilities.supportsReasoning
    );
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
      finalTool,
    } = options;

    // Phase 0: COMPACT - Apply the shared trigger before building the request.
    const { compactedMessages, didCompact } =
      await this.maybeCompactByInputTokens(
        rawMessages,
        this.lastKnownInputTokens,
        () => this.compactConversation(client, rawMessages, signal),
      );
    const updatedMessages = didCompact ? compactedMessages : undefined;
    const messagesToUse = updatedMessages ?? rawMessages;

    const useStreaming = this.getStreamingConfig();

    const request: ChatRequest = {
      model: this.config.openrouterFullName,
      messages: messagesToUse,
      maxTokens: this.getEffectiveMaxOutputTokens(),
      ...this.samplingTemperature(temperature),
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
          getDeclaredMaxReasoningEffort(this.config.capabilities) ===
            ReasoningEffort.MAX,
        ),
      };
    }

    if (tools && tools.length > 0) {
      request.tools = toOpenAITools(tools);
      request.toolChoice = finalTool
        ? { type: 'function', function: { name: finalTool.name } }
        : 'auto';
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

      try {
        const stream = await client.chat.send(
          { chatRequest: streamRequest },
          { signal },
        );
        if (!isOpenRouterChatStream(stream)) {
          throw new Error(
            'OpenRouter returned a non-streaming response for a streaming request',
          );
        }
        // Opened after the SDK request-retry boundary returns; the deferred
        // starts fire (if ever) at the first reasoning/content delta.
        thinking = this.createThinkingStream();
        output = this.createOutputStream();
        const thinkingStream = thinking;
        const outputStream = output;

        for await (const chunk of stream) {
          const { contentDelta, reasoningDelta } =
            aggregator.consumeChunk(chunk);
          if (reasoningDelta) thinkingStream.append(reasoningDelta);
          if (contentDelta) outputStream.append(contentDelta);
        }

        const response = aggregator.buildResponse();
        const finalReasoning = this.processThinkingBlock(response);
        thinking.finalize(finalReasoning ?? undefined);
        const finalOutput = response.choices?.[0]?.message?.content ?? '';
        output.finalize(typeof finalOutput === 'string' ? finalOutput : '');

        this.trackInputTokens(response.usage, 'streaming response');
        return { response, updatedMessages };
      } catch (err) {
        return handleStreamingFailure(err, {
          // Ensure progress streams are finalized on error to prevent the
          // progress view from being stuck in a loading state. No explicit
          // final text so any chunks already streamed are preserved (passing
          // `''` would overwrite the visible partial output).
          finalizeOnError: () => {
            thinking?.finalize(undefined);
            output?.finalize();
          },
          // Lift the accumulated partial text onto the error so the retry UI
          // can show the tail (parity with the other streaming providers).
          partialTail: () =>
            takeTail(aggregator.getFullContent(), PARTIAL_TEXT_TAIL_MAX),
        });
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
    if (isOpenRouterChatStream(response)) {
      throw new Error(
        'OpenRouter returned a streaming response for a non-streaming request',
      );
    }

    this.trackInputTokens(response.usage, 'response');
    return { response, updatedMessages };
  }

  /** Records the prompt-token count that drives client-side compaction. */
  private trackInputTokens(
    usage: ChatUsage | undefined,
    responseLabel: string,
  ): void {
    if (usage?.promptTokens) {
      this.lastKnownInputTokens = usage.promptTokens;
      return;
    }
    this.logger.warn(
      `No usage data in ${responseLabel} — token tracking and compaction may be affected`,
    );
  }

  /**
   * Moonshot's fixed request parameters for this model, if any apply.
   * OpenRouter forwards to the same Moonshot backends as the direct
   * ModelHandlerKimi path, so this route applies the same fixed-parameter
   * rules.
   */
  private resolveMoonshotParameters(): MoonshotRequestParameters | undefined {
    return this.config.provider === ModelProvider.MOONSHOT
      ? resolveMoonshotRequestParameters(
          this.config.fullName,
          this.capabilities.supportsReasoning,
        )
      : undefined;
  }

  /**
   * Temperature request params for this model. Returns an empty object when
   * the request must omit `temperature` (e.g. Kimi K3's fixed sampling).
   */
  private samplingTemperature(requested: number | undefined): {
    temperature?: number;
  } {
    const fixed = this.resolveMoonshotParameters();
    const value = fixed ? fixed.temperature : requested;
    return value !== undefined ? { temperature: value } : {};
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
      async (conversationMessages, compactionSystemPrompt) => {
        const moonshotParameters = this.resolveMoonshotParameters();
        const summaryRequest: ChatRequest & { stream: false } = {
          model: this.config.openrouterFullName,
          messages: [
            {
              role: 'system',
              content: compactionSystemPrompt,
            },
            ...conversationMessages,
          ],
          maxTokens: CLIENT_COMPACTION_SUMMARY_MAX_TOKENS,
          ...this.samplingTemperature(0),
          stream: false,
          // Minimize reasoning for summarization — use lowest valid effort
          ...(this.capabilities.supportsReasoningEffort &&
          !moonshotParameters?.disableThinkingInCompactionSummary
            ? { reasoning: { effort: 'low' } }
            : {}),
        };
        const summaryResponse = await auxiliaryRetry(
          () => client.chat.send({ chatRequest: summaryRequest }, { signal }),
          signal,
        );
        if (isOpenRouterChatStream(summaryResponse)) {
          throw new Error(
            'OpenRouter returned a streaming response for a non-streaming request',
          );
        }
        const summaryText = summaryResponse.choices[0]?.message?.content;
        return {
          summaryText:
            typeof summaryText === 'string' ? summaryText.trim() : '',
          outputTokens: summaryResponse.usage?.completionTokens ?? 0,
        };
      },
      (summary) => ({
        role: 'user',
        content: summary,
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
    return initializeChatMessages(
      userPrefix,
      userRequest,
      mediaFiles,
      systemPrompt,
      this.capabilities,
      (files, context) => this.createMediaForRound(files, context),
    );
  }

  async createRoundMessages(
    messages: ChatMessages[],
    userMessage: string,
    mediaFiles?: FileLocation[],
  ): Promise<ChatMessages[]> {
    return createChatRoundMessages(
      messages,
      userMessage,
      mediaFiles,
      this.capabilities,
      (files, context) => this.createMediaForRound(files, context),
    );
  }

  async createUserFollowUpMessages(
    messages: ChatMessages[],
    userMessage: string,
  ): Promise<ChatMessages[]> {
    return createChatUserFollowUpMessages(messages, userMessage);
  }

  createAssistantMessage(text: string): ChatMessages {
    return { role: 'assistant', content: text } as ChatMessages;
  }

  extractAssistantText(message: ChatMessages): string | undefined {
    return extractChatAssistantText(message);
  }

  // ---------------------------------------------------------------------------
  // Media
  // ---------------------------------------------------------------------------

  createMediaContent(mediaMessage: MediaEntry[]): ChatContentItems[] {
    return mediaMessage.flatMap((media): ChatContentItems[] => {
      const classification = classifyMediaEntry(media);

      // PDFs (image-category entries with an application/pdf media type) render
      // through the same image_url path — OpenRouter has no document-specific
      // channel here, matching the other chat-style handlers.
      if (classification === 'image' || classification === 'pdf') {
        return [
          { type: 'text', text: `Image: ${media.file_name}` },
          {
            type: 'image_url',
            imageUrl: {
              url: toDataUrl(media.media_type, media.data),
              detail: 'high',
            },
          } as ChatContentItems,
        ];
      }

      if (classification === 'audio') {
        if (!this.capabilities.supportsNativeAudio) {
          this.logger.warn(
            `Audio input received (${media.file_name}) but native audio is not supported by this model. Skipping.`,
          );
          return [];
        }
        return [
          { type: 'text', text: `Audio: ${media.file_name}` },
          {
            type: 'input_audio',
            inputAudio: {
              data: media.data,
              format: extractMimeSubtype(media.media_type).toLowerCase(),
            },
          } as ChatContentItems,
        ];
      }

      this.logger.warn(unknownMediaCategoryWarning(media));
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
      newResponse = this.normalizeResponseText(msg.content);
    } else if (Array.isArray(msg.content)) {
      newResponse = this.normalizeResponseText(
        (msg.content as ChatContentItems[])
          .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map((p) => p.text)
          .join(''),
      );
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
    newResponse = this.postProcessResponse(newResponse);

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
    workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<ChatMessages[]> {
    // The single-call path is batched-of-one: identical assistant/tool
    // message construction and tool result formatting.
    return this.createBatchedToolUseFollowUpMessages(
      [{ call, result, attachments }],
      workspaceState,
      text,
    );
  }

  async createBatchedToolUseFollowUpMessages(
    entries: Array<{
      call: OpenRouterToolCall;
      result: ToolResult;
      attachments: ToolFileAttachment[];
    }>,
    _workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<ChatMessages[]> {
    if (entries.length === 0) return [];

    const callMsg: ChatMessages = {
      role: 'assistant',
      toolCalls: entries.map(({ call }) => call.raw),
      ...(text ? { content: text } : {}),
    } as ChatMessages;

    const resultMsgs: ChatMessages[] = entries.map(
      ({ call, result, attachments }) =>
        ({
          role: 'tool',
          toolCallId: call.callId,
          content: formatToolResultTextWithAttachments(
            result,
            attachments,
            this.canProcessToolResultAttachments,
          ),
        }) as ChatMessages,
    );

    return [callMsg, ...resultMsgs];
  }

  // ---------------------------------------------------------------------------
  // Stop / continue logic
  // ---------------------------------------------------------------------------

  protected appendUserText(messages: ChatMessages[], text: string): void {
    appendUserTextToChatMessages(
      messages,
      text,
      this.capabilities.supportsIntermDevMsgs,
    );
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
  ): Promise<MediaAttachmentKind[]> {
    if (!mediaFiles.length || !this.capabilities.supportsVision) return [];
    const lastUserMsg = messages.findLast((m) => m.role === 'user');
    if (!lastUserMsg || !('content' in lastUserMsg)) return [];

    const formattedMedia = await this.createMediaForRound(mediaFiles, 'insert');
    if (formattedMedia.length === 0) return [];
    insertMediaIntoChatUserMessage(lastUserMsg, formattedMedia);
    return this.consumeInsertedAttachmentKinds('insert');
  }
}
