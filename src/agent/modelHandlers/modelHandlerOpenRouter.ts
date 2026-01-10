// Third-party imports
import OpenAI from 'openai';
import { isAssistantMessage } from 'openai/lib/chatCompletionUtils';

// Local imports - core utilities

// Local imports - agent
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import { isNonEmptyString } from '@utils/core';

// Local file imports
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import { toOpenAITools } from './toolConversion';
import { executeRequest } from './utils/requestExecutor';
import type { CreateResponseOptions } from './types/IModelHandler';
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';

/** @see https://openrouter.ai/docs/guides/best-practices/reasoning-tokens */
interface ReasoningDetailItem {
  type: 'reasoning.text' | 'reasoning.summary' | 'reasoning.encrypted';
  id?: string | null;
  text?: string;
  summary?: string;
  data?: string;
  signature?: string | null;
}

/**
 * Extracts text content from OpenRouter reasoning_details array.
 * Handles the structured format with type-specific fields.
 */
const extractTextFromReasoningDetails = (
  details: ReasoningDetailItem[] | unknown,
): string => {
  if (!Array.isArray(details)) {
    // Fallback: if it's a string, return it directly
    if (typeof details === 'string') return details;
    return '';
  }

  const textParts: string[] = [];
  for (const item of details) {
    if (!item || typeof item !== 'object') continue;

    switch (item.type) {
      case 'reasoning.text':
        if (item.text) textParts.push(item.text);
        break;
      case 'reasoning.summary':
        if (item.summary) textParts.push(item.summary);
        break;
      case 'reasoning.encrypted':
        // Encrypted content is not useful for display, skip it
        break;
    }
  }

  return textParts.join('');
};

/**
 * Extracts reasoning delta from streaming chunks for OpenRouter.
 * Handles both:
 * - reasoning_details: array of objects (OpenRouter normalized format)
 * - reasoning_content: string (native DeepSeek/other models)
 */
const extractOpenRouterReasoningDelta = (
  chunk: ChatCompletionChunk,
): string => {
  const choice = chunk.choices[0];
  if (!choice) return '';

  const delta = choice.delta as {
    reasoning_details?: ReasoningDetailItem[] | string;
    reasoning_content?: string;
  };

  // Try reasoning_details first (OpenRouter normalized format)
  if ('reasoning_details' in delta && delta.reasoning_details) {
    return extractTextFromReasoningDetails(delta.reasoning_details);
  }

  // Fall back to reasoning_content (native format for some models)
  if ('reasoning_content' in delta && delta.reasoning_content) {
    return delta.reasoning_content;
  }

  return '';
};

/**
 * Handler for models accessed through OpenRouter.
 */
export class ModelHandlerOpenRouter extends ModelHandlerOpenAI {
  protected override get usageProvider(): NormalizedUsage['provider'] {
    return 'openrouter';
  }

  /** Creates a response using OpenRouter's API with model-specific configuration. */
  async createResponse(
    options: CreateResponseOptions<ChatCompletionMessageParam, OpenAI>,
  ): Promise<ChatCompletion> {
    const { client, messages, temperature, endTag, signal, tools } = options;
    // Get streaming config
    const useStreaming = this.getStreamingConfig();

    const kwargs: any = {
      model: this.config.openrouterFullName, // Use OpenRouter model name
      messages,
      max_tokens: this.config.maxOutputTokens,
      temperature,
      extra_headers: { 'X-Title': 'TeXRA.ai' },
    };

    // Reasoning parameters vary by model via OpenRouter:
    // - O1-style models: use reasoning.effort + include_reasoning
    // - DeepSeek V3.2: use reasoning.enabled (no include_reasoning needed,
    //   reasoning_details is returned automatically when enabled)
    if (this.config.capabilities.supportsReasoning) {
      if (
        this.config.capabilities.supportsReasoningEffort &&
        this.config.capabilities.reasoningEffort
      ) {
        // O1-style models with effort levels
        kwargs.reasoning = {
          effort: this.validateReasoningEffort(
            this.config.capabilities.reasoningEffort,
          ),
        };
        kwargs.include_reasoning = true;
      } else {
        // DeepSeek V3.2 and similar models - just enable reasoning
        kwargs.reasoning = { enabled: true };
      }
    }

    if (tools && tools.length > 0) {
      kwargs.tools = toOpenAITools(tools);
      kwargs.tool_choice = 'auto';
    }

    if (endTag) {
      kwargs.stop = [endTag];
    }

    if (useStreaming) {
      kwargs.stream_options = { include_usage: true }; // Assuming OpenRouter passes this through
      const stream = await executeRequest(
        {
          model: this.config.name,
          operation: 'openrouter.chat.completions.stream',
          signal,
        },
        () => client.chat.completions.stream(kwargs, { signal }),
      );
      const thinking = this.createThinkingStream();
      const output = this.isOutputStreamingEnabled()
        ? this.createOutputStream()
        : undefined;
      for await (const chunk of stream) {
        const reasoningDelta = extractOpenRouterReasoningDelta(chunk);
        const contentDelta = chunk.choices[0]?.delta?.content ?? '';
        if (reasoningDelta) thinking.append(reasoningDelta);
        if (contentDelta) output?.append(contentDelta);
      }

      // Note that there is no second consumption problem
      // But i am not sure about openrouter's stream api, whether it works for every model.
      let response = await stream.finalChatCompletion();

      // Ensure usage is captured - use SDK's totalUsage() as fallback
      if (!response.usage) {
        try {
          const totalUsage = await stream.totalUsage();
          response = { ...response, usage: totalUsage };
        } catch (_err) {
          // totalUsage() may fail if stream ended abnormally
        }
      }

      const finalReasoning = this.processThinkingBlock(response);
      thinking.finalize(finalReasoning ?? undefined);
      const finalOutput = response.choices?.[0]?.message?.content ?? '';
      if (output) output.finalize(finalOutput);
      return response;
    } else {
      return executeRequest(
        {
          model: this.config.name,
          operation: 'openrouter.chat.completions.create',
          signal,
        },
        () => client.chat.completions.create(kwargs, { signal }),
      );
    }
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
    const reasoning = message?.reasoning;
    if (!reasoning) {
      return null;
    }
    if (isNonEmptyString(reasoning)) {
      return reasoning;
    }

    return null;
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
