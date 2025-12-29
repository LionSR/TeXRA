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
import { normalizeOpenRouterStream } from './streaming';
import type { CreateResponseOptions } from './types/IModelHandler';
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';

/**
 * OpenRouter reasoning_details array item types.
 * Used for extracting reasoning from final response messages.
 */
interface ReasoningDetailItem {
  type: 'reasoning.text' | 'reasoning.summary' | 'reasoning.encrypted';
  text?: string;
  summary?: string;
}

/**
 * Extracts text content from OpenRouter reasoning_details array.
 * Used by extractReasoningFromMessage for final response processing.
 */
function extractTextFromReasoningDetails(details: unknown): string {
  if (!Array.isArray(details)) {
    if (typeof details === 'string') return details;
    return '';
  }

  const textParts: string[] = [];
  for (const item of details as ReasoningDetailItem[]) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'reasoning.text' && item.text) {
      textParts.push(item.text);
    } else if (item.type === 'reasoning.summary' && item.summary) {
      textParts.push(item.summary);
    }
  }
  return textParts.join('');
}

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
      kwargs.stream_options = { include_usage: true };
      const stream = await executeRequest(
        {
          model: this.config.name,
          operation: 'openrouter.chat.completions.stream',
          signal,
        },
        () => client.chat.completions.stream(kwargs, { signal }),
      );

      // Use unified streaming: normalize SDK events and consume with StreamConsumer
      const normalizedStream = normalizeOpenRouterStream(stream, {
        outputEnabled: this.isOutputStreamingEnabled(),
        progressViewEnabled: this.progressViewEnabled,
        provider: 'openrouter',
        startTime: Date.now(),
      });

      const result = await this.consumeNormalizedStream(normalizedStream);

      // Get the raw response for further processing
      const response = result.response.raw as ChatCompletion;

      // Ensure reasoning from normalizer is available in the raw response
      // for processThinkingBlock to find it when called with workspaceState
      // in the flow classes (ResponseCycleFlow, ToolUseCycleFlow)
      if (result.response.thinking && response.choices?.[0]?.message) {
        (response.choices[0].message as any).reasoning_content =
          result.response.thinking;
      }

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
