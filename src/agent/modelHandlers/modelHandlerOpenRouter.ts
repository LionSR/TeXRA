// Third-party imports
import OpenAI from 'openai';
import { OpenRouter } from '@openrouter/sdk';
import { isAssistantMessage } from 'openai/lib/chatCompletionUtils';

/**
 * OpenRouter reasoning_details item type.
 *
 * Equivalent to Schema19 in `@openrouter/sdk`, defined locally because
 * the SDK's subpath exports require `moduleResolution: "node16"` or higher.
 *
 * @see https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
 */
type ReasoningDetailItem =
  | { type: 'reasoning.text'; text?: string | null }
  | { type: 'reasoning.encrypted'; data: string }
  | { type: 'reasoning.summary'; summary: string };

// Local imports - agent
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import { isNonEmptyString } from '@utils/core';

// Local file imports
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import { toOpenAITools } from './toolConversion';
import type {
  CreateResponseOptions,
  CreateResponseResult,
} from './types/IModelHandler';
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';

// ============================================================================
// Message & Response Conversion (OpenAI ↔ OpenRouter SDK)
// ============================================================================

/**
 * Remap snake_case keys in a content part to SDK camelCase.
 *
 * The SDK's outbound Zod schemas expect camelCase fields and remap them to
 * snake_case for the HTTP wire format. Passing OpenAI's snake_case directly
 * causes the SDK to strip the fields during validation.
 *
 * Remapped: image_url → imageUrl, input_audio → inputAudio, video_url → videoUrl
 */
function toOpenRouterContentPart(
  part: Record<string, unknown>,
): Record<string, unknown> {
  const { image_url, input_audio, video_url, ...rest } = part;
  const out: Record<string, unknown> = { ...rest };
  if (image_url !== undefined) out.imageUrl = image_url;
  if (input_audio !== undefined) out.inputAudio = input_audio;
  if (video_url !== undefined) out.videoUrl = video_url;
  return out;
}

/**
 * Remap content parts in a message when the content is an array.
 * Strings are passed through unchanged.
 */
function toOpenRouterContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part: unknown) =>
    typeof part === 'object' && part !== null
      ? toOpenRouterContentPart(part as Record<string, unknown>)
      : part,
  );
}

/**
 * Convert OpenAI-format messages (snake_case) to OpenRouter SDK format (camelCase).
 *
 * The SDK's Zod schemas validate camelCase fields and remap them to snake_case
 * for the HTTP request. Passing OpenAI's snake_case directly would cause the
 * fields to be stripped during validation.
 *
 * Fields remapped:
 * - assistant.tool_calls → toolCalls
 * - tool.tool_call_id → toolCallId
 * - content part: image_url → imageUrl, input_audio → inputAudio, video_url → videoUrl
 */
function toOpenRouterMessages(
  messages: ChatCompletionMessageParam[],
): unknown[] {
  return messages.map((msg) => {
    const raw = msg as unknown as Record<string, unknown>;

    if (msg.role === 'assistant') {
      const result: Record<string, unknown> = {
        ...raw,
        content: toOpenRouterContent(raw.content),
      };
      if (raw.tool_calls) {
        result.toolCalls = raw.tool_calls;
        delete result.tool_calls;
      }
      return result;
    }

    if (msg.role === 'tool') {
      const { tool_call_id, ...rest } = raw;
      return { ...rest, toolCallId: tool_call_id };
    }

    // system / user / developer - only need content part remapping
    if (Array.isArray(raw.content)) {
      return { ...raw, content: toOpenRouterContent(raw.content) };
    }
    return msg;
  });
}

/**
 * Convert OpenRouter SDK camelCase usage to OpenAI snake_case format.
 */
function toOpenAIUsage(
  sdkUsage: Record<string, unknown> | undefined,
): ChatCompletion['usage'] | undefined {
  if (!sdkUsage) return undefined;

  const usage: Record<string, unknown> = {
    prompt_tokens: (sdkUsage.promptTokens as number) ?? 0,
    completion_tokens: (sdkUsage.completionTokens as number) ?? 0,
    total_tokens: (sdkUsage.totalTokens as number) ?? 0,
  };

  const completionDetails = sdkUsage.completionTokensDetails as
    | Record<string, unknown>
    | undefined;
  if (completionDetails) {
    usage.completion_tokens_details = {
      reasoning_tokens: completionDetails.reasoningTokens ?? undefined,
    };
  }

  const promptDetails = sdkUsage.promptTokensDetails as
    | Record<string, unknown>
    | undefined;
  if (promptDetails) {
    usage.prompt_tokens_details = {
      cached_tokens: promptDetails.cachedTokens ?? undefined,
    };
  }

  return usage as unknown as ChatCompletion['usage'];
}

/**
 * Convert an OpenRouter SDK non-streaming response to OpenAI ChatCompletion format.
 *
 * The SDK deserializes API responses into camelCase TypeScript objects.
 * The rest of the handler chain expects OpenAI's snake_case format.
 */
function toOpenAIChatCompletion(
  sdkResponse: Record<string, unknown>,
): ChatCompletion {
  const choices = sdkResponse.choices as Array<Record<string, unknown>>;

  return {
    id: sdkResponse.id as string,
    object: 'chat.completion',
    created: sdkResponse.created as number,
    model: sdkResponse.model as string,
    choices: (choices ?? []).map((choice) => {
      const message = choice.message as Record<string, unknown>;
      const toolCalls = message?.toolCalls as
        | Array<Record<string, unknown>>
        | undefined;

      // Build message object imperatively to avoid spread-type issues
      // with Record<string, unknown> fields
      const openAIMessage: Record<string, unknown> = {
        role: 'assistant',
        content: (message?.content as string) ?? null,
      };
      if (toolCalls?.length) openAIMessage.tool_calls = toolCalls;
      if (message?.reasoning != null)
        openAIMessage.reasoning = message.reasoning;
      if (message?.reasoningDetails)
        openAIMessage.reasoning_details = message.reasoningDetails;

      return {
        index: (choice.index as number) ?? 0,
        finish_reason: (choice.finishReason as string) ?? 'stop',
        message: openAIMessage,
        logprobs: (choice.logprobs as null) ?? null,
      };
    }),
    usage: toOpenAIUsage(
      sdkResponse.usage as Record<string, unknown> | undefined,
    ),
  } as unknown as ChatCompletion;
}

// ============================================================================
// Streaming Aggregator
// ============================================================================

/** Extract text content from a reasoning detail item by type. */
function getReasoningItemText(item: ReasoningDetailItem): string | undefined {
  if (item.type === 'reasoning.text') return item.text ?? undefined;
  if (item.type === 'reasoning.summary') return item.summary;
  // 'reasoning.encrypted' - encrypted content is not useful for display
  return undefined;
}

/**
 * Extracts text content from OpenRouter reasoning_details array.
 * @see https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
 */
function extractTextFromReasoningDetails(
  details: ReasoningDetailItem[] | unknown,
): string {
  if (!Array.isArray(details)) {
    return typeof details === 'string' ? details : '';
  }

  return details
    .filter(
      (item): item is ReasoningDetailItem => !!item && typeof item === 'object',
    )
    .map(getReasoningItemText)
    .filter((text): text is string => !!text)
    .join('');
}

/**
 * Accumulates OpenRouter SDK streaming chunks into a final ChatCompletion.
 *
 * Replaces the OpenAI SDK's `.finalChatCompletion()` / `.totalUsage()` methods
 * which are not available on the OpenRouter SDK's EventStream.
 */
class OpenRouterStreamAggregator {
  private id = '';
  private model = '';
  private created = 0;
  private content = '';
  private finishReason: string | null = null;
  private usage: Record<string, unknown> | null = null;
  private reasoning = '';
  private toolCallsMap = new Map<
    number,
    {
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }
  >();

  /**
   * Consume a single streaming chunk, extracting content and reasoning deltas.
   * Returns the deltas for real-time display via thinking/output streams.
   */
  consumeChunk(chunk: Record<string, unknown>): {
    contentDelta: string;
    reasoningDelta: string;
  } {
    if (chunk.id) this.id = chunk.id as string;
    if (chunk.model) this.model = chunk.model as string;
    if (chunk.created) this.created = chunk.created as number;
    if (chunk.usage) this.usage = chunk.usage as Record<string, unknown>;

    const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    if (!choice) return { contentDelta: '', reasoningDelta: '' };

    if (choice.finishReason) {
      this.finishReason = choice.finishReason as string;
    }

    const delta = choice.delta as Record<string, unknown> | undefined;
    if (!delta) return { contentDelta: '', reasoningDelta: '' };

    // Content
    const contentDelta = (delta.content as string) ?? '';
    if (contentDelta) this.content += contentDelta;

    // Reasoning - try reasoningDetails (structured) then reasoning (string)
    let reasoningDelta = '';
    if (delta.reasoningDetails && Array.isArray(delta.reasoningDetails)) {
      reasoningDelta = extractTextFromReasoningDetails(
        delta.reasoningDetails as ReasoningDetailItem[],
      );
    } else if (delta.reasoning) {
      reasoningDelta = delta.reasoning as string;
    }
    if (reasoningDelta) this.reasoning += reasoningDelta;

    // Accumulate tool calls by index
    const toolCalls = delta.toolCalls as
      | Array<Record<string, unknown>>
      | undefined;
    if (toolCalls) {
      for (const tc of toolCalls) {
        const index = (tc.index as number) ?? 0;
        const fn = tc.function as Record<string, unknown> | undefined;
        const existing = this.toolCallsMap.get(index);

        if (existing) {
          if (fn?.arguments) existing.function.arguments += fn.arguments;
          if (fn?.name) existing.function.name += fn.name;
        } else {
          this.toolCallsMap.set(index, {
            id: (tc.id as string) ?? '',
            type: (tc.type as string) ?? 'function',
            function: {
              name: (fn?.name as string) ?? '',
              arguments: (fn?.arguments as string) ?? '',
            },
          });
        }
      }
    }

    return { contentDelta, reasoningDelta };
  }

  /** Build a ChatCompletion from accumulated streaming data. */
  toChatCompletion(): ChatCompletion {
    const toolCalls = Array.from(this.toolCallsMap.values());

    return {
      id: this.id,
      object: 'chat.completion',
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          finish_reason: this.finishReason ?? 'stop',
          message: {
            role: 'assistant' as const,
            content: this.content || null,
            ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
            ...(this.reasoning && { reasoning: this.reasoning }),
          },
          logprobs: null,
        },
      ],
      usage: toOpenAIUsage(this.usage ?? undefined),
    } as ChatCompletion;
  }
}

// ============================================================================
// Hook for injecting parameters the SDK doesn't support yet
// ============================================================================

/**
 * Parameters that OpenRouter's API accepts but the SDK's Zod schemas
 * strip during validation. Injected via a beforeRequest hook.
 *
 * - `include_reasoning`: tells OpenRouter to return reasoning content in the
 *   response for O1-style models
 * - `reasoning.enabled`: enables reasoning for DeepSeek V3.2 and similar models
 */
interface NonSDKParams {
  include_reasoning?: boolean;
  reasoning?: { enabled: boolean };
}

/**
 * Creates a beforeRequest hook that injects extra body parameters the SDK
 * doesn't natively support. Deep-merges nested objects (e.g., reasoning).
 *
 * The `nonSDKParams` are captured by reference from the caller, so the
 * same value is applied on every invocation (including SDK retries).
 */
function createParamInjectionHook(nonSDKParams: NonSDKParams) {
  return {
    beforeRequest: async (
      _ctx: unknown,
      request: Request,
    ): Promise<Request> => {
      const cloned = request.clone();
      const bodyText = await cloned.text();
      try {
        const parsed = JSON.parse(bodyText) as Record<string, unknown>;
        for (const [key, value] of Object.entries(nonSDKParams)) {
          // Deep merge for nested objects (e.g., reasoning)
          if (
            typeof value === 'object' &&
            value !== null &&
            !Array.isArray(value) &&
            typeof parsed[key] === 'object' &&
            parsed[key] !== null
          ) {
            Object.assign(
              parsed[key] as Record<string, unknown>,
              value as Record<string, unknown>,
            );
          } else {
            parsed[key] = value;
          }
        }
        return new Request(request, { body: JSON.stringify(parsed) });
      } catch {
        return request;
      }
    },
  };
}

// ============================================================================
// Handler
// ============================================================================

/**
 * Handler for models accessed through OpenRouter, using the native
 * `@openrouter/sdk` for API calls.
 *
 * Extends ModelHandlerOpenAI to inherit message formatting, tool extraction,
 * and response processing logic. Overrides `createResponse()` to use the
 * OpenRouter SDK's `chat.send()` with proper type-safe parameters.
 */
export class ModelHandlerOpenRouter extends ModelHandlerOpenAI {
  protected override get usageProvider(): NormalizedUsage['provider'] {
    return 'openrouter';
  }

  /**
   * Creates a native OpenRouter SDK client.
   *
   * Uses the SDK's built-in configuration for:
   * - API key authentication
   * - X-Title header (app identification)
   * - Base URL (with optional override for proxies/relays)
   * - A beforeRequest hook to inject parameters the SDK doesn't yet support
   *
   * @param nonSDKParams - Extra body parameters to inject via beforeRequest hook.
   *   Captured by the hook closure so retries re-apply the same values.
   */
  private async createNativeClient(
    nonSDKParams?: NonSDKParams,
  ): Promise<OpenRouter> {
    const apiKey = await this.getApiKey();
    const baseURL = this.getBaseUrl();
    this.logger.debug(
      `Creating native OpenRouter SDK client. Base URL: ${baseURL ?? 'default'}`,
    );

    const hooks = nonSDKParams ? [createParamInjectionHook(nonSDKParams)] : [];

    return new OpenRouter({
      apiKey,
      xTitle: 'TeXRA.ai',
      ...(baseURL && { serverURL: baseURL }),
      hooks,
    });
  }

  /**
   * Creates a response using the native OpenRouter SDK.
   *
   * Builds SDK-typed request parameters, handles streaming via
   * OpenRouterStreamAggregator, and converts responses back to
   * OpenAI ChatCompletion format for the rest of the handler chain.
   */
  override async createResponse(
    options: CreateResponseOptions<ChatCompletionMessageParam, OpenAI>,
  ): Promise<CreateResponseResult<ChatCompletion, ChatCompletionMessageParam>> {
    const { messages, temperature, endTag, signal, tools } = options;
    const useStreaming = this.getStreamingConfig();

    // Build SDK request parameters (camelCase for SDK validation)
    const chatParams: Record<string, unknown> = {
      model: this.config.openrouterFullName,
      messages: toOpenRouterMessages(messages),
      maxTokens: this.getEffectiveMaxOutputTokens(),
      temperature,
    };

    // Reasoning parameters - use SDK's `reasoning` field where possible,
    // inject unsupported params via the beforeRequest hook.
    // nonSDKParams is computed upfront and captured by the hook closure
    // so retries re-apply the same values.
    let nonSDKParams: NonSDKParams | undefined;
    if (this.capabilities.supportsReasoning) {
      if (
        this.capabilities.supportsReasoningEffort &&
        this.capabilities.reasoningEffort
      ) {
        // O1-style models: SDK supports reasoning.effort natively
        chatParams.reasoning = {
          effort: this.validateReasoningEffort(
            this.capabilities.reasoningEffort,
          ),
        };
        // SDK doesn't support include_reasoning yet - inject via hook
        nonSDKParams = { include_reasoning: true };
      } else {
        // DeepSeek V3.2 and similar: SDK doesn't support reasoning.enabled
        // Send empty reasoning object to SDK, inject enabled via hook
        chatParams.reasoning = {};
        nonSDKParams = { reasoning: { enabled: true } };
      }
    }

    const nativeClient = await this.createNativeClient(nonSDKParams);

    if (tools && tools.length > 0) {
      chatParams.tools = toOpenAITools(tools);
      chatParams.toolChoice = 'auto';
    }

    if (endTag) {
      chatParams.stop = [endTag];
    }

    if (useStreaming) {
      chatParams.stream = true;
      chatParams.streamOptions = { includeUsage: true };

      const stream = (await nativeClient.chat.send(
        { chatGenerationParams: chatParams as any },
        { signal },
      )) as unknown as AsyncIterable<Record<string, unknown>>;

      const thinking = this.createThinkingStream();
      const output = this.isOutputStreamingEnabled()
        ? this.createOutputStream()
        : undefined;
      const aggregator = new OpenRouterStreamAggregator();

      for await (const chunk of stream) {
        const { contentDelta, reasoningDelta } = aggregator.consumeChunk(chunk);
        if (reasoningDelta) thinking.append(reasoningDelta);
        if (contentDelta) output?.append(contentDelta);
      }

      const response = aggregator.toChatCompletion();
      const finalReasoning = this.processThinkingBlock(response);
      thinking.finalize(finalReasoning ?? undefined);
      const finalOutput = response.choices?.[0]?.message?.content ?? '';
      if (output) output.finalize(finalOutput);
      return { response };
    }

    // Non-streaming path
    chatParams.stream = false;
    const sdkResponse = await nativeClient.chat.send(
      { chatGenerationParams: chatParams as any },
      { signal },
    );
    const response = toOpenAIChatCompletion(
      sdkResponse as unknown as Record<string, unknown>,
    );
    return { response };
  }

  /**
   * OpenRouter returns reasoning in different formats:
   * - reasoning_details: array of objects (normalized format, see ReasoningDetailItem)
   * - reasoning: string (simple format)
   *
   * @see https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
   */
  protected override extractReasoningFromMessage(
    message: Record<string, unknown> | undefined,
  ): string | null {
    // Try reasoning_details first (OpenRouter normalized format - array of objects)
    const reasoningDetails = message?.reasoning_details;
    if (reasoningDetails) {
      const extracted = extractTextFromReasoningDetails(reasoningDetails);
      if (extracted) return extracted;
    }

    // Fall back to simple reasoning field (string)
    return isNonEmptyString(message?.reasoning) ? message.reasoning : null;
  }
}

/**
 * Handler for Anthropic models using OpenAI-compatible API via OpenRouter.
 */
export class ModelHandlerAnthropicViaOpenRouter extends ModelHandlerOpenRouter {
  updateMessageContentWithPrefill(
    messages: any[],
    bestConnector: string,
    newResponse: string,
    workspaceState: AgentWorkspaceState,
  ): void {
    const lastMessage = messages.at(-1);
    // although OpenAI models do not support assistant prefill, some models (such as Anthropic/DeepSeek perhaps?) via OpenRouter might do
    if (isAssistantMessage(lastMessage)) {
      if (Array.isArray(lastMessage.content)) {
        // is this correct? it looks like we should attach previous response too.
        const lastPart = lastMessage.content.at(-1);
        if (lastPart && 'text' in lastPart) {
          lastPart.text = bestConnector + newResponse;
        }
      } else if (typeof lastMessage.content === 'string') {
        lastMessage.content = [
          {
            type: 'text',
            text: workspaceState.assembly.accumulatedOutput,
          },
        ];
      }
    }
  }

  /** Updates message content for models with prefill support. */
  updateMessageContentWithoutPrefill(
    messages: any[],
    _bestConnector: string,
    _newResponse: string,
    workspaceState: AgentWorkspaceState,
  ): void {
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
      });
    }
  }
}
